import { joinNaiTags, NAI_VISUAL_FIELDS, naiTagParts } from '@/autoTag/naiAppearance';
import type { OutfitPart } from '@/autoTag/naiWardrobe';
import type { ImageCharacterPrompt, PlannedCharacterPrompt } from '@/autoTag/protocol';
import { charFieldsEmpty, type CharTagEntry, type CharTagFloorDelta } from '@/state/charTags';

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

/** Turn analysis-only fields into a normal Character Prompt before touching the saved tag format. */
export function completeNaiCharacter(
  planned: PlannedCharacterPrompt,
  entry: CharTagEntry | undefined,
  outfit: readonly OutfitPart[] | undefined,
  locked = false,
): ImageCharacterPrompt {
  const { name, tag, nl } = planned;
  const profile = entry && !isNaiMaleAppearance(entry.fields.sex, entry.raw) ? entry : undefined;
  if (isNaiMaleAppearance('', tag) || (entry && !profile)) return { name, tag, nl };

  const hasStructuredProfile = planned.useProfile && profile && !charFieldsEmpty(profile.fields);
  const appearance = hasStructuredProfile
    ? [
      profile.fields.fandom,
      ...NAI_VISUAL_FIELDS.filter(field => locked || !planned.temporaryFields?.includes(field))
        .map(field => profile.fields[field]),
    ]
    : [planned.useProfile ? planned.appearanceTag ?? '' : ''];

  let clothing = planned.outfitTag ?? '';
  if (planned.outfitParts?.length === 0) {
    clothing = '';
  } else if (planned.outfitParts !== undefined && profile && outfit) {
    const byId = new Map(outfit.map(part => [part.id, part]));
    const visible = planned.outfitParts.map(id => byId.get(id));
    if (visible.every(part => part !== undefined)) {
      clothing = visible.flatMap(part => part.state === 'removed' ? [] : [part.tag, part.state]).join(', ');
    }
    // An unknown part ID can coexist with known ones (e.g. a manually edited old tag).
    // Keep the whole fallback for that frame rather than silently emitting partial clothing.
  } else if (hasStructuredProfile && planned.outfitParts === undefined && !clothing) {
    clothing = profile.fields.outfit;
  }

  if (!planned.useProfile && !planned.outfitTag && planned.outfitParts === undefined) return { name, tag, nl };

  const sceneTags = naiTagParts(tag);
  if (hasStructuredProfile && !hasTag(tag, FEMALE_TAG) && hasTag(profile.fields.sex, FEMALE_TAG)) {
    sceneTags.unshift('girl');
  }
  return { name, tag: joinNaiTags([...appearance.filter(value => !/[<>]/.test(value)), ...sceneTags, clothing]), nl };
}
