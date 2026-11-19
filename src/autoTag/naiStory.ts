import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import type { CharTagEntry, CharTagFloorDelta } from '@/state/charTags';

const MALE_TAG = /^(?:(?:\d+\+?\s*)?(?:boys?|males?)|man|men)$/i;
const FEMALE_TAG = /^(?:(?:\d+\+?\s*)?(?:girls?|females?)|woman|women|multiple girls)$/i;
const FEMALE_COUNT = /^(?:[1-9]\d*\+?\s*girls?|multiple girls)$/i;

function hasTag(text: string, pattern: RegExp): boolean {
  return text.split(',').some(tag => pattern.test(tag.trim()));
}

/** Use explicit appearance tags, never a guess based on a character's name. */
export function isNaiMaleAppearance(sex: string, raw = ''): boolean {
  const appearance = sex.trim() || raw;
  return hasTag(appearance, MALE_TAG) && !hasTag(appearance, FEMALE_TAG);
}

/** A bare female count or an individual female caption identifies a subject in the frame. */
export function hasNaiFemaleSubject(tag: string, characters: readonly ImageCharacterPrompt[]): boolean {
  return hasTag(tag, FEMALE_COUNT) || characters.some(character => hasTag(character.tag, FEMALE_TAG));
}

/** Find male profiles for this request and retain their pre-existing changes on the same swipe. */
export function naiStoryProfiles(
  entries: readonly CharTagEntry[],
  delta: CharTagFloorDelta | null,
  swipe: number,
) {
  const maleNames = new Set(entries.filter(entry => isNaiMaleAppearance(entry.fields.sex, entry.raw)).map(entry => entry.name));
  const previousOps = delta?.swipe === swipe ? delta.ops : [];
  for (const op of previousOps) {
    if (op.kind === 'new' && isNaiMaleAppearance(op.fields.sex, op.raw)) maleNames.add(op.name);
  }
  return {
    maleNames,
    previousMaleOps: previousOps.filter(op => maleNames.has(op.name)),
  };
}
