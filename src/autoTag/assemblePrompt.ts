import type { ImageCharacterPrompt, ImageInsertion } from '@/autoTag/protocol';
import type { CharTagEntry } from '@/state/charTags';
import type { CharOutfitState } from '@/state/outfitState';

/**
 * 本地确定性编译器（计划书步骤 5）。
 *
 * 分工是死的：档案管「这个人长什么样」，五层状态管「此刻穿成什么样」，
 * 导演通道只交「这一格她在做什么」。外貌与服装一进模型就有漂的可能，
 * 所以这两样一律由这里硬拼，模型给的 ch.tag 只按顺序接在后面。
 */

function splitTags(raw: string): string[] {
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const key = t.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function normalizeSexTag(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (!s) return '';
  if (/^\d*\s*girls?$/.test(s)) return 'girl';
  if (/^\d*\s*boys?$/.test(s)) return 'boy';
  return raw.trim();
}

function isMaleEntry(entry: CharTagEntry | undefined, charTag: string): boolean {
  const sex = entry?.fields.sex.trim().toLowerCase() ?? '';
  if (/^\d*\s*boys?$/.test(sex)) return true;
  const tokens = splitTags(charTag).map(t => t.toLowerCase());
  return tokens.includes('boy') || tokens.includes('1boy') || tokens.includes('faceless male');
}

/**
 * 判断是否为纯上半身/面部特写景别（排除明确聚焦下身的局部特写如 thigh focus / foot focus / vaginal）。
 */
function isUpperOnlyShot(baseTag: string): boolean {
  const lower = baseTag.toLowerCase();
  const hasUpperCue = /\b(close-up|upper body|face focus)\b/.test(lower);
  const hasLowerOrFullCue =
    /\b(full body|wide shot|cowboy shot|medium shot|lower body|thigh focus|foot focus|ass focus|upskirt|vaginal|anal|crotch|doggystyle|cowgirl|missionary)\b/.test(
      lower,
    );
  return hasUpperCue && !hasLowerOrFullCue;
}

function isOnePieceOuter(outerTag: string): boolean {
  return /\b(dress|gown|kimono|yukata|hanfu|cheongsam|qipao|nightgown|bodysuit|leotard|swimsuit|onesie)\b/i.test(
    outerTag,
  );
}

/** 从角色库硬拼固定外貌（自动跳过 omitFeatures 中本帧临时摘下的眼镜/首饰）。 */
function buildFixedAppearanceTags(
  entry: CharTagEntry | undefined,
  omitFeatures: string[] = [],
): string[] {
  if (!entry) return [];
  const omitSet = new Set(omitFeatures.map(s => s.trim().toLowerCase()).filter(Boolean));
  const filterOmit = (raw: string) =>
    splitTags(raw).filter(t => {
      const lower = t.toLowerCase();
      if (!lower) return false;
      for (const omit of omitSet) {
        if (lower === omit || lower.includes(omit)) return false;
      }
      return true;
    });

  const fields = entry.fields;
  const hasStructured =
    Boolean(fields.sex.trim()) ||
    Boolean(fields.hair.trim()) ||
    Boolean(fields.eyes.trim()) ||
    Boolean(fields.skin.trim()) ||
    Boolean(fields.body.trim()) ||
    Boolean(fields.extra.trim());
  if (!hasStructured && entry.raw.trim()) return filterOmit(entry.raw);

  const tags: string[] = [];
  const push = (raw: string) => {
    for (const t of filterOmit(raw)) tags.push(t);
  };
  push(fields.fandom);
  push(normalizeSexTag(fields.sex) || 'girl');
  push(fields.hair);
  push(fields.eyes);
  push(fields.skin);
  push(fields.body);
  push(fields.extra);
  return dedupeTags(tags);
}

interface CompiledOutfit {
  positive: string[];
  negative: string[];
}

/** 五层状态 → 这一格的服装提示词（计划书步骤 5 的 compileOutfitForFrame）。 */
function compileOutfitForFrame(
  outfit: CharOutfitState | undefined,
  upperOnly: boolean,
): CompiledOutfit {
  const positive: string[] = [];
  const negative: string[] = [];
  if (!outfit) return { positive, negative };
  const layers = outfit.layers;

  const outer = layers.outer;
  const bra = layers.bra;
  const bottom = layers.bottom;
  const panties = layers.panties;
  const hosiery = layers.hosiery;

  if (outer) {
    if (outer.status === 'worn' && outer.tag) positive.push(outer.tag);
    if (outer.status === 'disheveled' && outer.tag) {
      positive.push(outer.tag);
      if (outer.stateTag) positive.push(outer.stateTag);
    }
  }

  if (bra) {
    if (bra.status === 'worn' && outer?.status !== 'worn' && bra.tag) positive.push(bra.tag);
    if (bra.status === 'disheveled' && bra.tag) {
      positive.push(bra.tag);
      if (bra.stateTag) positive.push(bra.stateTag);
    }
    if (bra.status === 'removed' && outer?.status !== 'worn') {
      negative.push('bra', 'underwear', 'bikini top');
      if (outer?.status === 'removed') {
        positive.push('topless', 'bare breasts', 'nipples');
        negative.push('shirt', 'blouse', 'dress');
      } else {
        positive.push('bare breasts', 'nipples');
      }
    }
  }

  if (!upperOnly) {
    const effectiveBottomStatus = !bottom?.tag && isOnePieceOuter(outer?.tag ?? '')
      ? outer?.status
      : bottom?.status;
    if (bottom) {
      if (bottom.status === 'worn' && bottom.tag) positive.push(bottom.tag);
      if (bottom.status === 'disheveled' && bottom.tag) {
        positive.push(bottom.tag);
        if (bottom.stateTag) positive.push(bottom.stateTag);
      }
    }

    if (panties) {
      if (panties.status === 'worn' && effectiveBottomStatus !== 'worn' && panties.tag) {
        positive.push(panties.tag);
      }
      if (panties.status === 'disheveled' && panties.tag) {
        positive.push(panties.tag);
        if (panties.stateTag) positive.push(panties.stateTag);
      }
      if (panties.status === 'removed' && effectiveBottomStatus !== 'worn') {
        negative.push('panties', 'underwear');
        if (effectiveBottomStatus === 'removed') {
          positive.push('bottomless');
          negative.push('skirt', 'pants', 'shorts');
        }
      }
    }

    if (hosiery) {
      if (hosiery.status === 'worn' && hosiery.tag) positive.push(hosiery.tag);
      if (hosiery.status === 'disheveled' && hosiery.tag) {
        positive.push(hosiery.tag);
        if (hosiery.stateTag) positive.push(hosiery.stateTag);
      }
    }
  }

  return { positive: dedupeTags(positive), negative: dedupeTags(negative) };
}

/** 同一个人自己的防漂移负面：发型/体型最容易在长楼里被画回默认值。 */
function buildSelfAntiDriftNegative(entry: CharTagEntry | undefined): string[] {
  if (!entry) return [];
  const hair = `${entry.fields.hair} ${entry.fields.extra}`.toLowerCase();
  const body = `${entry.fields.body} ${entry.fields.extra}`.toLowerCase();
  const out: string[] = [];
  if (/hair down|loose hair/.test(hair)) out.push('ponytail', 'twintails', 'twin braids', 'hair bun');
  if (/straight hair/.test(hair)) out.push('curly hair', 'wavy hair', 'drill hair');
  if (/short hair|short bob|bob cut/.test(hair)) {
    out.push('long hair', 'very long hair', 'ponytail', 'twintails');
  }
  if (/flat chest|small breasts/.test(body)) out.push('large breasts', 'huge breasts');
  if (/large breasts|huge breasts/.test(body)) out.push('flat chest', 'small breasts');
  return out;
}

/** 这个角色最有辨识度的特征（发色/标志发型/眼镜），用来给同框的别人当负面，防串色。 */
function extractDistinctiveFeatures(entry: CharTagEntry | undefined): string[] {
  if (!entry) return [];
  const source = `${entry.fields.hair}, ${entry.fields.extra}`;
  return splitTags(source).filter(t =>
    /\b(hair|ponytail|twintails|braids?|bun|bob|eyewear|glasses)\b/i.test(t),
  );
}

/**
 * 把导演通道挑出的这一格，编译成最终要发给 NAI 的插入内容。
 *
 * 顺序是固定的：固定外貌 → 五层服装 → 导演给的角色 tag（表情/视线/动作/source#/target#）。
 * 男角色跳过外貌与五层，只留导演给的 boy + 必要局部动作。
 * 返回的对象里不带 omitFeatures——那是组装期的一次性开关，序列化进正文只会变成脏 tag。
 */
export function assembleImageCharacters(
  image: ImageInsertion,
  entriesAtPos: CharTagEntry[],
  outfitsAtPos: Map<string, CharOutfitState>,
): ImageInsertion {
  const upperOnly = isUpperOnlyShot(image.tag);
  const femaleIndexes: number[] = [];
  image.characters.forEach((character, index) => {
    const entry = entriesAtPos.find(item => item.name === character.name);
    if (!isMaleEntry(entry, character.tag)) femaleIndexes.push(index);
  });

  const characters: ImageCharacterPrompt[] = image.characters.map((character, index) => {
    const entry = entriesAtPos.find(item => item.name === character.name);
    if (isMaleEntry(entry, character.tag)) {
      const male: ImageCharacterPrompt = { name: character.name, tag: character.tag, nl: character.nl };
      if (character.uc) male.uc = character.uc;
      return male;
    }

    const fixedTags = buildFixedAppearanceTags(entry, character.omitFeatures);
    const compiledOutfit = compileOutfitForFrame(outfitsAtPos.get(character.name), upperOnly);
    const fallbackOutfit =
      !outfitsAtPos.get(character.name) && entry?.fields.outfit.trim()
        ? splitTags(entry.fields.outfit)
        : [];
    const mergedPositive = dedupeTags([
      ...fixedTags,
      ...compiledOutfit.positive,
      ...fallbackOutfit,
      ...splitTags(character.tag),
    ]);

    const negativeParts = [
      ...splitTags(character.uc ?? ''),
      ...compiledOutfit.negative,
      ...buildSelfAntiDriftNegative(entry),
    ];
    if (femaleIndexes.length >= 2) {
      for (const otherIndex of femaleIndexes) {
        if (otherIndex === index) continue;
        const other = image.characters[otherIndex];
        const otherEntry = entriesAtPos.find(item => item.name === other.name);
        const own = new Set(mergedPositive.map(t => t.toLowerCase()));
        for (const feature of extractDistinctiveFeatures(otherEntry)) {
          if (own.has(feature.toLowerCase())) continue;
          negativeParts.push(feature);
        }
      }
    }

    const mergedUc = dedupeTags(negativeParts).join(', ');
    const result: ImageCharacterPrompt = {
      name: character.name,
      tag: mergedPositive.join(', '),
      nl: character.nl,
    };
    if (mergedUc) result.uc = mergedUc;
    return result;
  });

  return { ...image, characters };
}