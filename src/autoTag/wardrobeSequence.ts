import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import {
  applyWardrobeUpdate,
  type CharacterWardrobe,
  type GarmentSlot,
  type TimeJump,
  type WardrobeSlotKey,
  type WardrobeUpdate,
} from '@/state/outfitState';

/**
 * 楼内穿脱时序：一张图一张图地推进装备表。
 *
 * 这里解决的是「楼尾污染楼首」——模型在本楼第 3 张才让她脱光，但如果直接把楼尾的
 * off/half 状态套到整楼，第 1 张也会被画成裸的。正确做法是：
 * 1. 起始基准 = 上一楼结尾装备表 + 本楼**新增的装备**（状态一律按穿着算）；
 * 2. 每张图只叠加它自己的 wearState，前一张脱掉的层自动延续到下一张；
 * 3. 楼尾最终状态由调用方重新应用一遍 wardrobeUpdates 得到，落盘给下一楼。
 */
export function guardSameDayReplace(
  timeJump: TimeJump,
  updates: WardrobeUpdate[],
  before: Map<string, CharacterWardrobe>,
): WardrobeUpdate[] {
  if (timeJump !== 'same_day') return updates;
  return updates.map(update => {
    if (update.mode !== 'replace' || update.explicitChange === true) return update;
    if (!before.has(update.name)) return update;
    console.info(`[星绘] same_day 下的换装被降级为 patch（${update.name}）：正文没有明确换装`);
    return { ...update, mode: 'patch' as const };
  });
}

/** 本楼起始装备表：沿用上一楼，只吸收新出现的装备与明确换装。 */
export function seedWardrobes(
  before: Map<string, CharacterWardrobe>,
  updates: WardrobeUpdate[],
): Map<string, CharacterWardrobe> {
  const wardrobes = new Map<string, CharacterWardrobe>();
  for (const [name, wardrobe] of before) {
    wardrobes.set(name, { ...wardrobe, name: wardrobe.name });
  }
  for (const update of updates) {
    if (update.mode === 'replace') {
      const slots: Partial<Record<WardrobeSlotKey, GarmentSlot>> = {};
      for (const [key, slot] of Object.entries(update.slots)) {
        if (slot) slots[key as WardrobeSlotKey] = { ...slot, status: 'on' };
      }
      applyWardrobeUpdate(wardrobes, { name: update.name, mode: 'replace', slots });
      continue;
    }
    const current = wardrobes.get(update.name);
    const fresh: Partial<Record<WardrobeSlotKey, GarmentSlot>> = {};
    for (const [key, slot] of Object.entries(update.slots)) {
      if (!slot) continue;
      // 这一楼新出现的装备按「穿着」入表；已有的不动，状态交给逐帧。
      if (!current?.[key as WardrobeSlotKey]) fresh[key as WardrobeSlotKey] = { ...slot, status: 'on' };
    }
    if (Object.keys(fresh).length) {
      applyWardrobeUpdate(wardrobes, { name: update.name, mode: 'patch', slots: fresh });
    }
  }
  return wardrobes;
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
