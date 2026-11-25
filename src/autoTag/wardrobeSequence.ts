import type { TargetSegment } from './clean';
import { isNaiMaleAppearance } from './naiStory';
import { verifyNewWear, wardrobeBaseline } from './wardrobeBaseline';
import { compareStoryMoments } from './storyMoment';
import { recoverExplicitWear, wardrobeEvidence } from './wardrobeEvidence';
import type { ImageCharacterPrompt, ImageInsertion } from '@/autoTag/protocol';
import {
  applyWardrobeUpdate,
  dressStyle,
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

export const compareMoments = compareStoryMoments;

/** 显式变化先于同一瞬间的镜头；旧导演只返回 wearState 时补录在它自己的 P 点。 */
export function compileWardrobeSequence<T>(
  before: Map<string, CharacterWardrobe>,
  updates: WardrobeUpdate[],
  shots: ImageInsertion[],
  compile: (shot: ImageInsertion, wardrobe: Map<string, CharacterWardrobe>) => T,
  narrative?: { segments: TargetSegment[]; timeJump: TimeJump; knownNames?: string[]; maleNames?: ReadonlySet<string>; world?: string; previousStory?: string },
): { frames: T[]; updates: WardrobeUpdate[] } {
  const state = new Map(before);
  const persisted: WardrobeUpdate[] = [];
  const frames: T[] = new Array(shots.length);
  const momentOfShot = (shot: ImageInsertion) => shot.clause || !narrative
    ? shot : { ...shot, clause: Number.MAX_SAFE_INTEGER };
  const order = shots.map((shot, index) => ({ shot, index })).sort((a, b) => compareMoments(momentOfShot(a.shot), momentOfShot(b.shot)));
  const cast = [...new Set([...before.keys(), ...(narrative?.knownNames ?? []), ...updates.map(update => update.name),
    ...shots.flatMap(shot => shot.characters.map(c => c.name))])];
  const baseline = narrative ? wardrobeBaseline(narrative.segments, cast, narrative.world, narrative.previousStory, narrative.timeJump, shots) : undefined;
  const recovered = narrative ? recoverExplicitWear(narrative.segments, cast, updates) : [];
  const backfilledSlots = new Set<WardrobeUpdate['slots']>();
  if (narrative) updates = updates.map(update => ({ ...update, slots: { ...update.slots } }));
  if (narrative?.timeJump === 'same_day') for (const update of updates) {
    if (!update.describedSince || !update.observed) continue;
    const start = narrative.segments.findIndex(s => s.id === update.describedSince);
    const end = narrative.segments.findIndex(s => s.id === update.position);
    if (start < 0 || end <= start) continue;
    const intervening = narrative.segments.slice(start, end + 1).map(s => s.text).join(' ');
    if (/换[上装衣成了]|更衣|脱[下掉]|穿[上回换]|另外一件|第二天|次日|走进.{0,8}(?:房间|家中)|\b(?:changes? into|takes? off|puts? on|later that|the next day)\b/i.test(intervening)) continue;
    const evidence = wardrobeEvidence(update, narrative.segments, cast);
    const slots: WardrobeUpdate['slots'] = {};
    for (const key of WARDROBE_SLOT_KEYS) {
      const slot = update.slots[key];
      if (!slot?.tag || slot.status !== 'on' || !evidence.observed(key, slot.tag)) continue;
      if (before.get(update.name)?.[key]) continue;
      const earlier = [...updates, ...recovered].filter(other => other !== update && other.name === update.name
        && (other.mode === 'replace' || other.slots[key]) && (other.sourceLine ?? -1) < (update.sourceLine ?? 0));
      const initial = earlier.length === 1 && earlier[0].mode === 'replace' ? earlier[0] : undefined;
      if (initial?.position === update.describedSince
        && !wardrobeEvidence(initial, narrative.segments, cast).specifiedGarment) initial.slots[key] = slot;
      else if (!earlier.length) slots[key] = slot;
    }
    if (Object.keys(slots).length) {
      backfilledSlots.add(slots);
      // 只补已确认的单件。真正的换装/损坏仍在原始时点执行。
      recovered.push({ name: update.name, mode: 'swap', position: narrative.segments[start].id,
        sourceLine: narrative.segments[start].sourceLine, slots });
    }
  }
  const ordered = [...updates, ...recovered].map(update => ({
    ...update, sourceLine: update.position ? (update.sourceLine ?? 0) : -1,
  })).sort(compareMoments);
  let cursor = 0;
  const resetByDay = new Map<string, string>();
  const wearPhase = new Map<string, string>();
  const wornThisFloor = new Set<string>();

  function resumeWardrobe(update: WardrobeUpdate & { sourceLine?: number }, baseTag = ''): void {
    const previous = state.get(update.name);
    if (!baseline || !previous || update.sourceLine === undefined) return;
    const { day, workArrival, carries } = baseline.phase({ sourceLine: update.sourceLine, clause: update.clause }, update.name, baseTag);
    if (carries) return;
    // A new work arrival can resume last floor's temporary wear when the calendar cue was in the preceding floor.
    const phase = day ? day.sourceLine + '.' + day.clause
      : workArrival && before.has(update.name) && !wornThisFloor.has(update.name) ? 'work-arrival' : undefined;
    if (!phase || wearPhase.get(update.name) === phase) return;
    wearPhase.set(update.name, phase);
    const slots = baseline.keepWornIdentity(previous);
    const changed = WARDROBE_SLOT_KEYS.some(key => {
      const prior = previous[key];
      return prior && (prior.status !== 'on' || (prior.condition ?? '') !== (slots[key]?.condition ?? ''));
    });
    if (!changed) return;
    const resolved: WardrobeUpdate = { ...update, mode: 'replace', slots };
    if (Object.keys(slots).length) {
      applyWardrobeUpdate(state, resolved);
      persisted.push(resolved);
    } else {
      // Older saves can have only a status without a garment. Treat it as unknown in the new scene.
      state.delete(update.name);
    }
  }

  function fitUnspecifiedAncientCostume(slots: WardrobeUpdate['slots']) {
    const replacements: Partial<Record<WardrobeSlotKey, [RegExp, string]>> = {
      outer: [/\b(?:blazer|hoodie|bomber jacket|modern jacket)\b/i, 'traditional chinese outer robe'],
      top: [/\b(?:t-shirt|hoodie|track top|suit jacket)\b/i, 'cross-collar chinese top'],
      bottom: [/\b(?:jeans|denim shorts|cargo pants|bike shorts)\b/i, 'traditional chinese trousers'],
      shoes: [/\b(?:sneakers|trainers|platform heels)\b/i, 'embroidered cloth shoes'],
    };
    for (const key of WARDROBE_SLOT_KEYS) {
      const slot = slots[key];
      const replacement = replacements[key];
      if (!slot?.tag || !replacement?.[0].test(slot.tag)) continue;
      const hue = slot.tag.match(/^(?:light |dark )?(?:black|white|red|blue|navy|green|pink|brown|gr[ae]y|ivory|cream|beige|purple)\b/i)?.[0];
      slots[key] = { ...slot, tag: [hue, replacement[1]].filter(Boolean).join(' ') };
    }
  }

  function apply(update: WardrobeUpdate): void {
    resumeWardrobe({ name: update.name, mode: 'replace', slots: {}, position: update.position,
      sourceLine: update.sourceLine, clause: update.clause });
    const slots = { ...update.slots };
    const previous = state.get(update.name);
    let mode = update.mode;
    let day: string | undefined;
    const backfilled = backfilledSlots.has(update.slots);
    const evidence = narrative && !backfilled ? wardrobeEvidence(update, narrative.segments, cast, previous) : undefined;
    if (narrative && evidence) {
      // 旧楼层会把外套写在 top、把单独鞋履写在 legs。对原件做 patch 时认回旧地址。
      if (mode === 'patch' && previous) {
        if (slots.outer && !previous.outer && !slots.top && !slots.outer.tag
          && /\b(?:coat|jacket|blazer|cloak|cardigan)\b/i.test(previous.top?.tag ?? '')) {
          slots.top = slots.outer;
          delete slots.outer;
        }
        if (slots.shoes && !previous.shoes && !slots.legs && !slots.shoes.tag && previous.legs?.tag) {
          const parts = previous.legs.tag.split(',').map(part => part.trim());
          const shoe = parts.find(part => /\b(?:shoes?|boots?|sneakers?|heels?|slippers?|sandals?|loafers?)\b/i.test(part));
          const socks = /\b(?:socks?|stockings?|thighhighs|pantyhose)\b/i.test(previous.legs.tag);
          if (shoe && !socks) {
            slots.legs = slots.shoes;
            delete slots.shoes;
          } else if (shoe) {
            slots.shoes = { ...slots.shoes, tag: shoe };
          }
        }
      }
      if (mode === 'patch') {
        for (const key of WARDROBE_SLOT_KEYS) {
          const request = slots[key];
          if (!request) continue;
          const old = previous?.[key];
          const statusCue = request.offSide ? evidence.off(key) || evidence.half(key)
            : request.status === 'on' ? evidence.on(key) : request.status === 'off' ? evidence.off(key) : evidence.half(key);
          if (!statusCue && !(evidence.condition(key) && request.condition !== undefined && request.status === old?.status)) {
            delete slots[key];
          } else {
            const next = { ...request };
            if (request.condition !== undefined && !evidence.condition(key)) delete next.condition;
            const footwear = key === 'shoes' || key === 'legs' && !previous?.shoes;
            if (footwear && evidence.singleShoe) {
              if (request.status === 'off' || request.offSide) {
                const offSide = evidence.shoeSide ?? request.offSide;
                if (old?.status !== 'off') {
                  next.status = old?.offSide && offSide && old.offSide !== offSide ? 'off' : 'half';
                  next.offSide = next.status === 'half' ? offSide : undefined;
                  if (next.status === 'half' && !offSide) next.halfTag = next.halfTag || 'one shoe off';
                } else {
                  next.status = 'off';
                  delete next.offSide;
                }
              } else if (request.status === 'on' && evidence.shoeSide && old?.status === 'off') {
                next.status = 'half';
                next.offSide = evidence.shoeSide === 'left' ? 'right' : 'left';
              }
            }
            slots[key] = next;
          }
        }
      }
      day = mode === 'replace' && evidence.day && resetByDay.get(update.name) !== evidence.day ? evidence.day : undefined;
      if (narrative.world === 'chinese_ancient' && mode === 'replace' && (!previous || day) && !evidence.specifiedGarment) {
        fitUnspecifiedAncientCostume(slots);
      }
      if (previous && mode !== 'patch' && !day && !evidence.whole) {
        if (!evidence.replacement) {
          // 补漏或补旧档缺失的主色。不会因为更换景别而替换已记录的衣物、穿法或鞋袜。
          const observed = WARDROBE_SLOT_KEYS.filter(key => evidence.observed(key, slots[key]?.tag));
          for (const key of WARDROBE_SLOT_KEYS) {
            const old = previous[key], requested = slots[key];
            if (!requested) continue;
            if (observed.length) {
              if (!observed.includes(key)) delete slots[key];
              continue;
            }
            if (!old && evidence.motion && requested.tag) continue;
            const tag = old ? completeGarmentColor(old.tag, requested.tag) : undefined;
            if (old && tag && tag !== old.tag && evidence.motion) slots[key] = { ...old, tag };
            else delete slots[key];
          }
          mode = observed.length ? 'swap' : 'patch';
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
    if (evidence && mode !== 'patch') {
      for (const key of WARDROBE_SLOT_KEYS) {
        const slot = slots[key];
        if (!slot) continue;
        const verified = verifyNewWear(slot, slot.status === 'off' ? evidence.off(key) : evidence.half(key));
        if (verified) slots[key] = verified;
        else delete slots[key];
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
    if (narrative && mode !== 'patch' && slots.top?.tag && !slots.top.style) {
      const style = dressStyle(slots.top.tag);
      if (style) slots.top = { ...slots.top, style };
    }
    const resolved: WardrobeUpdate = { ...update, mode, slots };
    applyWardrobeUpdate(state, resolved);
    if (day && mode === 'replace') resetByDay.set(update.name, day);
    persisted.push(resolved);
    if (WARDROBE_SLOT_KEYS.some(key => slots[key] && slots[key]!.status !== 'on')) wornThisFloor.add(update.name);
  }

  for (const { shot, index } of order) {
    while (cursor < ordered.length && compareMoments(ordered[cursor], momentOfShot(shot)) <= 0) apply(ordered[cursor++]);
    for (const character of shot.characters) {
      const init = { name: character.name, mode: 'swap' as const, slots: {}, position: shot.position, sourceLine: shot.sourceLine, clause: shot.clause };
      resumeWardrobe(init, shot.tag);
      if (baseline && narrative && !narrative.maleNames?.has(character.name)
        && !isNaiMaleAppearance('', character.tag) && !/\bfaceless male\b/i.test(character.tag)) {
        const evidence = wardrobeEvidence(init, narrative.segments, cast, state.get(character.name));
        const skip = new Set<'top' | 'bottom'>();
        for (const key of ['top', 'bottom'] as const) if (evidence.off(key)) skip.add(key);
        const known = state.get(character.name);
        const slots = baseline.fill(shot, character, known, skip);
        if (slots.top?.tag && !slots.top.style) {
          const style = dressStyle(slots.top.tag);
          if (style) slots.top.style = style;
        }
        if (Object.keys(slots).length) {
          const resolved: WardrobeUpdate = { ...init, mode: known ? 'swap' : 'replace', slots };
          applyWardrobeUpdate(state, resolved);
          persisted.push(resolved);
        }
      }
      if (!character.wearState) continue;
      const slots = { ...character.wearState };
      for (const update of ordered) {
        if (update.name !== character.name || compareMoments(update, shot) !== 0) continue;
        for (const key of WARDROBE_SLOT_KEYS) if (update.slots[key]) delete slots[key];
      }
      // 旧导演的镜头意见要和新事件过同一条正文检查，才能影响后续镜头。
      const legacy = normaliseWardrobeUpdate({ name: character.name, mode: 'patch', slots, position: shot.position, step: shot.step, clause: shot.clause });
      if (legacy) apply({ ...legacy, sourceLine: shot.sourceLine });
    }
    const characters = shot.characters.map(({ wearState, ...character }) => character);
    frames[index] = compile({ ...shot, characters }, state);
  }
  while (cursor < ordered.length) apply(ordered[cursor++]);
  return { frames, updates: persisted };
}
