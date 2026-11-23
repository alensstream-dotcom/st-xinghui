import { hasNaiFemaleSubject, isNaiMaleAppearance } from '@/autoTag/naiStory';
import { validateComicLayout, type ComicLayout } from '@/backends/mossLayout';
import { normalizeOrientation, type Orientation } from '@/backends/size';
import type { TargetSegment } from '@/autoTag/clean';
import { FORBIDDEN_SUBTAG, serializeImageTag } from '@/st/imageTagRegex';
import {
  CHAR_TAG_FIELDS,
  type CharTagField,
  type CharTagHistoryField,
} from '@/state/charTags';
import type { CharOutfitSnapshot } from '@/state/outfitState';

export interface ImageCharacterPrompt {
  name: string;
  tag: string;
  nl: string;
  /**
   * 该角色的负面提示词(NovelAI 的 char_caption 级 uc)。
   *
   * 只承载「这一格不该出现的这件衣服」这类局部否定——例如她已经脱掉的胸罩、
   * 别人身上的外套。放全局 negative 会连别人一起否掉，所以必须挂在角色上。
   * 空串表示不写(序列化时整段省略)。
   */
  uc?: string;
  /**
   * 这一格刻意不写的固定外貌字段(hair/eyes/skin/body/extra)。
   * 局部特写(只拍手、只拍下体)时用得上：脸不在画面里，写发色瞳色只会让模型硬塞一张脸。
   */
  omitFeatures?: string[];
  /**
   * 导演给出的「本帧该角色实际可见的穿着指纹」（结楼穿搭指纹体系）。
   * 编译器把它排在固定外貌之后、动作表情之前，并按景别过滤鞋袜与下身。
   */
  outfit?: string;
  /** 本帧已明确脱掉的衣物类目（["bra"] / ["outer","panties"]），由编译器转成角色 uc。 */
  removed?: string[];
}

export interface ImageInsertion {
  /** 模型选择的目标正文位置 ID。 */
  position: string;
  /** 位置 ID 对应的原始物理行(0-based，仅插件内部使用)。 */
  sourceLine: number;
  /** danbooru 短 tag 部分(必填)。 */
  tag: string;
  /** 自然语言部分(可空;ComfyUI「生成自然语言」开启时由模型一并输出)。 */
  nl: string;
  /** 本画面动态负面 tag(可空;仅在 ComfyUI 工作流使用 %negative_prompt% 时要求模型输出)。 */
  negative: string;
  characters: ImageCharacterPrompt[];
  /** 画幅方向:模型只判横/竖,具体像素由用户在后端面板配置。漏给/乱给一律降级竖屏。 */
  size: Orientation;
  /** tag 类型(插件按当前方案定,不是 AI 选的);缺省插画,序列化时也不写。 */
  kind?: 'comic';
  /** 漫画一页的分镜(kind 为 comic 时);tag/nl/negative/characters 此时恒空。 */
  layout?: ComicLayout;
}

export interface ImagePlan {
  images: ImageInsertion[];
  /** AI 报告的角色库变更(建档/字段更新);调用方负责落库。 */
  changes: CharChange[];
}

/** AI 输出的单条角色变更(宽松形状;解析后字段全部合法才保留)。 */
export interface CharChange {
  name: string;
  /** 'new' = 建档;其余为字段名/整串/自然语言。 */
  field: CharTagHistoryField;
  value: string;
  /** 自然语言外貌句(new 建档时可附带)。 */
  nl?: string;
  reason: string;
  /**
   * 永久变化开始生效的位置。建档(new)不受此约束——角色的固定外貌是本楼全程
   * 成立的事实,不是「从某处开始」的变化,这里只作记录与排序用。
   */
  position: string;
  /** position 对应的原始物理行(0-based,仅插件内部使用)。 */
  sourceLine: number;
}

const HISTORY_FIELDS: ReadonlySet<string> = new Set([
  'fandom',
  'sex',
  'hair',
  'eyes',
  'skin',
  'body',
  'extra',
  'outfit',
  'new',
  'raw',
  'nl',
]);

interface SourceLine {
  text: string;
  eol: string;
}

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const newline = /\r\n|\n|\r/g;
  let start = 0;
  for (let match = newline.exec(source); match; match = newline.exec(source)) {
    lines.push({ text: source.slice(start, match.index), eol: match[0] });
    start = match.index + match[0].length;
  }
  lines.push({ text: source.slice(start), eol: '' });
  return lines;
}

function jsonObjects(raw: string): string[] {
  const cleaned = raw.replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
  const candidates: string[] = [];
  for (const match of cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1].trim());
  candidates.push(cleaned);

  for (let start = 0; start < cleaned.length; start += 1) {
    if (cleaned[start] !== '{') continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < cleaned.length; index += 1) {
      const char = cleaned[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{') depth += 1;
      else if (char === '}' && --depth === 0) {
        candidates.push(cleaned.slice(start, index + 1));
        break;
      }
    }
  }
  return candidates;
}

function parseObjectCandidates(raw: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const candidate of jsonObjects(raw)) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        out.push(value as Record<string, unknown>);
      }
    } catch {
      // 尝试下一个候选 JSON 块。
    }
  }
  return out;
}

function parseObject(raw: string): Record<string, unknown> {
  const [first] = parseObjectCandidates(raw);
  if (!first) throw new Error('AI 没有返回可解析的 JSON 对象');
  return first;
}

/**
 * 把候选对象归一成「带 images 数组」的计划对象。
 *
 * 模型偶尔先吐一个无关的 `{}`，或把数组叫 shots，或只写一张图的字段。以前取第一个
 * 可解析对象就判缺 images 直接失败，等于把可救的输出丢掉。
 */
function imagePlanObject(candidate: Record<string, unknown>): Record<string, unknown> | null {
  if (Array.isArray(candidate.images)) return candidate;
  if (Array.isArray(candidate.shots)) return { ...candidate, images: candidate.shots };
  if (typeof candidate.position === 'string' && typeof candidate.tag === 'string') {
    return { ...candidate, images: [candidate] };
  }
  return null;
}

/** tag / nl / negative 内容里不允许出现的子标签字面量（口径见 st/imageTagRegex.ts）。 */

function sanitizeContent(value: unknown, field: string, index: number): string {
  const text = typeof value === 'string' ? value.trim().replace(/[\r\n]+/g, ' ') : '';
  if (text && FORBIDDEN_SUBTAG.test(text)) {
    throw new Error(`images[${index}].${field} 不得包含 bbi_image/tag/nl/negative/size 标签`);
  }
  return text;
}

function sanitizeCharacters(value: unknown, imageIndex: number): ImageCharacterPrompt[] {
  if (!Array.isArray(value)) return [];
  const characters: ImageCharacterPrompt[] = [];
  for (let index = 0; index < value.length && characters.length < 32; index += 1) {
    const raw = value[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    try {
      const name = sanitizeContent(item.name, `characters[${index}].name`, imageIndex);
      const tag = sanitizeContent(item.tag ?? item.prompt, `characters[${index}].tag`, imageIndex);
      const nl = sanitizeContent(item.nl, `characters[${index}].nl`, imageIndex);
      const uc = sanitizeOptionalContent(item.uc, `characters[${index}].uc`, imageIndex);
      const omitFeatures = sanitizeOmitFeatures(item.omitFeatures);
      const outfit = sanitizeOptionalContent(item.outfit, `characters[${index}].outfit`, imageIndex);
      const removed = sanitizeRemovedList(item.removed);
      if (name && tag) {
        characters.push({
          name,
          tag,
          nl,
          ...(uc ? { uc } : {}),
          ...(omitFeatures.length ? { omitFeatures } : {}),
          ...(outfit ? { outfit } : {}),
          ...(removed.length ? { removed } : {}),
        });
      }
    } catch {
      // A malformed character prompt must not discard an otherwise valid image plan.
    }
  }
  return characters;
}

/** 可空字段：非字符串/空白一律当没写，绝不因为可选字段抛错。 */
function sanitizeOptionalContent(value: unknown, field: string, imageIndex: number): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    return sanitizeContent(value, field, imageIndex);
  } catch {
    return '';
  }
}

const OMITTABLE_FEATURES = new Set(['hair', 'eyes', 'skin', 'body', 'extra']);

function sanitizeOmitFeatures(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const key = item.trim().toLowerCase();
    if (!OMITTABLE_FEATURES.has(key) || out.includes(key)) continue;
    out.push(key);
  }
  return out;
}

/** 已脱衣物类目：小写、去重、限长；不认识的词原样保留（编译器按词根判断）。 */
function sanitizeRemovedList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const key = item.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!key || key.length > 24 || out.includes(key)) continue;
    out.push(key);
    if (out.length >= 8) break;
  }
  return out;
}

function sanitizePosition(value: unknown, index: number): string {
  const position = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!position) throw new Error(`images[${index}].position 不能为空`);
  if (!/^P\d+$/.test(position)) throw new Error(`images[${index}].position 必须是目标正文中的 P编号`);
  return position;
}

/**
 * 解析并严格校验模型给出的“目标位置 ID + 提示词”列表。tag 必填;nl/negative 选填。
 * size 一律容忍:归一不出就当竖屏——为它抛错会白白吃掉 runner 的重试次数。
 * 图片超过上限时本地硬截断;少于用户明确设置的下限则抛错,交给 runner 重试。
 * changes 全程宽容:单条坏就丢弃,绝不连累 images——角色档案漏一条只是这个角色本轮
 * 没锚定,为它作废整次输出会连图一起没有,那是更坏的结果。
 */
export function parseImagePlan(
  raw: string,
  segments: TargetSegment[],
  minImages: number,
  maxImages: number,
  rules: { femaleScenesOnly?: boolean; knownMaleProfiles?: ReadonlySet<string> } = {},
): ImagePlan {
  const parsed =
    parseObjectCandidates(raw)
      .map(candidate => imagePlanObject(candidate))
      .find((candidate): candidate is Record<string, unknown> => candidate !== null) ?? null;
  if (!parsed) throw new Error('AI 返回的 JSON 缺少 images 数组');
  const rawImages = Array.isArray(parsed.images) ? parsed.images : [];
  const normalizedMax = Math.max(1, Math.floor(Number(maxImages)) || 1);
  const normalizedMin = Math.min(
    normalizedMax,
    Math.max(0, Math.floor(Number(minImages)) || 0),
  );
  const positions = new Map(segments.map(segment => [segment.id, segment.sourceLine]));

  const images: ImageInsertion[] = [];
  for (let index = 0; index < rawImages.length; index += 1) {
    const item = rawImages[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`images[${index}] 必须是对象`);
    }
    const entry = item as Record<string, unknown>;
    const position = sanitizePosition(entry.position ?? entry.id, index);
    const sourceLine = positions.get(position);
    if (sourceLine === undefined) {
      throw new Error(`images[${index}].position=${position} 不在目标正文可选位置中`);
    }
    // 兼容模型按旧协议/习惯返回 prompt 键的情况
    const tag = sanitizeContent(entry.tag ?? entry.prompt, 'tag', index);
    if (!tag) throw new Error(`images[${index}].tag 不能为空`);
    const nl = sanitizeContent(entry.nl, 'nl', index);
    const negative = sanitizeContent(entry.negative ?? entry.negative_prompt, 'negative', index);
    const characters = sanitizeCharacters(entry.characters, index);
    // 兼容模型按习惯返回 orientation / aspect 键
    const size = normalizeOrientation(entry.size ?? entry.orientation ?? entry.aspect);
    if (rules.femaleScenesOnly && !hasNaiFemaleSubject(tag, characters)) continue;
    images.push({ position, sourceLine, tag, nl, negative, characters, size });
  }

  const limitedImages = images.slice(0, normalizedMax);
  const noEligibleScene = rules.femaleScenesOnly && limitedImages.length === 0;
  if (!noEligibleScene && limitedImages.length < normalizedMin) {
    throw new Error(
      `AI 返回了 ${limitedImages.length} 张图片，少于设置的最少图片数 ${normalizedMin}`,
    );
  }

  return {
    images: limitedImages,
    changes: parseChanges(parsed.changes, positions, rules.knownMaleProfiles),
  };
}

/**
 * 漫画任务的输出:`{"pages":[{position,size,summary,items}],"changes":[…]}`。
 *
 * 整楼精选改编成几页,**页数与每页格数都不设硬上限**(用户明确不要写死;篇幅靠协议里的
 * 「通常 1～2 页」参考量引导,见 prompt.ts 漫画协议);
 * 只要求至少一页——零页等于这次分析白跑,交给 runner 重试。任一页分镜不合法即整体抛错
 * 重试:漫画是连续叙事,悄悄丢掉中间一页比重来一次更糟。
 * 页按正文位置稳定排序:AI 偶尔把页序写乱,插回正文时仍要跟着剧情走。
 */
export function parseComicPlan(raw: string, segments: TargetSegment[]): ImagePlan {
  const parsed = parseObject(raw);
  const pages = Array.isArray(parsed.pages) ? parsed.pages : parsed.images;
  if (!Array.isArray(pages)) throw new Error('AI 返回的 JSON 缺少 pages 数组');
  if (!pages.length) throw new Error('AI 没有画任何一页漫画');
  const positions = new Map(segments.map(segment => [segment.id, segment.sourceLine]));

  const images: ImageInsertion[] = pages.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`pages[${index}] 必须是对象`);
    }
    const entry = item as Record<string, unknown>;
    const position = sanitizePosition(entry.position ?? entry.id, index);
    const sourceLine = positions.get(position);
    if (sourceLine === undefined) {
      throw new Error(`pages[${index}].position=${position} 不在目标正文可选位置中`);
    }
    const layout = validateComicLayout(entry, `pages[${index}]`);
    const size = normalizeOrientation(entry.size ?? entry.orientation ?? entry.aspect);
    return { position, sourceLine, tag: '', nl: '', negative: '', characters: [], size, kind: 'comic', layout };
  });
  images.sort((left, right) => left.sourceLine - right.sourceLine);

  return { images, changes: parseChanges(parsed.changes, positions) };
}

/**
 * 解析变化生效位置。建档(new)缺位置不是错——它本就全楼生效;
 * 解析不出时回落到首个位置,只用于排序。
 */
function parsePosition(
  value: unknown,
  positions: Map<string, number>,
): { position: string; sourceLine: number } | null {
  const position = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^P\d+$/.test(position)) return null;
  const sourceLine = positions.get(position);
  if (sourceLine === undefined) return null;
  return { position, sourceLine };
}

function firstPosition(positions: Map<string, number>): { position: string; sourceLine: number } {
  for (const [position, sourceLine] of positions) return { position, sourceLine };
  return { position: '', sourceLine: 0 };
}

/** 建档字段:hair 与 eyes 是二次元身份锚点,缺任一条则该条建档不可用(调用方丢弃)。 */
const NEW_RECORD_META = new Set(['name', 'field', 'position', 'at', 'value', 'nl', 'reason', 'fields']);

/** 顶层直接写外貌的建档记录(没有 fields 包裹)只取字段键。 */
function newFieldSourceFromRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!NEW_RECORD_META.has(key)) out[key] = value;
  }
  return out;
}

function parseNewFields(raw: Record<string, unknown>, skipMale: boolean): string | null {
  const fields: Partial<Record<CharTagField, string>> = {};
  for (const field of CHAR_TAG_FIELDS) {
    const value = raw[field];
    const text = typeof value === 'string' ? value.trim().replace(/[\r\n]+/g, ' ') : '';
    if (text) fields[field] = text;
  }
  // 模型常漏写 sex：女性建档默认补 1girl。否则 isNaiMaleAppearance('') 之外还会被
  // 「缺 sex 就不是女性」的判据整条丢掉，表现成「角色库里一个新角色都没有、外貌全丢」。
  if (!fields.sex) fields.sex = '1girl';
  if (skipMale && isNaiMaleAppearance(fields.sex)) return null;
  // 只要有一项能画出来的东西就入库：发/瞳/体型/常驻物/同人身份任意一项非空。
  // 缺 eyes 之类的次要字段不再静默丢弃整条新角色——后面的楼层还能补。
  const appearanceFields: CharTagField[] = ['fandom', 'hair', 'eyes', 'body', 'extra'];
  const hasAppearance = appearanceFields.some(field => (fields[field] ?? '').trim() !== '');
  if (!hasAppearance) return null;
  return JSON.stringify(fields);
}

function parseChanges(
  raw: unknown,
  positions: Map<string, number>,
  knownMaleProfiles?: ReadonlySet<string>,
): CharChange[] {
  if (!Array.isArray(raw)) return [];
  const out: CharChange[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    const fieldRaw = typeof o.field === 'string' ? o.field.trim() : '';
    if (!name || !HISTORY_FIELDS.has(fieldRaw) || knownMaleProfiles?.has(name)) continue;
    const field = fieldRaw as CharTagHistoryField;
    const parsedPosition = parsePosition(o.position ?? o.at, positions);
    // 建档全楼生效,位置只作记录,缺失就回落首位;永久变化必须知道从哪生效,位置坏 = 丢弃
    if (!parsedPosition && field !== 'new') continue;
    const { position, sourceLine } = parsedPosition ?? firstPosition(positions);
    let value = typeof o.value === 'string' ? o.value.trim() : '';
    const fields =
      o.fields && typeof o.fields === 'object' && !Array.isArray(o.fields)
        ? (o.fields as Record<string, unknown>)
        : null;
    if (field === 'new') {
      // 兜底:模型偶尔把外貌字段直接摊在顶层(漏掉 fields 包裹),那种写法不该整条丢掉,
      // 把记录本身当字段表用,元信息键排除掉即可。
      const fieldSource = fields ?? newFieldSourceFromRecord(o);
      const parsedFields = parseNewFields(fieldSource, !!knownMaleProfiles);
      if (!parsedFields) continue;
      value = parsedFields;
    }
    const nl = typeof o.nl === 'string' ? o.nl.trim() : '';
    const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
    if (!value && !nl) continue;
    out.push({ name, field, value, nl: nl || undefined, reason, position, sourceLine });
  }
  return out;
}

/** 保持原文及原换行符不变，只在模型选择的位置 ID 对应源码行之后插入 tag。 */
export function injectImageTags(source: string, images: ImageInsertion[]): string {
  if (!images.length) return source;
  const lines = sourceLines(source);
  const byLine = new Map<number, ImageInsertion[]>();
  for (const image of images) {
    if (!Number.isInteger(image.sourceLine) || image.sourceLine < 0 || image.sourceLine >= lines.length) {
      throw new Error(`位置 ${image.position} 对应的原始物理行已失效`);
    }
    const line = image.sourceLine;
    const list = byLine.get(line) ?? [];
    list.push(image);
    byLine.set(line, list);
  }

  const fallbackEol = lines.find(line => line.eol)?.eol || '\n';
  let output = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    output += line.text;
    const inserted = byLine.get(index) ?? [];
    const insertedEol = line.eol || fallbackEol;
    // 序列化口径见 st/imageTagRegex.ts 的 serializeImageTag（与手动编辑弹窗共用同一份，
    // 两处漂移会让「解析出的字段」与「落进正文的原文」对不上，而 promptHash 吃的是原文）。
    for (const image of inserted) {
      output += `${insertedEol}${serializeImageTag(image)}`;
    }
    output += line.eol;
  }
  return output;
}

/* 结楼穿搭指纹的解析(服装账本 v2)：任务 A 只记「本楼结束时各女角的最终穿搭」，
 * 楼内 P1/P2/P15 的穿脱由导演通道在当帧给出，这里不再拆微操作、不再推断、不再补词。 */

export interface StateSyncPlan {
  changes: CharChange[];
  finalOutfits: CharOutfitSnapshot[];
  /** 首楼 AI 识别的世界观预设;合法才带,用户锁定后由调用方决定是否采纳。 */
  worldPreset?: string;
}

/** 表格里的文本字段：去空白、禁子标签、限长；非字符串一律当没写，不抛错。 */
function outfitText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text || FORBIDDEN_SUBTAG.test(text)) return '';
  return text.length > 300 ? text.slice(0, 300) : text;
}

function parseFinalOutfits(rawOutfits: unknown): CharOutfitSnapshot[] {
  if (!Array.isArray(rawOutfits)) return [];
  const result: CharOutfitSnapshot[] = [];
  const seen = new Set<string>();
  for (const item of rawOutfits) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const name = outfitText(obj.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const wearing = outfitText(obj.wearing);
    const stateNote = outfitText(obj.stateNote);
    const removed = sanitizeRemovedList(obj.removed);
    result.push({
      name,
      wearing,
      ...(removed.length ? { removed } : {}),
      ...(stateNote ? { stateNote } : {}),
    });
  }
  return result;
}

/**
 * 解析任务 A(状态填表通道)返回的 JSON：{ "changes": [...], "finalOutfits": [...], "worldPreset": "..." }。
 * 容错设计：单条变更或单份穿搭不合法只丢该条，不阻塞主生图；整份解析不了就退化成
 * 「这一楼什么都没填」，由导演通道照常出图。
 */
export function parseStateSyncPlan(
  raw: string,
  segments: TargetSegment[],
  rules: { knownMaleProfiles?: ReadonlySet<string> } = {},
): StateSyncPlan {
  const positions = new Map<string, number>();
  for (const seg of segments) positions.set(seg.id.toUpperCase(), seg.sourceLine);

  let parsed: Record<string, unknown>;
  try {
    parsed = parseObject(raw);
  } catch {
    return { changes: [], finalOutfits: [] };
  }

  const changes = parseChanges(parsed.changes, positions, rules.knownMaleProfiles);
  const finalOutfits = parseFinalOutfits(parsed.finalOutfits ?? parsed.outfits);
  const worldPreset = typeof parsed.worldPreset === 'string' ? parsed.worldPreset.trim() : '';
  return { changes, finalOutfits, ...(worldPreset ? { worldPreset } : {}) };
}
