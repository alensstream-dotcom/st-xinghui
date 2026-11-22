import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import { backendStatus, decideSeed, generateImage } from '@/generate';
import { prepareImageForStorage } from '@/floor/storage';
import type { CharTagEntry } from '@/state/charTags';
import { newPortraitKey, savePortrait } from '@/state/portraits';

/**
 * 单人立绘生成。
 *
 * 与楼层出图完全分开:不读剧情、不带场景、不拼五层服装状态——立绘要的是
 * 「这个角色长什么样」的稳定封面,所以背景固定纯白、构图固定全身正面。
 * 立绘存 IndexedDB,只把键名交回去(条目里存 portraitKey)。
 */

/** 立绘 Base:简洁立绘构图,不混任何剧情背景。 */
const PORTRAIT_BASE =
  'solo, standing, full body, simple background, white background, front view, looking at viewer, slight smile';

/** 档案里没有固定着装时的默认日常装:不能裸,也不能抢戏。 */
const DEFAULT_OUTFIT = 'white shirt, short sleeves, jeans, sneakers';

const FIXED_FIELD_ORDER = ['fandom', 'sex', 'hair', 'eyes', 'skin', 'body', 'extra', 'outfit'] as const;

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

/** 立绘用的角色块:完整固定外貌 + 固定着装 + 固定微笑。 */
export function buildPortraitCharacterTag(entry: CharTagEntry): string {
  const tags: string[] = [];
  const fields = entry.fields ?? {};
  for (const field of FIXED_FIELD_ORDER) {
    if (field === 'sex') continue;
    tags.push(...splitTags(String(fields[field] ?? '')));
  }
  if (!splitTags(String(fields.outfit ?? '')).length) tags.push(...splitTags(DEFAULT_OUTFIT));
  if (!entry.raw?.trim() && !tags.length) tags.push(...splitTags(entry.raw ?? ''));
  const body = dedupe(tags.filter(tag => !/^\d+(?:girl|boy)s?$/i.test(tag)));
  return dedupe([`${sexWord(entry)}`, ...body, 'slight smile']).join(', ');
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
 * @throws 后端未配置 / 上游失败 / 图片转码失败时抛出,由调用方 toastr 报给用户。
 */
export async function generateCharacterPortrait(
  entry: CharTagEntry,
  signal?: AbortSignal,
): Promise<PortraitResult> {
  const name = String(entry.name ?? '').trim();
  if (!name) throw new Error('先填角色名再生成立绘');
  const status = backendStatus();
  if (!status.configured) throw new Error(status.reason || '出图后端未配置');

  const characterTag = buildPortraitCharacterTag(entry);
  const sex = sexWord(entry);
  // Base 的人数词必须与角色性别一致,否则 NAI 会把 1boy 画成女孩
  const prompt = dedupe([`1${sex}`, ...splitTags(PORTRAIT_BASE), ...(status.supportsCharacters ? [] : splitTags(characterTag))]).join(', ');
  const characters: ImageCharacterPrompt[] = status.supportsCharacters
    ? [{ name, tag: characterTag, nl: '' }]
    : [];
  const seed = decideSeed(status.backend);

  const output = await generateImage({ prompt, characters, size: 'portrait', seed }, signal);
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