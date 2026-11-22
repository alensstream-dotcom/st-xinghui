import type { ImageCharacterPrompt, ImageInsertion } from '@/autoTag/protocol';
import type { CharTagEntry } from '@/state/charTags';
import type { CharOutfitState } from '@/state/outfitState';
import type { WorldAnchorConfig } from '@/state/worldAnchor';

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

/**
 * 导演偶尔把「source#李斌」「target#温岚」这种中文人名写进标记位。标记后面只该跟
 * 英文动作词；带着中文的标记在 NovelAI 里既不是动作也不是权重，留着只会污染提示词。
 */
const DIRECTOR_MARKER = /^(?:source|target|mutual)#/i;
const HAS_CJK = /[\u4e00-\u9fff\u3040-\u30ff]/;

function dropLocalizedMarkers(tags: string[]): string[] {
  return tags.filter(tag => !DIRECTOR_MARKER.test(tag) || !HAS_CJK.test(tag));
}

/** 只在全身/腿长镜头里才有意义的纯下身词：上半身构图写进去会让 NAI 硬塞一双腿。 */
const LEG_ONLY = /\b(?:long legs?|short legs?|slender legs?|thick thighs?|bare legs?|shapely legs?|wide hips?)\b/i;
/** 鞋子类词：半身构图拍不到脚，留着会被画成蜷脚塞进画面。 */
const SHOE_WORD = /\b(?:flats?|heels?|high heels?|shoes?|boots?|sneakers?|sandals?|loafers?|pumps?|mary janes?|slippers?)\b/i;
const SHOES_HIDDEN_SHOT = /\b(?:cowboy shot|medium shot|upper body|close-up|face focus)\b/i;

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

export function isOnePieceOuter(outerTag: string): boolean {
  return /\b(dress|gown|kimono|yukata|hanfu|robe|taoist robe|cloak|tunic|trench coat|cheongsam|qipao|nightgown|bodysuit|leotard|swimsuit|onesie)\b/i.test(
    outerTag,
  );
}

/** 连身长款词:长袍/长裙类外衣把下身整个罩住,没有「掀开」就不该让短裙词抢画面。 */
const LONG_HEM = /\b(?:ankle-length|full-length|floor-length|long|maxi)\b/i;
/** 短裙类词:只有换装或掀开时才允许与长袍同框。 */
export const SHORT_SKIRT = /\b(?:miniskirt|microskirt|short skirt|pleated skirt|skater skirt)\b/i;

/**
 * omitFeatures 的匹配器:按逗号分词后做「整词/词边界」比对,绝不做子串包含。
 * 旧实现用 `lower.includes(omit)`,摘 hairpin 时会连带把 `hair`、`long hair` 一起摘掉——
 * 结果就是「角色变金发」。这里改成词边界匹配,`hairpin` 只命中 hairpin 本身。
 */
function buildOmitMatcher(omitFeatures: string[]): (token: string) => boolean {
  const items = omitFeatures
    .flatMap(value => splitTags(value))
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  if (!items.length) return () => false;
  const patterns = items.map(item => new RegExp(`(?:^|\\s)${item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\s)`, 'i'));
  return (token: string) => {
    const lower = token.trim().toLowerCase();
    if (!lower) return false;
    return patterns.some(pattern => pattern.test(lower));
  };
}

/**
 * 从角色库硬拼固定外貌。
 *
 * 关键红线:omitFeatures 只允许过滤 `extra`(眼镜、首饰、发饰等临时可摘的东西)。
 * 发色/发型/瞳色/肤色/体型是身份本身,任何情况下都不许被 omit —— 少了它们 NAI 会
 * 按默认值另画一个人(最典型的就是「黑发被画成金发」)。
 */
function buildFixedAppearanceTags(
  entry: CharTagEntry | undefined,
  omitFeatures: string[] = [],
): string[] {
  if (!entry) return [];
  const isOmitted = buildOmitMatcher(omitFeatures);
  const filterOmit = (raw: string) => splitTags(raw).filter(t => !isOmitted(t));
  const identity = (raw: string) => splitTags(raw);

  const fields = entry.fields;
  const hasStructured =
    Boolean(fields.sex.trim()) ||
    Boolean(fields.hair.trim()) ||
    Boolean(fields.eyes.trim()) ||
    Boolean(fields.skin.trim()) ||
    Boolean(fields.body.trim()) ||
    Boolean(fields.extra.trim());
  // 只有整串 tag 没有结构化字段时无从区分「身份」与「配饰」,这里只能按整词过滤配饰;
  // 结构化条目则走下面 identity() 的通道,omit 只落在 extra 上。
  if (!hasStructured && entry.raw.trim()) return filterOmit(entry.raw);

  const tags: string[] = [];
  /** 身份字段:不受 omit 影响。 */
  const pushIdentity = (raw: string) => {
    for (const t of identity(raw)) tags.push(t);
  };
  pushIdentity(fields.fandom);
  pushIdentity(normalizeSexTag(fields.sex) || 'girl');
  pushIdentity(fields.hair);
  pushIdentity(fields.eyes);
  pushIdentity(fields.skin);
  pushIdentity(fields.body);
  // 只有 extra(眼镜/首饰/发饰)允许被本帧临时摘掉
  for (const t of filterOmit(fields.extra)) tags.push(t);
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

  // 外衣判定为 removed 就是上半身没有外衣:无论内衣状态如何,都要把「上衣类」压进角色负面,
  // 否则 NAI 会按世界观默认衣装自己补一件衬衣/汉服上衣,出现「脱了又穿回去」的漂移。
  if (outer?.status === 'removed') {
    negative.push('shirt', 'blouse', 'dress', 'coat', 'robe', 'hanfu');
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
    // 下装脱了就是脱了:无论内裤还穿没穿,都要把裙/裤压进负面。
    // 以前只有「内裤也脱了」才压,于是「裤子脱了、内裤还在」时模型会自己补一条裙子回来。
    if (effectiveBottomStatus === 'removed') {
      positive.push('bottomless');
      negative.push('skirt', 'pants', 'shorts');
    }
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
 * 导演通道只能写「这一格正在发生什么」，不能写「这个人长什么样、穿什么」。
 * 一旦这个女角已经在角色库里（外貌有档案）、或已有五层服装状态，导演再写发色/瞳色/体型/性别人数词/衣物，
 * 就是在和权威数据抢方向盘——古风楼被塞进 pleated skirt、银发角色被写成 blonde，都是这么来的。
 * 所以这里在合流之前先硬清洗一遍：只留动作、表情、视线、姿势与 source#/target#/mutual# 标记。
 */
const SEX_WORD_TAG = /^(?:1girl|2girls|3girls|multiple girls|1boy|2boys|3boys|multiple boys|girl|boy|solo)$/i;
const HAIR_TAG = /\b(hair|bangs|ponytail|twintails|braid|braids|braided|bun|bob|updo|ahoge)\b/i;
const EYE_SKIN_TAG = /\b(eyes|tsurime|tareme|jitome|sanpaku|pale skin|fair skin|dark skin|tan)\b/i;
const STATIC_BODY_TAG = /\b(tall female|petite|slender|curvy|voluptuous|flat chest|small breasts|medium breasts|large breasts|huge breasts|wide hips|long legs)\b/i;
const GARMENT_TAG = /\b(dress|robe|hanfu|kimono|cheongsam|skirt|pants|jeans|shorts|shirt|blouse|coat|jacket|blazer|sweater|uniform|bra|panties|underwear|dudou|pantyhose|stockings|thighhighs|socks|shoes|heels|boots|sneakers)\b/i;
/** 这些词说明这一格正在发生接触（手在头发里、抓着衣领），属于动作，不算外貌/服装声明。 */
const ACTION_TOUCH_TAG = /\b(hand|hands|holding|touching|grabbing|pulling|lifting|unbuttoning|pressed|against|around|on her|on his)\b/i;

export function stripLeakedAppearanceAndOutfit(
  tags: string[],
  hasLibraryEntry: boolean,
  hasOutfitState: boolean,
): string[] {
  return tags.filter(tag => {
    const token = tag.trim();
    if (!token) return false;
    // 标记词(source#/target#/mutual#)永远是动作,不许动。
    if (token.includes('#')) return true;
    if (hasLibraryEntry && SEX_WORD_TAG.test(token)) return false;
    if (ACTION_TOUCH_TAG.test(token)) return true;
    if (hasLibraryEntry && HAIR_TAG.test(token)) return false;
    if (hasLibraryEntry && EYE_SKIN_TAG.test(token)) return false;
    if (hasLibraryEntry && STATIC_BODY_TAG.test(token)) return false;
    if (hasOutfitState && GARMENT_TAG.test(token)) return false;
    return true;
  });
}

/**
 * 这一格「实际被遮住」的部位。状态表说了算:
 * - 上半身遮住 = 胸罩穿好,或外衣穿好且胸罩没被脱掉(外衣敞开时胸罩若还在也算遮住)
 * - 下半身遮住 = 下装/内裤穿好,或连身衣整体穿好
 * - 连身长袍穿好且没掀开时,短裙词一律不出现(否则百褶裙会盖掉道袍下摆)
 */
interface CoverState {
  upper: boolean;
  lower: boolean;
  suppressShortSkirt: boolean;
}

const CONFLICT_UPPER = /^(?:bare breasts|topless|exposed breasts|exposed chest|nipples?|bare chest|nude)$/i;
const PROPORTION_GUARDRAILS = ['giantess', 'size difference', 'miniature'];
const HEIGHT_GAP_SHOT = /\b(sitting|kneeling|kneel|crouching|lying|floor seat|on lap|seiza)\b/i;
const STANDING_TAG = /\b(standing|walking|leaning forward)\b/i;

const CONFLICT_LOWER = /^(?:bottomless|nude|naked|completely nude|fully nude|pussy|spread pussy|pussy juice)$/i;

/**
 * 高低差构图(一人站、一人坐/跪/躺)的比例防畸变词。
 *
 * 组装期把它加进角色 uc;生成期还要用它压全局负面(Base 层),否则 NAI 仍会把
 * 站着的人拉成巨人、坐着的人缩成小人。判据只此一处,两个阶段共用。
 */
export function proportionGuardrailsFor(text: string): string[] {
  return HEIGHT_GAP_SHOT.test(text) && STANDING_TAG.test(text) ? [...PROPORTION_GUARDRAILS] : [];
}

function describeCoverage(outfit: CharOutfitState | undefined): CoverState {
  const layers = outfit?.layers;
  if (!layers) return { upper: false, lower: false, suppressShortSkirt: false };
  const outerWorn = layers.outer?.status === 'worn';
  const onePiece = outerWorn && isOnePieceOuter(layers.outer?.tag ?? '');
  // 上身穿没穿看「外衣穿着」或「胸罩穿着」——外衣穿着时上身就是被遮住的,
  // 哪怕里面没穿胸罩。以前写成 `bra worn || (outer worn && bra !== removed)`,
  // 外衣穿好、胸罩已脱时会判成 false,于是导演写的 topless 被放行,人就被画成光着上身。
  const upper = outerWorn || layers.bra?.status === 'worn';
  const lower = layers.bottom?.status === 'worn' || layers.panties?.status === 'worn' || onePiece;
  const longHem = onePiece && LONG_HEM.test(layers.outer?.tag ?? '') && layers.outer?.status !== 'disheveled';
  return { upper, lower, suppressShortSkirt: longHem };
}

/** 把与状态表冲突的露点词从导演给的 tag 里剔掉(只剔冲突词,不动动作/表情/标记)。 */
function resolveCoverConflicts(tags: string[], cover: CoverState): string[] {
  if (!cover.upper && !cover.lower) return tags;
  return tags.filter(tag => {
    const token = tag.trim();
    if (cover.upper && CONFLICT_UPPER.test(token)) return false;
    if (cover.lower && CONFLICT_LOWER.test(token)) return false;
    return true;
  });
}

/**
 * 把导演通道挑出的这一格，编译成最终要发给 NAI 的插入内容。
 *
 * 顺序是固定的：固定外貌 → 五层服装 → 导演给的角色 tag（表情/视线/动作/source#/target#）。
 * 男角色跳过外貌与五层，只留导演给的 boy + 必要局部动作。
 * 返回的对象里不带 omitFeatures——那是组装期的一次性开关，序列化进正文只会变成脏 tag。
 */
/**
 * 世界观防穿帮词:只屏蔽「正文没写却被凭空画出来」的单品。
 * 正文明确写了黑丝/短裙/牛仔裤,这个世界观就得让路——正文优先于世界观默认。
 */
function guardrailNegatives(world: WorldAnchorConfig | undefined, positive: string[]): string[] {
  if (!world) return [];
  const lower = positive.map(tag => tag.toLowerCase());
  return splitTags(world.negativeGuardrails).filter(word => {
    const w = word.toLowerCase();
    return !lower.some(tag => tag === w || tag.split(/\s+/).includes(w) || tag.includes(w));
  });
}

export function assembleImageCharacters(
  image: ImageInsertion,
  entriesAtPos: CharTagEntry[],
  outfitsAtPos: Map<string, CharOutfitState>,
  world?: WorldAnchorConfig,
): ImageInsertion {
  const upperOnly = isUpperOnlyShot(image.tag);
  const femaleIndexes: number[] = [];
  image.characters.forEach((character, index) => {
    const entry = entriesAtPos.find(item => item.name === character.name);
    if (!isMaleEntry(entry, character.tag)) femaleIndexes.push(index);
  });

  // 站+坐/跪的高低差画面,NAI 特别容易把站着的画成巨人、坐着的缩成小人。
  const allTags = [image.tag, ...image.characters.map(item => item.tag)].join(', ');
  const heightGapShot = HEIGHT_GAP_SHOT.test(allTags) && STANDING_TAG.test(allTags);
  const characters: ImageCharacterPrompt[] = image.characters.map((character, index) => {
    const entry = entriesAtPos.find(item => item.name === character.name);
    if (isMaleEntry(entry, character.tag)) {
      const maleTag = dropLocalizedMarkers(splitTags(character.tag)).join(', ');
      const male: ImageCharacterPrompt = { name: character.name, tag: maleTag, nl: character.nl };
      if (character.uc) male.uc = character.uc;
      return male;
    }

    const fixedTags = buildFixedAppearanceTags(entry, character.omitFeatures);
    const outfitState = outfitsAtPos.get(character.name);
    const compiledOutfit = compileOutfitForFrame(outfitState, upperOnly);
    // 状态表说「穿着」、导演说「裸着」时必须有一方认输:这里让状态表赢。
    // 原因是状态表逐楼回放、有历史依据,导演这一格只看到本段文字,最容易写反。
    const cover = describeCoverage(outfitState);
    const fallbackOutfit =
      !outfitsAtPos.get(character.name) && entry?.fields.outfit.trim()
        ? splitTags(entry.fields.outfit)
        : [];
    // 景别裁切必须在合流之后做：外貌里的腿型词与 hosiery 里的鞋子词都可能来自任意一路。
    // 服装层的 tag 本身可能带逗号（"sheer black pantyhose, black leather loafers"），
    // 先拆成原子词再过滤，否则鞋子词会把整串丝袜一起带走。
    const hasLibraryEntry = Boolean(entry?.fields.hair.trim() || entry?.fields.eyes.trim());
    const hasOutfitState = Boolean(outfitState);
    const directorTags = resolveCoverConflicts(
      stripLeakedAppearanceAndOutfit(dropLocalizedMarkers(splitTags(character.tag)), hasLibraryEntry, hasOutfitState),
      cover,
    );
    const filtered = dedupeTags(
      [
        ...fixedTags,
        ...compiledOutfit.positive,
        ...fallbackOutfit,
        ...directorTags,
      ].flatMap(tag => splitTags(tag)),
    )
      .filter(tag => !(upperOnly && LEG_ONLY.test(tag)))
      .filter(tag => !(cover.suppressShortSkirt && SHORT_SKIRT.test(tag)));
    const mergedPositive = SHOES_HIDDEN_SHOT.test(image.tag)
      ? filtered.filter(tag => !SHOE_WORD.test(tag))
      : filtered;

    const negativeParts = [
      ...splitTags(character.uc ?? ''),
      ...compiledOutfit.negative,
      ...buildSelfAntiDriftNegative(entry),
      ...guardrailNegatives(world, mergedPositive),
      ...(heightGapShot ? PROPORTION_GUARDRAILS : []),
    ];
    if (femaleIndexes.length >= 2) {
      // mergedPositive 在这个角色里是常量,循环外建一次即可(以前放在内层循环里反复建 Set)
      const ownLower = new Set(mergedPositive.map(tag => tag.toLowerCase()));
      for (const otherIndex of femaleIndexes) {
        if (otherIndex === index) continue;
        const other = image.characters[otherIndex];
        const otherEntry = entriesAtPos.find(item => item.name === other.name);
        for (const feature of extractDistinctiveFeatures(otherEntry)) {
          if (ownLower.has(feature.toLowerCase())) continue;
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

  return { ...image, tag: dropLocalizedMarkers(splitTags(image.tag)).join(', '), characters };
}