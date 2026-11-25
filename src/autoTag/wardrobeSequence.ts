import type { TargetSegment } from './clean';
import { recoverExplicitWear, wardrobeEvidence } from './wardrobeEvidence';
import type { ImageCharacterPrompt, ImageInsertion } from '@/autoTag/protocol';
import {
  applyWardrobeUpdate,
  normaliseWardrobeUpdate,
  type TimeJump,
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

// 旧记录只允许给原样的第一项衣物词加主色，不能从内搭、配饰或其他槽借色。
const HUE = /^(?:(?:light|dark|pale|deep|dusty|pastel) )?(?:black|white|red|blue|navy|green|pink|brown|gr[ae]y|yellow|purple|ivory|cream|beige|orange|teal|burgundy|silver|gold|violet|lavender|maroon|khaki)$/i;
const UNCOLORED_GARMENT = /^(?:(?:plain|loose|casual|lounge|cropped|low-rise|high-waisted|fitted|oversized|pleated|lace|denim|silk|satin|cotton|linen|knit|leather|long|short|sleeveless|frayed|spaghetti-strap) )*(?:nightgown|camisole|tank top|shirt|t-shirt|top|blouse|shorts|skirt|dress|robe|coat|jacket|jeans|trousers|pants|bra|panties|stockings|socks|shoes|slippers)$/i;

export function completeGarmentColor(original: string, proposed?: string): string {
  if (!proposed) return original;
  const [item, ...details] = original.split(',').map(part => part.trim());
  const candidate = proposed.split(',')[0].trim();
  if (!UNCOLORED_GARMENT.test(item) || !candidate.toLowerCase().endsWith(' ' + item.toLowerCase())) return original;
  // A later tag may already specify this item's color (e.g. "nightgown, white").
  if (details.some(detail => detail.split(/[ -]+/).some(word => HUE.test(word)))) return original;
  const hue = candidate.slice(0, -item.length).trim();
  return HUE.test(hue) ? [hue + ' ' + item, ...details].join(', ') : original;
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
  narrative?: { segments: TargetSegment[]; timeJump: TimeJump; knownNames?: string[] },
): { frames: T[]; updates: WardrobeUpdate[] } {
  const state = new Map(before);
  const persisted: WardrobeUpdate[] = [];
  const frames: T[] = new Array(shots.length);
  const order = shots.map((shot, index) => ({ shot, index })).sort((a, b) => compareMoments(a.shot, b.shot));
  const cast = [...new Set([...before.keys(), ...(narrative?.knownNames ?? []), ...updates.map(update => update.name),
    ...shots.flatMap(shot => shot.characters.map(c => c.name))])];
  const recovered = narrative ? recoverExplicitWear(narrative.segments, cast, updates) : [];
  const ordered = [...updates, ...recovered].map(update => ({
    ...update, sourceLine: update.position ? (update.sourceLine ?? 0) : -1,
  })).sort(compareMoments);
  let cursor = 0;

  function apply(update: WardrobeUpdate): void {
    const slots = { ...update.slots };
    const previous = state.get(update.name);
    let mode = update.mode;
    if (narrative) {
      // 旧楼层会把外套写在 top、把单独鞋履写在 legs。对原件做 patch 时认回旧地址。
      if (mode === 'patch' && previous) {
        if (slots.outer && !previous.outer && !slots.top && !slots.outer.tag
          && /\b(?:coat|jacket|blazer|cloak|cardigan)\b/i.test(previous.top?.tag ?? '')) {
          slots.top = slots.outer;
          delete slots.outer;
        }
        if (slots.shoes && !previous.shoes && !slots.legs && !slots.shoes.tag
          && /\b(?:shoes?|boots?|sneakers?|heels?|slippers?|sandals?|loafers?)\b/i.test(previous.legs?.tag ?? '')
          && !/\b(?:socks?|stockings?|thighhighs|pantyhose)\b/i.test(previous.legs?.tag ?? '')) {
          slots.legs = slots.shoes;
          delete slots.shoes;
        }
      }
      const evidence = wardrobeEvidence(update, narrative.segments, narrative.timeJump, cast, previous);
      if (mode === 'patch') {
        for (const key of WARDROBE_SLOT_KEYS) {
          const request = slots[key];
          if (!request) continue;
          const old = previous?.[key];
          const statusCue = request.status === 'on' ? evidence.on(key) : request.status === 'off' ? evidence.off(key) : evidence.half(key);
          if (!statusCue && !(evidence.condition(key) && request.condition !== undefined && request.status === old?.status)) {
            delete slots[key];
          } else if (request.condition !== undefined && !evidence.condition(key)) {
            const { condition: _unsupported, ...wear } = request;
            slots[key] = wear;
          }
        }
      }
      if (previous && mode !== 'patch' && !evidence.date && !evidence.whole) {
        if (!evidence.replacement) {
          // 补漏或补旧档缺失的主色。不会因为更换景别而替换已记录的衣物、穿法或鞋袜。
          for (const key of WARDROBE_SLOT_KEYS) {
            const old = previous[key], requested = slots[key];
            if (!requested) continue;
            if (!old && evidence.motion && requested.tag) continue;
            const tag = old ? completeGarmentColor(old.tag, requested.tag) : undefined;
            if (old && tag && tag !== old.tag && evidence.motion) slots[key] = { ...old, tag };
            else delete slots[key];
          }
          mode = 'patch';
        } else {
          // 单件变化只改发生变化的槽位，不能让没列出的袜鞋和内搭消失。
          mode = 'swap';
          if (evidence.replacementSlots.length) for (const key of WARDROBE_SLOT_KEYS) {
            if (!evidence.replacementSlots.includes(key)
              && !(key === 'top' && !previous.outer && evidence.replacementSlots.includes('outer'))
              && !(key === 'legs' && !previous.shoes && evidence.replacementSlots.includes('shoes'))) delete slots[key];
          }
        }
      }
    }
    if (mode === 'patch') {
      for (const key of WARDROBE_SLOT_KEYS) {
        const patch = slots[key];
        if (!patch) continue;
        if (previous?.[key]?.tag) slots[key] = { ...patch, tag: completeGarmentColor(previous[key].tag, patch.tag) };
        else if (!patch.tag && !(patch.status === 'off' && (key === 'innerTop' || key === 'innerBottom'))) {
          console.warn('[星绘] 穿脱未找到原衣物', update.name, key, update.position);
          delete slots[key];
        }
      }
    }
    if (!Object.keys(slots).length) return;
    const resolved: WardrobeUpdate = { ...update, mode, slots };
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
      // 旧导演的镜头意见要和新事件过同一条正文检查，才能影响后续镜头。
      const legacy = normaliseWardrobeUpdate({ name: character.name, mode: 'patch', slots, position: shot.position, step: shot.step });
      if (legacy) apply({ ...legacy, sourceLine: shot.sourceLine });
    }
    const characters = shot.characters.map(({ wearState, ...character }) => character);
    frames[index] = compile({ ...shot, characters }, state);
  }
  while (cursor < ordered.length) apply(ordered[cursor++]);
  return { frames, updates: persisted };
}
