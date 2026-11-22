import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import { backendStatus, decideSeed, generateImage } from '@/generate';
import { prepareImageForStorage } from '@/floor/storage';
import type { CharTagEntry } from '@/state/charTags';
import { newPortraitKey, savePortrait } from '@/state/portraits';
import {
  defaultWorldAnchor,
  portraitAttireFor,
  readWorldAnchor,
  type WorldAnchorConfig,
} from '@/state/worldAnchor';

/**
 * 单人立绘生成。
 *
 * 与楼层出图完全分开:不读剧情、不带场景、不拼五层服装状态——立绘要的是
 * 「这个角色长什么样」的稳定封面,所以背景固定纯白,构图固定正脸平视半身。
 * 服装不抄剧情实时穿搭,只保证时代画风与当前聊天世界观一致(古风不穿牛仔裤)。
 * 立绘存 IndexedDB,只把键名交回去(条目里存 portraitKey)。
 */

/**
 * 立绘 Base:半身正面平视,压掉一切会诱发鱼眼/俯角畸变的机位。
 * 早期用 full body 配全身构图,NAI 常把人物拉远成小头大身、手脚比例失控。
 */
const PORTRAIT_BASE =
  'solo, standing, cowboy shot, simple background, white background, straight-on, eye-level, front view, looking at viewer, slight smile';

/** 立绘专属防畸变负面(俯角/仰角/鱼眼/广角透视全压掉)。 */
const PORTRAIT_GUARDRAILS =
  'from above, high angle, low angle, fisheye, foreshortening, dutch angle, extreme perspective, wide angle distortion';

/** 半身构图里只会诱发畸变或把镜头强行拉远的纯下身身材词。 */
const LEG_ONLY = /^(?:long legs?|short legs?|slender legs?|thick thighs?|bare legs?|shapely legs?|wide hips?|thighs?)$/i;

const FIXED_FIELD_ORDER = ['fandom', 'sex', 'hair', 'eyes', 'skin', 'body', 'extra'] as const;

export interface PortraitResult {
  /** IndexedDB 键,写进条目的 portraitKey。 */
  key: string;
  /** data URL,可直接给 <img src> 预览。 */
  dataUrl: string;
  seed: number;
}

function splitTags(raw: string): string[] {
  return String(raw ?? '')
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean);
}

function dedupe(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const key = tag.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** 头像词:NAI 的 char caption 里 1girl/1boy 要写成 girl/boy。 */
function sexWord(entry: CharTagEntry): 'girl' | 'boy' {
  const sex = String(entry.fields?.sex ?? '').toLowerCase();
  const raw = String(entry.raw ?? '').toLowerCase();
  return /\b(?:1boy|boy|male)\b/.test(sex) || /\b(?:1boy|boy|male)\b/.test(raw) ? 'boy' : 'girl';
}

/**
 * 立绘用的角色块:完整固定外貌 + 世界观素服 + 固定微笑。
 * 纯下身身材词在半身构图里会被画成畸变,这里直接过滤掉。
 */
export function buildPortraitCharacterTag(entry: CharTagEntry, world?: WorldAnchorConfig): string {
  const config = world ?? (safeWorldAnchor() || defaultWorldAnchor());
  const tags: string[] = [];
  const fields = entry.fields ?? {};
  for (const field of FIXED_FIELD_ORDER) {
    for (const tag of splitTags(String(fields[field] ?? ''))) {
      if (LEG_ONLY.test(tag)) continue;
      tags.push(tag);
    }
  }
  tags.push(...splitTags(portraitAttireFor(config, fields.outfit)));
  if (!tags.length) tags.push(...splitTags(entry.raw ?? ''));
  const body = dedupe(tags.filter(tag => !/^\d+(?:girl|boy)s?$/i.test(tag)));
  return dedupe([`${sexWord(entry)}`, ...body, 'slight smile']).join(', ');
}

/** 读世界观失败(测试环境无 getContext)时回落到现代预设。 */
function safeWorldAnchor(): WorldAnchorConfig | null {
  try {
    return readWorldAnchor();
  } catch {
    return null;
  }
}

/** 把 ComfyImageResult 转成 data URL(base64),失败时抛错。 */
async function toDataUrl(result: { url: string; format: string }): Promise<string> {
  const { base64, format } = await prepareImageForStorage(result as never);
  const mime = format === 'jpeg' || format === 'jpg' ? 'image/jpeg' : `image/${format || 'png'}`;
  return `data:${mime};base64,${base64}`;
}

/**
 * 用当前出图后端生成一张单人立绘,并存进本地缓存。
 *
 * @param world 当前聊天世界观锚点(不传则现读;决定素服与防穿帮负面)
 * @throws 后端未配置 / 上游失败 / 图片转码失败时抛出,由调用方 toastr 报给用户。
 */
export async function generateCharacterPortrait(
  entry: CharTagEntry,
  signal?: AbortSignal,
  world?: WorldAnchorConfig,
): Promise<PortraitResult> {
  const name = String(entry.name ?? '').trim();
  if (!name) throw new Error('先填角色名再生成立绘');
  const status = backendStatus();
  if (!status.configured) throw new Error(status.reason || '出图后端未配置');

  const config = world ?? safeWorldAnchor() ?? defaultWorldAnchor();
  const characterTag = buildPortraitCharacterTag(entry, config);
  const sex = sexWord(entry);
  const guardrails = [PORTRAIT_GUARDRAILS, config.negativeGuardrails.trim()].filter(Boolean).join(', ');
  // Base 的人数词必须与角色性别一致,否则 NAI 会把 1boy 画成女孩
  const prompt = dedupe([
    `1${sex}`,
    ...splitTags(PORTRAIT_BASE),
    ...(status.supportsCharacters ? [] : splitTags(characterTag)),
  ]).join(', ');
  // 角色级负面(uc)在 NAI 4.5 只作用于该角色的 caption,比全局负面更精准;
  // 不支持 char caption 的后端靠 extraNegative 兜底。
  const characters: ImageCharacterPrompt[] = status.supportsCharacters
    ? [{ name, tag: characterTag, nl: '', uc: guardrails }]
    : [];
  const seed = decideSeed(status.backend);

  const output = await generateImage(
    { prompt, characters, size: 'portrait', seed, extraNegative: guardrails },
    signal,
  );
  let dataUrl: string;
  try {
    dataUrl = await toDataUrl(output.result);
  } finally {
    try {
      output.result.revoke?.();
    } catch {
      /* 释放失败不影响结果 */
    }
  }

  const key = newPortraitKey(name);
  await savePortrait(key, { dataUrl, createdAt: Date.now(), seed: output.seed });
  return { key, dataUrl, seed: output.seed };
}