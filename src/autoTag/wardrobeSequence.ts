import type { ImageCharacterPrompt, ImageInsertion } from '@/autoTag/protocol';
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

type Moment = { sourceLine: number; step?: number };

export function compareMoments(a: Moment, b: Moment): number {
  return a.sourceLine - b.sourceLine || (a.step ?? 0) - (b.step ?? 0);
}

/** 显式变化先于同一瞬间的镜头；旧导演只返回 wearState 时补录在它自己的 P 点。 */
export function compileWardrobeSequence<T>(
  before: Map<string, CharacterWardrobe>,
  updates: WardrobeUpdate[],
  shots: ImageInsertion[],
  compile: (shot: ImageInsertion, wardrobe: Map<string, CharacterWardrobe>) => T,
): { frames: T[]; updates: WardrobeUpdate[] } {
  const state = new Map(before);
  const persisted: WardrobeUpdate[] = [];
  const frames: T[] = new Array(shots.length);
  const ordered = updates.map(update => ({ ...update, sourceLine: update.position ? (update.sourceLine ?? 0) : -1 })).sort(compareMoments);
  const order = shots.map((shot, index) => ({ shot, index })).sort((a, b) => compareMoments(a.shot, b.shot));
  let cursor = 0;

  function apply(update: WardrobeUpdate): void {
    const slots = { ...update.slots };
    if (update.mode === 'patch') {
      const previous = state.get(update.name);
      for (const key of WARDROBE_SLOT_KEYS) {
        const patch = slots[key];
        if (!patch) continue;
        if (previous?.[key]?.tag) slots[key] = { ...patch, tag: previous[key].tag };
        else if (!patch.tag && !(patch.status === 'off' && (key === 'innerTop' || key === 'innerBottom'))) {
          console.warn('[星绘] 穿脱未找到原衣物', update.name, key, update.position);
          delete slots[key];
        }
      }
    }
    if (!Object.keys(slots).length) return;
    const resolved: WardrobeUpdate = { ...update, slots };
    applyWardrobeUpdate(state, resolved);
    persisted.push(resolved);
  }

  for (const { shot, index } of order) {
    while (cursor < ordered.length && compareMoments(ordered[cursor], shot) <= 0) apply(ordered[cursor++]);
    for (const character of shot.characters) {
      if (!character.wearState) continue;
      const slots = { ...character.wearState };
      for (const update of ordered) {
        if (update.name !== character.name || compareMoments(update, shot) !== 0) continue;
        for (const key of WARDROBE_SLOT_KEYS) if (update.slots[key]) delete slots[key];
      }
      apply({ name: character.name, mode: 'patch', slots, position: shot.position, sourceLine: shot.sourceLine, step: shot.step });
    }
    const characters = shot.characters.map(({ wearState, ...character }) => character);
    frames[index] = compile({ ...shot, characters }, state);
  }
  while (cursor < ordered.length) apply(ordered[cursor++]);
  return { frames, updates: persisted };
}
