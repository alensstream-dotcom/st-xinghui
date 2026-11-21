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
import {
  OUTFIT_LAYER_KEYS,
  type OutfitLayerKey,
  type OutfitLayerState,
  type OutfitLayerStatus,
  type RawOutfitOp,
  type StoredOutfitOp,
} from '@/state/outfitState';

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

function parseObject(raw: string): Record<string, unknown> {
  for (const candidate of jsonObjects(raw)) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // 尝试下一个候选 JSON 块。
    }
  }
  throw new Error('AI 没有返回可解析的 JSON 对象');
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
      if (name && tag) {
        characters.push({
          name,
          tag,
          nl,
          ...(uc ? { uc } : {}),
          ...(omitFeatures.length ? { omitFeatures } : {}),
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
  const parsed = parseObject(raw);
  if (!Array.isArray(parsed.images)) throw new Error('AI 返回的 JSON 缺少 images 数组');
  const normalizedMax = Math.max(1, Math.floor(Number(maxImages)) || 1);
  const normalizedMin = Math.min(
    normalizedMax,
    Math.max(0, Math.floor(Number(minImages)) || 0),
  );
  const positions = new Map(segments.map(segment => [segment.id, segment.sourceLine]));

  const images: ImageInsertion[] = [];
  for (let index = 0; index < parsed.images.length; index += 1) {
    const item = parsed.images[index];
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
function parseNewFields(raw: Record<string, unknown>, skipMale: boolean): string | null {
  const fields: Partial<Record<CharTagField, string>> = {};
  for (const field of CHAR_TAG_FIELDS) {
    const value = raw[field];
    const text = typeof value === 'string' ? value.trim().replace(/[\r\n]+/g, ' ') : '';
    if (text) fields[field] = text;
  }
  if (!fields.hair || !fields.eyes || (skipMale && isNaiMaleAppearance(fields.sex ?? ''))) return null;
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
      const parsedFields = fields ? parseNewFields(fields, !!knownMaleProfiles) : null;
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

/* ─────────────────────────── 五层服装状态表的解析 ─────────────────────────── */

export interface StateSyncPlan {
  v: 1;
  ops: StoredOutfitOp[];
  /** 同一次输出里顺带报告的角色建档/永久变化(读楼的是这条通道,不另开一次请求)。 */
  changes: CharChange[];
}

/** 导演通道的输出：这一格画什么、谁在里面、各自的表情与动作。 */
export interface DirectedCharacter {
  name: string;
  expression: string;
  gaze: string;
  /** 一句简短英文：这个人在这一格正在做的事。 */
  action: string;
  /** 施动者名字(可空)。 */
  source: string;
  /** 受动者名字(可空)。 */
  target: string;
  omitFeatures: string[];
}

export interface DirectedShot {
  position: string;
  sourceLine: number;
  /** 景别(英文 tag)：full body / cowboy shot / upper body / close-up … */
  scale: string;
  /** 场所(英文 tag，可空)。 */
  place: string;
  characters: DirectedCharacter[];
}

export interface DirectorPlan {
  v: 1;
  shots: DirectedShot[];
}

const OUTFIT_STATUSES = new Set<OutfitLayerStatus>(['worn', 'disheveled', 'removed']);

function isOutfitLayer(value: unknown): value is OutfitLayerKey {
  return typeof value === 'string' && (OUTFIT_LAYER_KEYS as readonly string[]).includes(value);
}

function outfitTag(value: unknown, field: string, index: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`);
  const text = value.trim().replace(/\s+/g, ' ');
  if (FORBIDDEN_SUBTAG.test(text)) throw new Error(`${field} 里不允许出现 <bbi_image> 等子标签`);
  if (text.length > 160) return text.slice(0, 160);
  void index;
  return text;
}

function outfitStatus(value: unknown, field: string): OutfitLayerStatus {
  if (value === undefined || value === null) return 'worn';
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`);
  const status = value.trim().toLowerCase();
  if (!OUTFIT_STATUSES.has(status as OutfitLayerStatus)) {
    throw new Error(`${field} 只能是 worn / disheveled / removed`);
  }
  return status as OutfitLayerStatus;
}

function parseLayerState(raw: unknown, field: string): { tag: string; status: OutfitLayerStatus; stateTag?: string } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const tag = outfitTag(item.tag ?? item.name ?? item.item, `${field}.tag`, 0);
  const status = outfitStatus(item.status, `${field}.status`);
  const stateTag = outfitTag(item.stateTag ?? item.state, `${field}.stateTag`, 0);
  if (!tag && status !== 'removed') return null;
  return { tag, status, ...(stateTag ? { stateTag } : {}) };
}

/**
 * 解析「任务 A：服装状态填表」的输出。
 *
 * 宽容口径和 parseImagePlan 一致：单条坏就丢这一条，不连累整份。
 * 唯一硬要求是 position 能对回本楼的物理行——落进 extra 的每条操作都带 sourceLine，
 * 回放时靠它切出「某一格那一刻」的状态；对不回来的操作宁可丢，也不能挪到楼头乱套。
 */
export function parseStateSyncPlan(
  raw: string,
  segments: TargetSegment[],
  rules: { knownMaleProfiles?: ReadonlySet<string> } = {},
): StateSyncPlan {
  const parsed = parseObject(raw);
  const source = parsed.outfit ?? parsed.ops ?? parsed.layers;
  const positions = new Map<string, number>();
  for (const segment of segments) positions.set(segment.id.toUpperCase(), segment.sourceLine);
  const firstLine = segments.length ? segments[0].sourceLine : 0;
  const ops: StoredOutfitOp[] = [];
  const parsedChanges = parseChanges(parsed.changes, positions, rules.knownMaleProfiles);
  if (!Array.isArray(source)) return { v: 1, ops, changes: parsedChanges };

  for (let index = 0; index < source.length && ops.length < 64; index += 1) {
    const rawItem = source[index];
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue;
    const item = rawItem as Record<string, unknown>;
    const op = typeof item.op === 'string' ? item.op.trim().toLowerCase() : '';
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name || name.length > 24) continue;
    const position = typeof item.position === 'string' ? item.position.trim().toUpperCase() : '';
    const matched = position && positions.has(position) ? positions.get(position)! : null;
    // set_outfit 是「这一身现在是这样」,落在首行也成立;update_layer 是「这一刻脱了它」,
    // 行号定不下来就丢掉——宁可不写,也不能把「脱掉」提前到楼首去。
    if (op !== 'set_outfit' && matched === null) continue;
    const sourceLine = matched ?? firstLine;

    try {
      if (op === 'set_outfit') {
        const layersRaw = item.layers;
        if (!layersRaw || typeof layersRaw !== 'object' || Array.isArray(layersRaw)) continue;
        const layers: Partial<Record<OutfitLayerKey, OutfitLayerState>> = {};
        for (const [key, value] of Object.entries(layersRaw as Record<string, unknown>)) {
          if (!isOutfitLayer(key)) continue;
          const state = parseLayerState(value, `outfit[${index}].layers.${key}`);
          if (state) layers[key] = state;
        }
        if (!Object.keys(layers).length) continue;
        const sceneHint = outfitTag(item.sceneHint ?? item.scene, `outfit[${index}].sceneHint`, index);
        ops.push({
          sourceLine,
          op: { op: 'set_outfit', name, ...(sceneHint ? { sceneHint } : {}), layers },
        });
        continue;
      }

      if (op === 'update_layer') {
        const layer = item.layer ?? item.key;
        if (!isOutfitLayer(layer)) continue;
        const status = outfitStatus(item.status, `outfit[${index}].status`);
        const tag = outfitTag(item.tag, `outfit[${index}].tag`, index);
        const stateTag = outfitTag(item.stateTag ?? item.state, `outfit[${index}].stateTag`, index);
        if (!tag && status !== 'removed') continue;
        ops.push({
          sourceLine,
          op: {
            op: 'update_layer',
            name,
            layer,
            status,
            ...(tag ? { tag } : {}),
            ...(stateTag ? { stateTag } : {}),
          },
        });
      }
    } catch {
      // 一条坏操作不该让整楼状态表作废。
    }
  }
  return { v: 1, ops, changes: parsedChanges };
}

/**
 * 解析「任务 B：导演选帧」的输出。
 *
 * 导演只交三样东西：位置、景别与场所、以及每个在场者的表情/视线/动作。
 * 外貌与服装一律不从这里来——那是本地编译器按档案与五层状态硬拼的，
 * 让模型再写一遍就等于给它一次把它们写漂的机会。
 */
const DIRECTOR_SCALES = ['full body', 'cowboy shot', 'upper body', 'close-up'] as const;

export function parseDirectorPlan(
  raw: string,
  segments: TargetSegment[],
  maxImages: number,
): DirectorPlan {
  const parsed = parseObject(raw);
  const positions = new Map<string, number>();
  for (const segment of segments) positions.set(segment.id.toUpperCase(), segment.sourceLine);
  const list = parsed.images ?? parsed.shots;
  const shots: DirectedShot[] = [];
  if (!Array.isArray(list)) return { v: 1, shots };

  for (let index = 0; index < list.length && shots.length < Math.max(1, maxImages); index += 1) {
    const rawItem = list[index];
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue;
    const item = rawItem as Record<string, unknown>;
    const position = typeof item.position === 'string' ? item.position.trim().toUpperCase() : '';
    if (!position || !positions.has(position)) continue;
    // 景别只认四选一:模型偶尔自创 "extreme macro" 这种词,直接写进 Base 会变成无意义 tag,
    // 无意义 tag 在 NAI 里不报错、只是让画面偏离。认不出就退回能看全身又看得见手的 cowboy shot。
    const rawScale = typeof item.scale === 'string' ? item.scale.trim().toLowerCase() : '';
    const scale = DIRECTOR_SCALES.includes(rawScale as (typeof DIRECTOR_SCALES)[number])
      ? rawScale
      : 'cowboy shot';
    const place = typeof item.place === 'string' ? item.place.trim() : '';
    const charactersRaw = item.characters ?? item.members ?? item.cast;
    const characters: DirectedCharacter[] = [];
    if (Array.isArray(charactersRaw)) {
      for (const rawCharacter of charactersRaw.slice(0, 8)) {
        if (!rawCharacter || typeof rawCharacter !== 'object' || Array.isArray(rawCharacter)) continue;
        const entry = rawCharacter as Record<string, unknown>;
        const name = typeof entry.name === 'string' ? entry.name.trim() : '';
        if (!name) continue;
        characters.push({
          name,
          expression: typeof entry.expression === 'string' ? entry.expression.trim() : '',
          gaze: typeof entry.gaze === 'string' ? entry.gaze.trim() : '',
          action: typeof entry.action === 'string' ? entry.action.trim() : '',
          source: typeof entry.source === 'string' ? entry.source.trim() : '',
          target: typeof entry.target === 'string' ? entry.target.trim() : '',
          omitFeatures: sanitizeOmitFeatures(entry.omitFeatures),
        });
      }
    }
    if (!characters.length) continue;
    shots.push({
      position,
      sourceLine: positions.get(position)!,
      scale,
      place,
      characters,
    });
  }
  return { v: 1, shots };
}
