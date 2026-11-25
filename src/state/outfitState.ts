import { getContext, type STMessage } from '@/st/context';

/**
 * 装备表（服装账本 v3）：**装备描述永不删除，状态码与描述分离**。
 *
 * v1（五层微操作）和 v2（结楼穿搭指纹）各有毛病：v1 两条通道互相打脸；v2 把「脱掉的
 * 那件」直接从词串里删掉，后人想穿回只能凭记忆重写一遍，写出来就是另一件衣服。
 *
 * v3 拆成两件事：
 *   - `tag` 是这件装备的视觉指纹，**脱掉也不删**；
 *   - `status` 是 on / half / off 三个状态码，`half` 时再用 `halfTag` 写"敞开/撩到腰"。
 * 于是「穿回」只需发 `status: "on"`，原样复原，不需要模型再描述一次衣服。
 *
 * 一楼只落「相对上一楼的变化」（WardrobeUpdate）：`replace` 换整套（首次出场、明确换装、
 * 隔天），`patch` 更新穿法，`swap` 更换指定单件；旧 wearState 由运行期并入相应 P 点。
 */

export type SlotWearStatus = 'on' | 'half' | 'half_top' | 'half_bottom' | 'off';

export type WardrobeSlotKey = 'top' | 'innerTop' | 'bottom' | 'innerBottom' | 'legs' | 'outer' | 'shoes';

export const WARDROBE_SLOT_KEYS: WardrobeSlotKey[] = ['top', 'innerTop', 'bottom', 'innerBottom', 'legs', 'outer', 'shoes'];

export const WARDROBE_SLOT_LABELS: Record<WardrobeSlotKey, string> = {
  top: '外衣/上装',
  innerTop: '上内衣',
  bottom: '下装',
  innerBottom: '下内衣',
  legs: '袜/鞋',
  outer: '叠穿外套',
  shoes: '独立鞋履',
};

export interface GarmentSlot {
  /** 装备本身的视觉指纹（脱掉时绝不删除，以便后续穿回 100% 原样还原）。 */
  tag: string;
  /** 固定剪裁和纹样，随原件继承。 */
  style?: string;
  /** on=正常穿着 | half/half_top/half_bottom=半脱 | off=已脱掉 */
  status: SlotWearStatus;
  /** 半脱时的具体动作词（"unbuttoned, open front" / "skirt lift"）。 */
  halfTag?: string;
  /** 半开时实际能否看到下一层；未指定时识别旧记录中明确的敞开/露出措辞。 */
  reveal?: 'none' | 'layer';
  /** 持续附着在这件衣物上的状态，空串表示清除。 */
  condition?: string;
  /** 鞋履只离脚一侧。half 继续兼容旧记录。 */
  offSide?: 'left' | 'right';
}

/** patch 可以只给状态（穿回原件），tag 由运行期从旧账本取回。 */
export type GarmentPatch = Partial<GarmentSlot> & { status: SlotWearStatus };

export interface CharacterWardrobe {
  name: string;
  top?: GarmentSlot;
  innerTop?: GarmentSlot;
  bottom?: GarmentSlot;
  innerBottom?: GarmentSlot;
  legs?: GarmentSlot;
  outer?: GarmentSlot;
  shoes?: GarmentSlot;
}

export type TimeJump = 'same_day' | 'new_day';

/** 一楼相对上一楼的变化。 */
export interface WardrobeUpdate {
  name: string;
  mode: 'replace' | 'patch' | 'swap';
  step?: number;
  clause?: number;
  /** 正文直接描写已经穿着的不同衣物，用于没有写换装过程的情况。 */
  observed?: boolean;
  /** 同一场内首次补述这一件本来就在穿的衣物。 */
  describedSince?: string;
  slots: Partial<Record<WardrobeSlotKey, GarmentPatch>>;
  /** 这次换装从哪个 P 编号开始生效；省略表示从楼首生效。 */
  position?: string;
  /** position 解析出的正文行号（协议层填，运行期按它逐图生效）。 */
  sourceLine?: number;
}

export interface WardrobeFloorDelta {
  v: 3;
  swipe: number;
  updates: WardrobeUpdate[];
}

export const BBI_OUTFIT_EXTRA_KEY = 'bbiOutfitOps';

const STATUSES: SlotWearStatus[] = ['on', 'half', 'half_top', 'half_bottom', 'off'];

/**
 * 服装指纹里的临时穿法词：它们是「这一次怎么穿」，不是「这件衣服长什么样」。
 * 留在指纹里，下一次半敞时就会变成 buttoned, unbuttoned 自相矛盾。
 * 只剥独立词；button-down shirt / zip-up hoodie 这类款式复合词原样保留。
 */
const TRANSIENT_WEAR = new Set(['buttoned', 'unbuttoned', 'zipped', 'unzipped', 'zipper open', 'zipper closed']);

export function stripTransientWear(tag: string): string {
  return tag
    .split(',')
    .map(part => part.trim())
    .filter(part => part && !TRANSIENT_WEAR.has(part.toLowerCase()))
    .join(', ');
}

/** 未单独建下装时，这些衣物自身提供上下身覆盖。 */
export const ONEPIECE_GARMENT =
  /\b(dress|gown|kimono|yukata|hanfu|robe|cheongsam|qipao|nightgown|bodysuit|leotard|swimsuit|onesie|jumpsuit)\b/i;

export function dressStyle(tag: string): string {
  // 旧的“颜色 + dress”只确定了颜色。用一个稳定、普通的轮廓补足未指定的款式。
  return /^(?:(?:light|dark|pale|pastel|dusty) )?(?:black|white|red|blue|navy|green|pink|brown|gr[ae]y|yellow|purple|ivory|cream|beige|orange|teal|burgundy|lavender) dress$/i.test(tag)
    ? 'plain woven fabric, simple round neckline, short sleeves, single-piece dress' : '';
}

/**
 * 归一一个槽位。replace 要求给新衣服的 tag（否则无指纹可存）；
 * patch 允许只给 { status: "on" } —— 这正是「穿回原件」，tag 由 applyWardrobeUpdate 从旧账本取回。
 */
function normaliseSlot(raw: unknown, requireTag: boolean): GarmentSlot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const tag = typeof record.tag === 'string' ? stripTransientWear(record.tag.trim().replace(/[\r\n]+/g, ' ')) : '';
  let status: SlotWearStatus | '' = typeof record.status === 'string' && STATUSES.includes(record.status as SlotWearStatus)
    ? (record.status as SlotWearStatus)
    : '';
  if (!status) return null;
  // replace 缺 tag 视为无效（没有衣服描述可存）；patch 缺 tag 合法，表示沿用旧指纹。
  const offSide = record.offSide === 'left' || record.offSide === 'right' ? record.offSide : undefined;
  if (offSide) status = 'half';
  if (requireTag && !tag && status !== 'off') return null;
  const halfTag = typeof record.halfTag === 'string' ? record.halfTag.trim().replace(/[\r\n]+/g, ' ') : '';
  const half = status === 'half' || status === 'half_top' || status === 'half_bottom';
  const reveal = half && (record.reveal === 'none' || record.reveal === 'layer') ? record.reveal : undefined;
  const damage = /^(?:broken|snapped|torn) (?:shoulder |spaghetti )?straps?$/i;
  const parts = half ? halfTag.split(',').map(part => part.trim()).filter(Boolean) : [];
  const wear = parts.filter(part => !damage.test(part)).join(', ');
  const condition = typeof record.condition === 'string'
    ? record.condition.trim().replace(/\s+/g, ' ').slice(0, 90)
    : parts.filter(part => damage.test(part)).join(', ') || undefined;
  const style = typeof record.style === 'string' && !/[<>\r\n]/.test(record.style)
    ? stripTransientWear(record.style.slice(0, 120)).split(', ').filter(part =>
      !/\b(?:half-off|lifted|open front|rolled (?:up )?sleeves|loose strap|slipping|bra|panties|nude|bare breasts)\b/i.test(part)).join(', ') : '';
  return { tag, status, ...(style ? { style } : {}), ...(offSide ? { offSide } : {}), ...(wear ? { halfTag: wear } : {}), ...(reveal ? { reveal } : {}),
    ...(condition !== undefined ? { condition } : {}) };
}

export function normaliseWardrobe(raw: unknown): CharacterWardrobe | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!name) return null;
  const wardrobe: CharacterWardrobe = { name };
  for (const key of WARDROBE_SLOT_KEYS) {
    const slot = normaliseSlot(record[key], true);
    if (slot) wardrobe[key] = slot;
  }
  return wardrobe;
}

export function readWardrobeStep(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function normaliseWardrobeUpdate(raw: unknown): WardrobeUpdate | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!name) return null;
  const mode = record.mode;
  if (mode !== 'replace' && mode !== 'patch' && mode !== 'swap') return null;
  const rawSlots = record.slots;
  if (!rawSlots || typeof rawSlots !== 'object' || Array.isArray(rawSlots)) return null;
  const slots: Partial<Record<WardrobeSlotKey, GarmentSlot>> = {};
  for (const key of WARDROBE_SLOT_KEYS) {
    const rawSlot = (rawSlots as Record<string, unknown>)[key];
    const slot = normaliseSlot(rawSlot, mode !== 'patch' && key !== 'innerTop' && key !== 'innerBottom');
    if (slot && key !== 'shoes' && key !== 'legs') delete slot.offSide;
    if (slot && (mode === 'patch' || slot.tag || slot.status === 'off')) slots[key] = slot;
  }
  if (!Object.keys(slots).length) return null;
  const position = typeof record.position === 'string' ? record.position.trim().slice(0, 16) : '';
  const step = readWardrobeStep(record.step);
  const clause = readWardrobeStep(record.clause);
  return { name, mode, slots, ...(step ? { step } : {}), ...(clause ? { clause } : {}),
    ...(record.observed === true ? { observed: true } : {}),
    ...(record.observed === true && typeof record.describedSince === 'string' && /^P[1-9]\d*$/.test(record.describedSince)
      ? { describedSince: record.describedSince } : {}), ...(position ? { position } : {}) };
}

/**
 * 读一楼的装备变化。旧版 v1（五层 ops）/ v2（结楼快照）一律安全忽略返回 null：
 * 换代后老聊天不能因此崩溃，更不能被当成「全裸」。
 */
export function readWardrobeFloorDelta(message: STMessage | undefined): WardrobeFloorDelta | null {
  const raw = (message?.extra as Record<string, unknown> | undefined)?.[BBI_OUTFIT_EXTRA_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.v !== 3 || typeof obj.swipe !== 'number' || !Array.isArray(obj.updates)) return null;
  const updates: WardrobeUpdate[] = [];
  for (const item of obj.updates) {
    const update = normaliseWardrobeUpdate(item);
    if (update) updates.push(update);
  }
  return { v: 3, swipe: obj.swipe, updates };
}

export function makeWardrobeFloorDelta(
  updates: WardrobeUpdate[],
  swipe: number,
): WardrobeFloorDelta | undefined {
  const cleaned = updates
    .map(update => normaliseWardrobeUpdate(update))
    .filter((update): update is WardrobeUpdate => update !== null);
  return cleaned.length ? { v: 3, swipe, updates: cleaned } : undefined;
}

/** 把一条更新叠加到当前装备表上（replace 只清本次给了的槽位之外的全部，保留 tag）。 */
export function applyWardrobeUpdate(
  wardrobes: Map<string, CharacterWardrobe>,
  update: WardrobeUpdate,
): void {
  const current = wardrobes.get(update.name) ?? { name: update.name };
  const next: CharacterWardrobe = { name: update.name };
  if (update.mode === 'replace') {
    for (const key of WARDROBE_SLOT_KEYS) {
      const slot = update.slots[key];
      if (slot && (slot.tag || slot.status === 'off')) next[key] = { ...slot, tag: slot.tag ?? '' };
    }
  } else {
    for (const key of WARDROBE_SLOT_KEYS) {
      const previous = current[key];
      const patch = update.slots[key];
      if (patch) {
        // patch 只覆盖 status/halfTag，tag 缺省时沿用旧指纹（模型常只回 {"status":"on"}）。
        next[key] = {
          tag: patch.tag || previous?.tag || '',
          status: patch.status,
          ...(patch.offSide ? { offSide: patch.offSide } : update.mode === 'patch' && patch.status === 'half'
            && !patch.halfTag && previous?.offSide ? { offSide: previous.offSide } : {}),
          style: update.mode === 'patch' ? previous?.style : patch.style,
          condition: patch.condition ?? (update.mode === 'patch' ? previous?.condition : undefined),
          reveal: patch.reveal ?? (update.mode === 'patch' && patch.status === previous?.status && !patch.halfTag ? previous?.reveal : undefined),
          ...(patch.status !== 'on' && patch.status !== 'off' && (patch.halfTag || (update.mode !== 'swap' && patch.status === previous?.status && previous?.halfTag))
            ? { halfTag: patch.halfTag || previous?.halfTag }
            : {}),
        };
        if (!next[key]?.tag && patch.status !== 'off') delete next[key];
      } else if (previous) {
        next[key] = { ...previous };
      }
    }
  }
  if (WARDROBE_SLOT_KEYS.some(key => next[key])) wardrobes.set(update.name, next);
}

/** 从第 0 楼回放到 upToExclusive（不含）；swipe 不匹配整楼跳过。 */
export function deriveWardrobes(
  chat: STMessage[],
  upToExclusive = chat.length,
): Map<string, CharacterWardrobe> {
  const wardrobes = new Map<string, CharacterWardrobe>();
  const end = Math.min(upToExclusive, chat.length);
  for (let floor = 0; floor < end; floor += 1) {
    const message = chat[floor];
    const delta = readWardrobeFloorDelta(message);
    if (!delta) continue;
    const currentSwipe = typeof message?.swipe_id === 'number' ? message.swipe_id : 0;
    if (delta.swipe !== currentSwipe) continue;
    for (const update of delta.updates) applyWardrobeUpdate(wardrobes, update);
  }
  return wardrobes;
}

export function wardrobesBeforeFloor(floor: number): Map<string, CharacterWardrobe> {
  const chat = getContext()?.chat ?? [];
  return deriveWardrobes(chat, Math.max(0, floor));
}

function describeSlot(label: string, slot: GarmentSlot | undefined): string | null {
  if (!slot) return null;
  const statusText = slot.status === 'half_top' ? '上身半开' : slot.status === 'half_bottom' ? '下摆提起' : slot.status === 'on' ? '穿着' : slot.status === 'off' ? '已脱' : '半脱';
  const detail = slot.halfTag ? `(${slot.halfTag})` : '';
  const shoeSide = slot.offSide === 'left' ? ' 左脚未穿' : slot.offSide === 'right' ? ' 右脚未穿' : '';
  const visibility = slot.reveal === 'layer' ? ' 内层明确可见' : slot.reveal === 'none' ? ' 内层遮住' : '';
  return `${label}[${[slot.tag || '款式未知', slot.style, slot.condition].filter(Boolean).join(', ')}|${statusText}${detail}${visibility}${shoeSide}]`;
}

/** 喂给提示词的装备表文本。 */
export function buildWardrobeText(wardrobes: Map<string, CharacterWardrobe>): string {
  if (wardrobes.size === 0) {
    return '（上一楼无装备记录：请按正文实际描写确定初始穿搭，并在 wardrobeUpdates 里用 replace 建表）';
  }
  const lines: string[] = [];
  for (const wardrobe of wardrobes.values()) {
    const parts = WARDROBE_SLOT_KEYS
      .map(key => describeSlot(WARDROBE_SLOT_LABELS[key], wardrobe[key]))
      .filter((part): part is string => part !== null);
    lines.push(`- ${wardrobe.name}：${parts.length ? parts.join('｜') : '暂无可确认的装备'}`);
  }
  return lines.join('\n');
}

/** 当前穿着（status=on/half）的槽位，供立绘与编译参考。 */
export function wornSlots(wardrobe: CharacterWardrobe | undefined): GarmentSlot[] {
  if (!wardrobe) return [];
  return WARDROBE_SLOT_KEYS
    .map(key => wardrobe[key])
    .filter((slot): slot is GarmentSlot => Boolean(slot) && slot!.status !== 'off');
}