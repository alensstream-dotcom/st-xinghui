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
 * 隔天），`patch` 只改发生变化的槽位。楼内同一楼第 1 张全穿、第 2 张半敞、第 3 张全脱由
 * 每张图的 `wearState` 当帧覆盖，不再写成 P 节点微操作。
 */

export type SlotWearStatus = 'on' | 'half' | 'off';

export type WardrobeSlotKey = 'top' | 'innerTop' | 'bottom' | 'innerBottom' | 'legs';

export const WARDROBE_SLOT_KEYS: WardrobeSlotKey[] = ['top', 'innerTop', 'bottom', 'innerBottom', 'legs'];

export const WARDROBE_SLOT_LABELS: Record<WardrobeSlotKey, string> = {
  top: '外衣/上装',
  innerTop: '上内衣',
  bottom: '下装',
  innerBottom: '下内衣',
  legs: '袜/鞋',
};

export interface GarmentSlot {
  /** 装备本身的视觉指纹（脱掉时绝不删除，以便后续穿回 100% 原样还原）。 */
  tag: string;
  /** on=正常穿着 | half=半脱/敞开/撩起 | off=已脱掉 */
  status: SlotWearStatus;
  /** 仅 status === 'half' 时的具体动作词（"unbuttoned, open front" / "skirt lift"）。 */
  halfTag?: string;
}

export interface CharacterWardrobe {
  name: string;
  top?: GarmentSlot;
  innerTop?: GarmentSlot;
  bottom?: GarmentSlot;
  innerBottom?: GarmentSlot;
  legs?: GarmentSlot;
}

export type TimeJump = 'same_day' | 'new_day';

/** 一楼相对上一楼的变化。 */
export interface WardrobeUpdate {
  name: string;
  mode: 'replace' | 'patch';
  slots: Partial<Record<WardrobeSlotKey, GarmentSlot>>;
}

export interface WardrobeFloorDelta {
  v: 3;
  swipe: number;
  updates: WardrobeUpdate[];
}

export const BBI_OUTFIT_EXTRA_KEY = 'bbiOutfitOps';

const STATUSES: SlotWearStatus[] = ['on', 'half', 'off'];

function normaliseSlot(raw: unknown): GarmentSlot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const tag = typeof record.tag === 'string' ? record.tag.trim().replace(/[\r\n]+/g, ' ') : '';
  const status = typeof record.status === 'string' && STATUSES.includes(record.status as SlotWearStatus)
    ? (record.status as SlotWearStatus)
    : '';
  if (!status) return null;
  // off 也必须有 tag：这正是「穿回时不必重写」的前提，缺 tag 的 off 视为无效。
  if (!tag) return null;
  const halfTag = typeof record.halfTag === 'string' ? record.halfTag.trim().replace(/[\r\n]+/g, ' ') : '';
  return { tag, status, ...(status === 'half' && halfTag ? { halfTag } : {}) };
}

export function normaliseWardrobe(raw: unknown): CharacterWardrobe | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!name) return null;
  const wardrobe: CharacterWardrobe = { name };
  for (const key of WARDROBE_SLOT_KEYS) {
    const slot = normaliseSlot(record[key]);
    if (slot) wardrobe[key] = slot;
  }
  return wardrobe;
}

export function normaliseWardrobeUpdate(raw: unknown): WardrobeUpdate | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!name) return null;
  const mode = record.mode === 'patch' ? 'patch' : record.mode === 'replace' ? 'replace' : '';
  if (!mode) return null;
  const rawSlots = record.slots;
  if (!rawSlots || typeof rawSlots !== 'object' || Array.isArray(rawSlots)) return null;
  const slots: Partial<Record<WardrobeSlotKey, GarmentSlot>> = {};
  for (const key of WARDROBE_SLOT_KEYS) {
    const slot = normaliseSlot((rawSlots as Record<string, unknown>)[key]);
    if (slot) slots[key] = slot;
  }
  if (!Object.keys(slots).length) return null;
  return { name, mode, slots };
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
    for (const [key, slot] of Object.entries(update.slots) as Array<[WardrobeSlotKey, GarmentSlot]>) {
      next[key] = { ...slot };
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
          ...(patch.status === 'half' && (patch.halfTag || previous?.halfTag)
            ? { halfTag: patch.halfTag || previous?.halfTag }
            : {}),
        };
        if (!next[key]?.tag) delete next[key];
      } else if (previous) {
        next[key] = { ...previous };
      }
    }
  }
  wardrobes.set(update.name, next);
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
  const statusText = slot.status === 'on' ? '穿着' : slot.status === 'half' ? '半脱' : '已脱';
  const detail = slot.status === 'half' && slot.halfTag ? `(${slot.halfTag})` : '';
  return `${label}[${slot.tag}|${statusText}${detail}]`;
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
    lines.push(`- ${wardrobe.name}：${parts.length ? parts.join('｜') : '全裸（无任何装备）'}`);
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