import type { ImageCharacterPrompt, ImageInsertion } from '@/autoTag/protocol';
import type { CharTagEntry } from '@/state/charTags';
import type { WorldAnchorConfig } from '@/state/worldAnchor';

/**
 * 本地确定性编译器（服装架构 v2）。
 *
 * 分工是死的，而且各有唯一出处：
 * - 角色库档案：这个人长什么样（发色/发型/瞳色/肤色/体型/配饰），任何一帧都不变；
 * - 导演通道当帧给的 `outfit`：这一格她实际穿成什么样（自由英文词串，全裸给空串）；
 * - 导演通道当帧给的 `removed`：这一格明确脱掉的类目，编译成角色级负面（uc）；
 * - 导演通道的 `tag`：只允许是动作/姿势/表情/视线/source#-target#-mutual# 标记。
 *
 * 这里不再维护五层状态机、不再推断「谁盖住了谁」：上一楼的穿搭指纹由任务 A 交回
 * `finalOutfits`，导演在它基础上写本帧，缺省沿用。编译器只做三件事——拼、剥、压干扰。
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
  const out: string[] = [];
  for (const tag of tags) {
    if (!HAS_CJK.test(tag)) {
      out.push(tag);
      continue;
    }
    // 中文往往和标记黏在同一个 tag 里（"source#李斌抚摸 target#licking nipple"）。
    // 整条丢掉会把后面那条合法的英文标记一起吞掉，所以先按标记边界切开，只扔带中文的那一段。
    for (const chunk of tag.split(/\s+(?=(?:source|target|mutual)#)/i)) {
      const piece = chunk.trim();
      if (!piece || HAS_CJK.test(piece)) continue;
      out.push(piece);
    }
  }
  return out;
}

/** 只在全身/腿长镜头里才有意义的纯下身词：上半身构图写进去会让 NAI 硬塞一双腿。 */
const LEG_ONLY = /\b(?:long legs?|short legs?|slender legs?|thick thighs?|bare legs?|shapely legs?|wide hips?)\b/i;
/** 鞋子类词：半身构图拍不到脚，留着会被画成蜷脚塞进画面。 */
const SHOE_WORD = /\b(?:flats?|heels?|high heels?|shoes?|boots?|sneakers?|sandals?|loafers?|pumps?|mary janes?|slippers?)\b/i;
const SHOES_HIDDEN_SHOT = /\b(?:cowboy shot|medium shot|upper body|close-up|face focus)\b/i;
/** 下半身单品：纯上半身/面部特写里不该出现（否则会硬塞裙摆与丝袜进画面）。 */
const LOWER_ONLY =
  /\b(?:skirt|skirts|miniskirt|microskirt|pleated skirt|skater skirt|pants|jeans|shorts|trousers|pantyhose|stockings|thighhighs|socks|barefoot|feet|footwear|shoes|boots|heels|sneakers|loafers)\b/i;

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
 * 导演通道只能写「这一格正在发生什么」，不能写「这个人长什么样」。
 * 已经建档的女角再写发色/瞳色/体型/性别人数词，就是在和档案抢方向盘——
 * 银发角色被写成 blonde、古风人物被塞进现代身体词，都是这么来的。
 * 服装不在这里剥：本帧穿什么归导演的 outfit 与 removed，编译器另有处理。
 */
const SEX_WORD_TAG = /^(?:1girl|2girls|3girls|multiple girls|1boy|2boys|3boys|multiple boys|girl|boy|solo)$/i;
const HAIR_TAG = /\b(hair|bangs|ponytail|twintails|braid|braids|braided|bun|bob|updo|ahoge)\b/i;
const EYE_SKIN_TAG = /\b(eyes|tsurime|tareme|jitome|sanpaku|pale skin|fair skin|dark skin|tan)\b/i;
const STATIC_BODY_TAG = /\b(tall female|petite|slender|curvy|voluptuous|flat chest|small breasts|medium breasts|large breasts|huge breasts|wide hips|long legs)\b/i;
/** 这些词说明这一格正在发生接触（手在头发里、抓着衣领），属于动作，不算外貌声明。 */
const ACTION_TOUCH_TAG = /\b(hand|hands|holding|touching|grabbing|pulling|lifting|unbuttoning|pressed|against|around|on her|on his)\b/i;

export function stripLeakedAppearance(tags: string[], hasLibraryEntry: boolean): string[] {
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
    return true;
  });
}

const PROPORTION_GUARDRAILS = ['giantess', 'size difference', 'miniature'];
const HEIGHT_GAP_SHOT = /\b(sitting|kneeling|kneel|crouching|lying|floor seat|on lap|seiza)\b/i;
const STANDING_TAG = /\b(standing|walking|leaning forward)\b/i;

/**
 * 高低差构图(一人站、一人坐/跪/躺)的比例防畸变词。
 *
 * 组装期把它加进角色 uc;生成期还要用它压全局负面(Base 层),否则 NAI 仍会把
 * 站着的人拉成巨人、坐着的人缩成小人。判据只此一处,两个阶段共用。
 */
export function proportionGuardrailsFor(text: string): string[] {
  return HEIGHT_GAP_SHOT.test(text) && STANDING_TAG.test(text) ? [...PROPORTION_GUARDRAILS] : [];
}

/**
 * 已脱类目 → 角色级负面。
 *
 * 这是「脱了又穿回去」的总闸：导演说这一格她没穿上衣、胸罩也脱了，那本帧就必须
 * 明确告诉 NAI 别画衬衫和胸罩。以前靠五层状态机互相覆盖判断谁遮住谁，一旦判定
 * 写错就把人画回整套整齐着装；现在按「本帧已脱」直接压品类，判据少、翻车面小。
 */
const REMOVED_RULES: Array<{ test: RegExp; words: string[]; lowerOnly?: boolean }> = [
  {
    test: /\b(?:outer|top|shirt|blouse|dress|robe|hanfu|coat|jacket|sweater|uniform|clothes)\b/,
    words: ['shirt', 'blouse', 'dress', 'coat', 'robe', 'hanfu'],
  },
  {
    test: /\b(?:bra|dudou|brassiere|bikini top)\b/,
    words: ['bra', 'underwear', 'bikini top'],
  },
  {
    test: /\b(?:bottom|skirt|pants|jeans|shorts|trousers)\b/,
    words: ['skirt', 'pants', 'shorts'],
    lowerOnly: true,
  },
  {
    test: /\b(?:panties|underpants|knickers|underwear)\b/,
    words: ['panties', 'underwear'],
    lowerOnly: true,
  },
  {
    test: /\b(?:hosiery|pantyhose|stockings|thighhighs|socks)\b/,
    words: ['pantyhose', 'stockings', 'thighhighs', 'socks'],
    lowerOnly: true,
  },
];

export function buildRemovedNegatives(removed: string[], upperOnly: boolean): string[] {
  const out: string[] = [];
  for (const raw of removed) {
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    for (const rule of REMOVED_RULES) {
      if (!rule.test.test(key)) continue;
      // 上半身/面部特写拍不到下身，把裙裤丝袜写进负面反而会让 NAI 把腿挤进画面。
      if (rule.lowerOnly && upperOnly) continue;
      out.push(...rule.words);
    }
  }
  return dedupeTags(out);
}

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

/**
 * 把导演通道挑出的这一格，编译成最终要发给 NAI 的插入内容。
 *
 * 顺序是固定的：固定外貌 → 导演给的 outfit（按景别过滤）→ 导演给的动作/表情/视线/标记。
 * uc = 导演 uc + 已脱类目负面 + 防漂移 + 世界观穿帮词 + 高低差比例词 + 同框他人特征。
 * 男角色只留导演给的动作与局部位置，不接外貌、不接 outfit。
 * 返回对象里不带 omitFeatures / outfit / removed——那都是一次性开关，序列化进正文只会变脏 tag。
 */
export function assembleImageCharacters(
  image: ImageInsertion,
  entriesAtPos: CharTagEntry[],
  world?: WorldAnchorConfig,
): ImageInsertion {
  const upperOnly = isUpperOnlyShot(image.tag);
  const shoesHidden = SHOES_HIDDEN_SHOT.test(image.tag);
  const femaleIndexes: number[] = [];
  image.characters.forEach((character, index) => {
    const entry = entriesAtPos.find(item => item.name === character.name);
    if (!isMaleEntry(entry, character.tag)) femaleIndexes.push(index);
  });

  const allTags = [image.tag, ...image.characters.map(item => item.tag)].join(', ');
  const heightGap = proportionGuardrailsFor(allTags).length > 0;

  const characters: ImageCharacterPrompt[] = image.characters.map((character, index) => {
    const entry = entriesAtPos.find(item => item.name === character.name);

    if (isMaleEntry(entry, character.tag)) {
      const maleTag = dropLocalizedMarkers(splitTags(character.tag)).join(', ');
      const male: ImageCharacterPrompt = { name: character.name, tag: maleTag, nl: character.nl };
      if (character.uc) male.uc = character.uc;
      return male;
    }

    const fixedTags = buildFixedAppearanceTags(entry, character.omitFeatures);
    const hasLibraryEntry = Boolean(entry?.fields.hair.trim() || entry?.fields.eyes.trim());

    // 本帧穿着完全来自导演给的指纹；景别拍不到的部件先剔掉，否则半身构图会被塞进裙摆丝袜。
    const outfitTags = splitTags(character.outfit ?? '').filter(tag => !(upperOnly && LOWER_ONLY.test(tag)));
    const directorTags = stripLeakedAppearance(dropLocalizedMarkers(splitTags(character.tag)), hasLibraryEntry);

    const mergedPositive = dedupeTags([...fixedTags, ...outfitTags, ...directorTags])
      .filter(tag => !(upperOnly && LEG_ONLY.test(tag)))
      .filter(tag => !(upperOnly && LOWER_ONLY.test(tag)));
    const visiblePositive = shoesHidden ? mergedPositive.filter(tag => !SHOE_WORD.test(tag)) : mergedPositive;

    const negativeParts = [
      ...splitTags(character.uc ?? ''),
      ...buildRemovedNegatives(character.removed ?? [], upperOnly),
      ...buildSelfAntiDriftNegative(entry),
      ...guardrailNegatives(world, visiblePositive),
      ...(heightGap ? PROPORTION_GUARDRAILS : []),
    ];

    if (femaleIndexes.length >= 2) {
      const ownLower = new Set(visiblePositive.map(tag => tag.toLowerCase()));
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
      tag: visiblePositive.join(', '),
      nl: character.nl,
    };
    if (mergedUc) result.uc = mergedUc;
    return result;
  });

  return { ...image, characters };
}