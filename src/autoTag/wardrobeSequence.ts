import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import {
  applyWardrobeUpdate,
  WARDROBE_SLOT_KEYS,
  type CharacterWardrobe,
  type GarmentSlot,
  type WardrobeSlotKey,
  type WardrobeUpdate,
} from '@/state/outfitState';

/**
 * 楼内穿脱与换装时序：一张图一张图地推进装备表。
 *
 * 两条规则：
 * 1. 换装按 position 生效——带 position 的 update 只对 sourceLine 不早于它的图片生效，
 *    「P10 进房间换好女仆装」不会把 P2 那张旧衣裳的图也套上女仆装；省略 position 的
 *    update 从楼首起对本楼全部图片生效（跨日、楼首换装）。
 * 2. 同一张图里先应用到期的 update，再叠加该图自己的 wearState：前一张脱掉的层自动
 *    延续到下一张，直到后续图写出 status:"on" 穿回。
 */
export function applyDueWardrobes(
  wardrobes: Map<string, CharacterWardrobe>,
  updates: WardrobeUpdate[],
  cursor: number,
  sourceLine: number,
): number {
  let index = cursor;
  while (index < updates.length) {
    const update = updates[index];
    if ((update.sourceLine ?? 0) > sourceLine) break;
    applyWardrobeUpdate(wardrobes, { name: update.name, mode: update.mode, slots: update.slots });
    index += 1;
  }
  return index;
}

/**
 * 正文顺序：模型给的图片顺序不一定跟着正文（可能先 P12 再 P2）。
 * 编译前必须按 sourceLine 稳定排序，否则 P2 会穿上 P10 才换的新衣服。
 * 返回的是原数组下标，落位写回时仍用原顺序。
 */
export function narrativeOrder<T extends { sourceLine: number }>(items: T[]): number[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.sourceLine - b.item.sourceLine || a.index - b.index)
    .map(entry => entry.index);
}

/** 把一张图里某个角色的 wearState 叠加进装备表（tag 沿用账本，只改状态码）。 */
export function applyFrameWearState(
  wardrobes: Map<string, CharacterWardrobe>,
  character: Pick<ImageCharacterPrompt, 'name' | 'wearState'>,
): void {
  const state = character.wearState;
  if (!state) return;
  const current = wardrobes.get(character.name);
  const slots: Partial<Record<WardrobeSlotKey, GarmentSlot>> = {};
  for (const [key, value] of Object.entries(state)) {
    if (!value) continue;
    const slotKey = key as WardrobeSlotKey;
    const tag = (current?.[slotKey]?.tag ?? '').trim();
    if (!tag) continue;
    slots[slotKey] = {
      tag,
      status: value.status,
      ...(value.halfTag ? { halfTag: value.halfTag } : {}),
    };
  }
  if (!Object.keys(slots).length) return;
  applyWardrobeUpdate(wardrobes, { name: character.name, mode: 'patch', slots });
}

/**
 * 楼尾补丁：只靠 wardrobeUpdates 重放会漏掉本楼逐帧 wearState 造成的穿脱
 * （比如第一张图把外套脱了、后面没有再写，落盘就会退回「穿着」）。
 * 这里把「最终状态」与「只重放 update 的状态」比一遍，差出来的槽位补成 patch。
 */
export function synthesiseTailUpdates(
  before: Map<string, CharacterWardrobe>,
  updates: WardrobeUpdate[],
  final: Map<string, CharacterWardrobe>,
): WardrobeUpdate[] {
  const replay = wardrobesAfterFloor(before, updates);
  const tail: WardrobeUpdate[] = [];
  for (const [name, wardrobe] of final) {
    const previous = replay.get(name);
    const slots: Partial<Record<WardrobeSlotKey, GarmentSlot>> = {};
    for (const key of WARDROBE_SLOT_KEYS) {
      const want = wardrobe[key];
      const got = previous?.[key];
      if (!want) continue;
      const same =
        got
        && got.tag === want.tag
        && got.status === want.status
        && (got.halfTag ?? '') === (want.halfTag ?? '');
      if (same) continue;
      slots[key] = { ...want };
    }
    if (Object.keys(slots).length) tail.push({ name, mode: 'patch', slots });
  }
  return tail;
}

/** 楼尾装备表：把本楼全部 update 依次应用一遍（落盘给下一楼的就是这份）。 */
export function wardrobesAfterFloor(
  before: Map<string, CharacterWardrobe>,
  updates: WardrobeUpdate[],
): Map<string, CharacterWardrobe> {
  const wardrobes = new Map<string, CharacterWardrobe>();
  for (const [name, wardrobe] of before) wardrobes.set(name, { ...wardrobe, name: wardrobe.name });
  for (const update of updates) {
    applyWardrobeUpdate(wardrobes, { name: update.name, mode: update.mode, slots: update.slots });
  }
  return wardrobes;
}
