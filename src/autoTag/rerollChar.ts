import { requestCompletion, requestViaMainApi, type ChatMsg } from '@/api/client';
import { getContext } from '@/st/context';
import { getTagGenChannel, settings } from '@/state/settings';
import type { CharTagEntry, CharTagField } from '@/state/charTags';
import { readBookMemory } from './bookMemory';
import { cleanHistoryText } from './clean';

/** 重Roll 只覆盖这五个固定外貌字段;sex/outfit/fandom/raw/nl 不在其中。 */
export const REROLL_FIELDS = ['hair', 'eyes', 'skin', 'body', 'extra'] as const;

export type RerolledField = (typeof REROLL_FIELDS)[number];

export type RerolledAppearance = Record<RerolledField, string>;

export interface RerollRequest {
  /** 角色名,必须与正文/档案逐字一致。 */
  name: string;
  /** 当前(用户不满意的)档案;可为空(只按正文与偏好重写)。 */
  currentEntry: CharTagEntry | null;
  /** 本聊天其他角色,用于拉开辨识度。 */
  otherEntries: CharTagEntry[];
  /** 用户偏好(可选),例如「微黑皮短发运动系」。 */
  userHint?: string;
  signal?: AbortSignal;
}

/** 单段正文最多带多少字,整份提示最多带多少字——重Roll 只做外貌决策,读太多没收益。 */
const EXCERPT_FIRST = 1200;
const EXCERPT_RECENT = 700;
const EXCERPT_TOTAL = 2600;

const FIELD_LABELS: Record<RerolledField, string> = {
  hair: 'hair(标准 Danbooru 原子词,发色必填+长度直卷+扎发+刘海)',
  eyes: 'eyes(瞳色+tsurime/tareme/jitome/sanpaku)',
  skin: 'skin(fair skin / pale skin / tan)',
  body: 'body(身高+体型+胸型,例 petite, slender, small breasts)',
  extra: 'extra(1～2 项标志特征: mole under eye / freckles / fang / ahoge / choker / hair ribbon / hairclip / earrings …)',
};

const REROLL_SYSTEM_PROMPT = `你是角色外貌设计师。你要为指定角色重新设计一套「固定外貌」,只输出一个 JSON 对象,不要 Markdown 代码块,不要解释:
{"hair":"...","eyes":"...","skin":"...","body":"...","extra":"..."}

硬约束(违反任意一条即作废):
1. 必须严格遵守正文与设定里已经写死的外貌、年龄段、身份、性格、世界观,不得违背任何一处原描写;正文写死的维度一个字都不许改。
2. 必须与同一聊天里的其他角色明显拉开辨识度:发色发型剪影 / 眼型 / 肤色与体型原型 / extra 标志特征 四项中至少错开 3 项,严禁撞款。
3. 必须与「旧外貌」在正文没有写死的维度上给出明显不同的新方案(真正的重设计,不是微调同义词)。
4. hair 写标准 Danbooru 原子词,逗号分隔,一个词只管一件事:发色(black hair / brown hair / blonde hair / red hair / silver hair,必填)+ 长度(short hair / medium hair / long hair / very long hair)+ 直卷(straight hair / wavy hair / curly hair)+ 扎发(hair down / high ponytail / twin braids / side ponytail / low bun)+ 刘海(blunt bangs / parted bangs / side-swept bangs)。禁止 "medium chestnut brown hair" 这类长短语。
5. eyes 必须瞳色 + 标准眼型,例如 "amber eyes, tsurime";skin 用 fair skin / pale skin / tan;body 写身高、体型与胸型。
6. extra 必须是常驻标志特征 1～2 项(眼镜、首饰、发饰、痣、雀斑、虎牙、呆毛),不要写只属于某套衣服的配饰。
7. 原型适配:运动体育系可 "tan, athletic, toned"+ 短发或高马尾;娇小可爱系可 "petite, slender, small breasts"+ tareme + bob/twintails/ahoge;成熟御姐/人妻系用 "mature female, tall, curvy"+ 大波浪/低马尾/盘发 + 成熟配饰,严禁给成熟角色套 petite / loli / twintails。
8. 现代写实世界观只用现实发色,不写额纹/异色瞳/尖耳;二次元、奇幻、游戏世界观才可用 white hair / silver hair / dark blue hair / multicolored hair / forehead mark / heterochromia / pointy ears。
9. 用户偏好(hint)在不违背硬设定的前提下优先满足。
10. 五个字段都不许为空;只输出 JSON。`;

function clamp(text: string, limit: number): string {
  const value = String(text ?? '').trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** 从当前聊天里收集与这个角色相关的正文:优先首次出场 + 最近两楼。 */
function collectExcerpts(name: string): string {
  const chat = getContext()?.chat ?? [];
  const stripTags = settings.excludes?.customStripTags ?? [];
  const hits: string[] = [];
  chat.forEach(message => {
    if (message.is_user || message.is_system) return;
    const text = cleanHistoryText(String(message.mes ?? ''), stripTags);
    if (text.includes(name)) hits.push(text);
  });
  if (!hits.length) return '';
  const picked: string[] = [];
  const first = hits[0];
  if (first) picked.push(`【首次出场】\n${clamp(first, EXCERPT_FIRST)}`);
  for (const text of hits.slice(-2)) {
    if (text === first) continue;
    picked.push(`【近期出场】\n${clamp(text, EXCERPT_RECENT)}`);
  }
  return clamp(picked.join('\n\n'), EXCERPT_TOTAL);
}

function describeEntry(label: string, entry: CharTagEntry | null): string {
  if (!entry) return `${label}:（无档案）`;
  const fields = entry.fields ?? {};
  const lines: string[] = [];
  for (const field of ['hair', 'eyes', 'skin', 'body', 'extra'] as CharTagField[]) {
    const value = String(fields[field] ?? '').trim();
    if (value) lines.push(`${field}: ${value}`);
  }
  const raw = entry.raw?.trim();
  if (raw) lines.push(`整串: ${clamp(raw, 240)}`);
  return `${label}: ${entry.name}\n${lines.length ? lines.join('\n') : '（五个字段都空）'}`;
}

function buildRerollMessages(request: RerollRequest, excerpts: string): ChatMsg[] {
  const { name, currentEntry, otherEntries, userHint } = request;
  const memory = (() => {
    try {
      const context = getContext();
      const chat = context?.chat ?? [];
      const lastAi = [...chat].reverse().find(message => !message.is_user && !message.is_system);
      const memoryText = context ? readBookMemory(chat.length ? chat.length - 1 : 0, String(lastAi?.mes ?? ''), context.name1 || '主角') : null;
      return memoryText?.text?.trim() ?? '';
    } catch {
      return '';
    }
  })();

  const others = otherEntries
    .filter(entry => entry.name !== name)
    .slice(0, 6)
    .map(entry => describeEntry('其他角色', entry))
    .join('\n\n');

  const body = [
    `【目标角色】${name}`,
    describeEntry('【旧外貌（用户不满意,需要在未写死的维度上明显改掉）】', currentEntry),
    others ? `【同聊天其他角色（必须错开 3 项）】\n${others}` : '',
    memory ? `【星绘书角色参考】\n${clamp(memory, 1200)}` : '',
    excerpts ? `【正文相关片段】\n${excerpts}` : '【正文相关片段】\n（本聊天暂未检索到该角色正文,只按旧外貌与偏好重设计）',
    userHint?.trim() ? `【用户偏好】${userHint.trim()}` : '',
    `【输出字段】\n${REROLL_FIELDS.map(field => FIELD_LABELS[field]).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  return [
    { role: 'system', content: REROLL_SYSTEM_PROMPT },
    { role: 'user', content: body },
  ];
}

/** 从模型输出里抠出第一个 JSON 对象(容忍代码块与前后废话)。 */
function extractJsonObject(raw: string): Record<string, unknown> {
  const text = String(raw ?? '')
    .replace(/<think(?:ing)?[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/```(?:json)?/gi, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON 对象');
  const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('模型返回的不是 JSON 对象');
  return parsed as Record<string, unknown>;
}

function sanitizeAppearance(parsed: Record<string, unknown>): RerolledAppearance {
  const result = {} as RerolledAppearance;
  for (const field of REROLL_FIELDS) {
    const value = parsed[field];
    const text = typeof value === 'string' ? value.trim().replace(/[<>]/g, '') : Array.isArray(value) ? value.join(', ').trim() : '';
    if (!text) throw new Error(`模型漏写了 ${field}`);
    result[field] = clamp(text, 240);
  }
  if (!/hair/i.test(result.hair)) throw new Error('hair 里没有 hair 原子词');
  return result;
}

/** 解析模型输出成五个字段(容错:剥 thinking 段与代码块、取第一个 JSON 对象)。 */
export function parseRerolledAppearance(raw: string): RerolledAppearance {
  return sanitizeAppearance(extractJsonObject(raw));
}

/**
 * 重Roll一个角色的固定外貌。
 *
 * 只做「生成 → 解析 → 返回」:不写库、不落盘。调用方(角色编辑弹窗)把结果填进表单,
 * 用户预览微调后点「保存」才真正覆盖角色库——这样连续重Roll不会污染档案。
 */
export async function rerollCharacterAppearance(request: RerollRequest): Promise<RerolledAppearance> {
  const name = request.name?.trim();
  if (!name) throw new Error('先填角色名再重Roll');
  const excerpts = collectExcerpts(name);
  const messages = buildRerollMessages({ ...request, name }, excerpts);
  const channel = getTagGenChannel();
  const opts = { signal: request.signal, source: '重Roll形象' };
  const raw = channel ? await requestCompletion(channel, messages, opts) : await requestViaMainApi(messages, opts);
  return parseRerolledAppearance(raw);
}