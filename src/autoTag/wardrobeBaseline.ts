import { isNaiMaleAppearance } from './naiStory';
import type { TargetSegment } from './clean';
import type { ImageCharacterPrompt, ImageInsertion } from './protocol';
import { compareStoryMoments, storyClauses } from './storyMoment';
import { actualText, belongsTo, changesWardrobe, explicitlyCarriesWardrobe, isWardrobeDayBreak } from './wardrobeEvidence';
import { ONEPIECE_GARMENT, WARDROBE_SLOT_KEYS, type CharacterWardrobe, type GarmentPatch, type TimeJump, type WardrobeUpdate } from '@/state/outfitState';

type Moment = Pick<ImageInsertion, 'sourceLine' | 'clause'>;
type Point = Moment & { text: string; owner?: string };
type OuterSlot = 'top' | 'bottom';

const WORK = /上班|到公司|进公司|办公室|办公区|会议室|开会|打卡上班|\b(?:office|meeting room|conference room|at work|goes? to work)\b/i;
const ARRIVAL = /(?:去|来到|走进|进入|回到|到达|进了).{0,8}(?:公司|办公室|办公区|会议室)|(?:准时|照常|开始|照旧|赶去)(?:去)?上班|\b(?:gets? to work|goes? to work|arrives? at (?:the )?office|enters? (?:the )?(?:office|meeting room))\b/i;
const TRANSIT = /地铁|车厢|通勤|\b(?:commuting|subway|train carriage|metro)\b/i;
const CUT = /回到家|进了浴室|入睡|睡醒|梦醒|下班后|过了.{1,6}小时|镜头切换|\b(?:back home|wakes? up|cuts? to)\b/i;
const ATTIRE_MENTION = /试穿|试衣|买了|买下|手提|手里|手上拿|拿出|取出|衣柜|想起|看中|挑选|说起|提到|对方的|另一个人的|\b(?:shops? for|buys?|takes? out|borrowed|chooses?|picks? out)\b/i;
const OWNED_LOWER_IN_CAPTION = /\bher (?:damp |wet |wrinkled )?(skirt|jeans|trousers|pants|shorts)\b/i;
const TRANSIENT_CONDITION = /\b(?:wet|damp|soaked|wrinkled|rumpled)(?: (?:fabric|clothes|dress|skirt|shirt|hem|garment))?\b/i;
const GARMENTS: ReadonlyArray<{ slot: OuterSlot; pattern: RegExp; tag: string }> = [
  { slot: 'top', pattern: /连[衣身]裙|\b(?:dress hem|dress|one-piece dress)\b/i, tag: 'dress' },
  { slot: 'top', pattern: /旗袍|\b(?:cheongsam|qipao)\b/i, tag: 'cheongsam' },
  { slot: 'top', pattern: /衬[衣衫]|\b(?:blouse|collared shirt)\b/i, tag: 'collared blouse' },
  { slot: 'top', pattern: /针织衫|毛衣|\b(?:sweater|knit top)\b/i, tag: 'knit sweater' },
  { slot: 'top', pattern: /[Tt]恤|\bt-shirt\b/i, tag: 't-shirt' },
  { slot: 'bottom', pattern: /(?<!连衣|连身)裙(?:摆|子|裤)?|\bskirt\b/i, tag: 'skirt' },
  { slot: 'bottom', pattern: /牛仔裤|\bjeans\b/i, tag: 'jeans' },
  { slot: 'bottom', pattern: /西装裤|长[裤褲]|(?:黑色|白色|灰色)裤子|\b(?:trousers|pants)\b/i, tag: 'trousers' },
  { slot: 'bottom', pattern: /短[裤褲]|\bshorts\b/i, tag: 'shorts' },
];
const COLORS: ReadonlyArray<[RegExp, string]> = [
  [/浅蓝(?:色)?$|light blue$/i, 'light blue'], [/深蓝(?:色)?$|navy$/i, 'navy'],
  [/白(?:色)?$|white$/i, 'white'], [/黑(?:色)?$|black$/i, 'black'],
  [/灰(?:色)?$|gr[ae]y$/i, 'grey'], [/红(?:色)?$|red$/i, 'red'],
  [/米(?:白|色)$|beige$/i, 'beige'], [/蓝(?:色)?$|blue$/i, 'blue'],
];

function wornHint(text: string, slot: OuterSlot): string | undefined {
  if (ATTIRE_MENTION.test(text)) return;
  for (const garment of GARMENTS) {
    if (garment.slot !== slot) continue;
    const match = garment.pattern.exec(text);
    if (!match || match.index === undefined) continue;
    const before = text.slice(Math.max(0, match.index - 16), match.index).trimEnd();
    if (/没(?:有)?穿$|脱[下掉]$|摘[下掉]$|without (?:a|her|his)?$/i.test(before)) continue;
    const color = COLORS.find(([pattern]) => pattern.test(before))?.[1];
    return color ? color + ' ' + garment.tag : garment.tag;
  }
}

const visibleClothes: Record<string, readonly [string, string]> = {
  modern: ['ivory collared blouse', 'charcoal straight-leg trousers'],
  chinese_ancient: ['ivory cross-collar chinese top', 'navy high-waisted mamian skirt'],
  western_fantasy: ['ivory long-sleeved linen blouse', 'brown ankle-length linen skirt'],
  retro_republic: ['ivory mandarin-collar blouse', 'navy knee-length skirt'],
  urban_fantasy: ['ivory collared shirt', 'charcoal straight-leg trousers'],
  scifi_cyberpunk: ['charcoal high-collar utility shirt', 'navy straight-leg cargo trousers'],
  custom: ['plain collared top', 'plain straight-leg trousers'],
};

/** 空槽时从正文和本次分析中找一件持续穿着的衣物，由楼内时序负责保存和复用。 */
export function wardrobeBaseline(
  segments: TargetSegment[],
  cast: string[],
  world?: string,
  previousStory = '',
  timeJump?: TimeJump,
  shots: ImageInsertion[] = [],
) {
  const priorTail = storyClauses(previousStory).map(actualText).filter(Boolean).slice(-10);
  const previouslyAtWork = priorTail.some(text => WORK.test(text));
  const priorDay = priorTail.findLastIndex(isWardrobeDayBreak);
  const newDayAtPreviousEnd = priorDay >= priorTail.length - 2 && priorDay >= 0;
  const points: Point[] = segments.flatMap(segment => {
    let owner: string | undefined;
    return storyClauses(segment.text).flatMap((clause, i) => {
      const text = actualText(clause);
      if (!text) return [];
      const named = cast.filter(name => text.includes(name));
      if (named.length) owner = named.length === 1 ? named[0] : undefined;
      return [{ text, owner, sourceLine: segment.sourceLine, clause: i + 1 }];
    });
  });
  const isAtOrBefore = (point: Point, now: Moment) =>
    compareStoryMoments(point, { ...now, clause: now.clause ?? Number.MAX_SAFE_INTEGER }) <= 0;

  function phase(now: Moment, name: string, baseTag = '') {
    const current = points.filter(point => point.sourceLine === now.sourceLine && isAtOrBefore(point, now)
      && belongsTo(point.text, cast, name));
    const ownText = current.map(point => point.text).join(' ');
    const work = WORK.test(ownText) || (WORK.test(baseTag) && current.length > 0 && current.some(p => p.text.includes(name)));
    const workArrival = work && (ARRIVAL.test(ownText) || !previouslyAtWork && (timeJump === 'new_day' || WORK.test(ownText)));
    const day = points.findLast(point => isAtOrBefore(point, now) && isWardrobeDayBreak(point.text)
      && belongsTo(point.text, cast, name));
    return { day, work, workArrival: workArrival || newDayAtPreviousEnd && work && timeJump === 'new_day', carries: explicitlyCarriesWardrobe(ownText), ownText };
  }

  function keepWornIdentity(known: CharacterWardrobe): WardrobeUpdate['slots'] {
    const slots: WardrobeUpdate['slots'] = {};
    for (const key of WARDROBE_SLOT_KEYS) {
      const entry = known[key];
      if (!entry?.tag) continue;
      const condition = (entry.condition ?? '').split(',').map(part => part.trim())
        .filter(part => part && !TRANSIENT_CONDITION.test(part)).join(', ');
      slots[key] = { tag: entry.tag, status: 'on', ...(entry.style ? { style: entry.style } : {}),
        ...(condition ? { condition } : {}) };
    }
    return slots;
  }

  function fill(
    frame: ImageInsertion,
    character: ImageCharacterPrompt,
    known: CharacterWardrobe | undefined,
    skipped: ReadonlySet<OuterSlot>,
  ): WardrobeUpdate['slots'] {
    const slots: WardrobeUpdate['slots'] = {};
    const current = phase(frame, character.name, frame.tag);
    const wardrobePeriod: Point[] = [];
    let nextPhase: Point | undefined;
    const clauses = points.filter(p => (!p.owner || p.owner === character.name) && belongsTo(p.text, cast, character.name));
    for (const point of clauses) {
      if (isWardrobeDayBreak(point.text) || CUT.test(point.text) || changesWardrobe(point.text)) {
        if (!isAtOrBefore(point, frame)) {
          nextPhase = point;
          break;
        }
        wardrobePeriod.length = 0;
      }
      wardrobePeriod.push(point);
    }
    const isNear = (p: Point) => p.sourceLine === frame.sourceLine && isAtOrBefore(p, frame);
    // 本地画面之前的证据优先。后文仅可补同一穿着段内提到的原件。
    const ordered = [...wardrobePeriod.filter(p => isNear(p)),
      ...wardrobePeriod.filter(p => isAtOrBefore(p, frame) && !isNear(p)).reverse(),
      ...wardrobePeriod.filter(p => !isAtOrBefore(p, frame) && (p.owner === character.name || p.text.includes(character.name)))];
    const roleClothes = character.tag.split(',').map(t => t.trim()).filter(t =>
      !/(?:#|grabbing|holding|lifting|removing|adjusting|wearing only|topless|bottomless)/i.test(t));
    const pick = (slot: OuterSlot) => ordered.map(p => wornHint(p.text, slot)).find(Boolean)
      ?? roleClothes.find(tag => /^[-a-z ]{2,72}$/i.test(tag) && GARMENTS.some(({ slot: key, pattern }) => {
        if (key !== slot) return false;
        const match = pattern.exec(tag);
        return match && match.index + match[0].length === tag.length;
      }));
    const defaults = world ? visibleClothes[world] : undefined;
    const publicRoutine = current.work || TRANSIT.test(frame.tag + ' ' + current.ownText);
    const top = known?.top ?? known?.outer;
    const bottom = known?.bottom;
    const topHint = pick('top');
    // 兼容没交装备表却在后一个镜头写明本人下装的旧导演。只在同段首次建衣件时用。
    const draftedBottom = () => {
      for (const candidate of shots) {
        if (compareStoryMoments(candidate, frame) < 0 || nextPhase && isAtOrBefore(nextPhase, candidate)) continue;
        const actor = candidate.characters.find(role => role.name === character.name);
        if (!actor) continue;
        const soleFemale = candidate.characters.filter(c => !isNaiMaleAppearance('', c.tag)
          && !/\bfaceless male\b/i.test(c.tag)).length === 1;
        const prose = [actor.nl, ...(soleFemale ? [candidate.nl] : [])].join(' ');
        const noun = prose.match(OWNED_LOWER_IN_CAPTION)?.[1].toLowerCase();
        if (noun) return noun;
      }
    };
    const bottomHint = pick('bottom') ?? (!bottom && !top && !topHint ? draftedBottom() : undefined);
    const hasOnePiece = ONEPIECE_GARMENT.test(top?.tag ?? topHint ?? '');
    const newLook = !top && !bottom && !skipped.size;
    if (!top && !skipped.has('top') && (topHint || defaults && (newLook || publicRoutine))) {
      const tag = topHint ?? defaults![0];
      slots.top = { tag: tag === 'dress' ? 'navy dress' : tag, status: 'on' };
    }
    if (!bottom && !hasOnePiece && !skipped.has('bottom') && (bottomHint || defaults && (newLook || publicRoutine))) {
      const tag = bottomHint === 'skirt' ? 'charcoal knee-length straight skirt' : bottomHint ?? defaults![1];
      slots.bottom = { tag, status: 'on' };
    }
    return slots;
  }

  return { phase, keepWornIdentity, fill };
}

export function verifyNewWear(slot: GarmentPatch, permits: boolean): GarmentPatch | undefined {
  if (slot.status === 'on' || permits) return slot;
  if (!slot.tag) return;
  const { halfTag, reveal, offSide, ...garment } = slot;
  return { ...garment, status: 'on' };
}
