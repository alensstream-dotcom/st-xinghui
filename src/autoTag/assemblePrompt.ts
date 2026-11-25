import { ageBand, profileAge, RELATION_TAG, resolveVisualSubjects } from './visualIdentity';
import type { ImageCharacterPrompt, ImageInsertion } from '@/autoTag/protocol';
import type { CharTagEntry } from '@/state/charTags';
import type { CharacterWardrobe, SlotWearStatus, WardrobeSlotKey } from '@/state/outfitState';
import type { WorldAnchorConfig } from '@/state/worldAnchor';

/** 角色提示依次使用当刻的固定外貌、可见衣物与导演描述。 */

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
const SHOE_WORD = /\b(?:flats|flat shoes?|heels?|high heels?|shoes?|boots?|sneakers?|sandals?|loafers?|pumps?|mary janes?|slippers?)\b/i;
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
/**
 * 眼部**表情**词：虽然含 eyes，但它们描述的是这一格的表情，不是瞳色眼型。
 * 旧写法只按 \beyes\b 剥，把闭眼、半眯、眯眼、含泪这些合法表情一起吞掉了。
 */
const EYE_EXPRESSION_TAG = /^(?:closed eyes|half-closed eyes|wide-eyed|teary eyes|watery eyes|rolling eyes|empty eyes|narrowed eyes)$/i;
const STATIC_BODY_TAG = /\b(tall female|petite|slender|curvy|voluptuous|flat chest|small breasts|medium breasts|large breasts|huge breasts|wide hips|long legs)\b/i;
/** 这些词说明这一格正在发生接触（手在头发里、抓着衣领），属于动作，不算外貌声明。 */
/** 以衣物名词判槽位，颜色与面料是开放词表。账本没有该层时仍容许导演提供该件衣物。 */
function wardrobeOwnsTag(tag: string, wardrobe: CharacterWardrobe | undefined): boolean {
  if (!wardrobe || tag.includes('#') || ACTION_TOUCH_TAG.test(tag)) return false;
  if (/^(?:topless|bare torso|bare chest|bare breasts|nipples|no bra|bra only)$/i.test(tag)) {
    return Boolean(wardrobe.outer || wardrobe.top || wardrobe.innerTop);
  }
  if (/^(?:bottomless|no panties|panties only)$/i.test(tag)) {
    return Boolean(wardrobe.bottom || wardrobe.innerBottom || ONEPIECE_GARMENT.test(wardrobe.top?.tag ?? ''));
  }
  if (/^(?:nude|naked|fully nude|completely naked|clothing removed)$/i.test(tag)) {
    return Boolean(wardrobe.outer || wardrobe.top || wardrobe.bottom || wardrobe.innerTop || wardrobe.innerBottom);
  }

  if (/\b(?:underwear|lingerie)$/i.test(tag)) return Boolean(wardrobe.outer || wardrobe.top || wardrobe.bottom || wardrobe.innerTop || wardrobe.innerBottom);
  if (/\b(?:bra|bralette|brassiere|bikini top)$/i.test(tag)) return Boolean(wardrobe.outer || wardrobe.top || wardrobe.innerTop);
  if (/\b(?:panties|briefs|thong)$/i.test(tag)) return Boolean(wardrobe.bottom || wardrobe.innerBottom || ONEPIECE_GARMENT.test(wardrobe.top?.tag ?? ''));
  if (/\b(?:shirt|tee|blouse|sweater|turtleneck|camisole|tank top|dress|nightgown|robe|coat|jacket|blazer|hoodie|cardigan|hanfu)$/i.test(tag)) return Boolean(wardrobe.outer || wardrobe.top);
  if (/\b(?:skirt|pants|shorts|jeans|trousers)$/i.test(tag)) return Boolean(wardrobe.bottom || ONEPIECE_GARMENT.test(wardrobe.top?.tag ?? ''));
  if (/\b(?:stockings|pantyhose|socks|thighhighs)$/i.test(tag)) return Boolean(wardrobe.legs);
  if (SHOE_WORD.test(tag)) return Boolean(wardrobe.shoes || wardrobe.legs);
  return false;
}
const ACTION_TOUCH_TAG = /\b(hand|hands|holding|touching|grabbing|pulling|lifting|unbuttoning|pressed|against|around|on her|on his)\b/i;

/** 补充性着装从句交给本格衣层，保留道具归属、动作和相邻的独立句。 */
function trimWardrobeAside(text: string, wardrobe: CharacterWardrobe | undefined): string {
  if (!wardrobe || !text) return text;
  const wearing = (clothing: string) => wardrobeOwnsTag(clothing.trim(), wardrobe);
  const withoutLead = text.replace(/^(?:wearing|dressed in) ([^,.;!?]+),\s*/i, (part, clothing: string) => wearing(clothing) ? '' : part);
  return withoutLead.replace(/,?\s+(?:while wearing|wearing|dressed in) ([^,.;!?]+)(?=[,.;!?]|$)/gi, (part, clothing: string, offset: number) =>
    wearing(clothing) && !/\b(?:is|was|are|were)$/i.test(withoutLead.slice(0, offset).trim()) ? '' : part);
}

export function stripLeakedAppearance(tags: string[], hasLibraryEntry: boolean): string[] {
  return tags.filter(tag => {
    const token = tag.trim();
    if (!token) return false;
    // 标记词(source#/target#/mutual#)永远是动作,不许动。
    if (token.includes('#')) return true;
    if (EYE_EXPRESSION_TAG.test(token)) return true;
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
/** 槽位全脱/不可见时压掉的同品类词。正面绝不写 `no bra` / `no panties`。 */
const SLOT_NEGATIVES: Record<WardrobeSlotKey, string[]> = {
  // 只压「上衣品类」这一组词。绝不能写 'clothes' 这类核弹词：脱掉上衣但还穿着裙子时，
  // 它会把下装一起屏蔽掉，人被画成裸的。
  outer: ['coat', 'jacket'],
  shoes: ['shoes', 'boots', 'heels'],
  top: ['shirt', 'blouse', 'jacket', 'coat', 'sweater', 'hoodie', 't-shirt', 'dress', 'robe', 'hanfu'],
  innerTop: ['bra', 'underwear', 'bikini top'],
  bottom: ['skirt', 'pants', 'shorts'],
  innerBottom: ['panties', 'underwear'],
  legs: ['pantyhose', 'stockings', 'thighhighs', 'socks'],
};

/** 连身长袍/连衣裙：没有单独下装记录时，下装状态跟着上装走。 */
const ONEPIECE_GARMENT =
  /\b(dress|gown|kimono|yukata|hanfu|robe|cheongsam|qipao|nightgown|bodysuit|leotard|swimsuit|onesie|jumpsuit)\b/i;

export interface CompiledWardrobe {
  positive: string[];
  negatives: string[];
}

interface ResolvedSlot {
  tag: string;
  status: SlotWearStatus;
  halfTag?: string;
  reveal?: 'none' | 'layer';
  offSide?: 'left' | 'right';
}

/**
 * 取某一帧某槽位的有效状态：装备表是基准，本帧 `wearState` 覆盖状态码。
 * 状态码覆盖时一律沿用账本里的 `tag`——这正是「穿回不必重写衣服」的实现点。
 */
function resolveSlot(
  wardrobe: CharacterWardrobe | undefined,
  wearState: ImageCharacterPrompt['wearState'],
  key: WardrobeSlotKey,
): ResolvedSlot | null {
  const base = wardrobe?.[key];
  const override = wearState?.[key];
  if (!base && !override) return null;
  const status: SlotWearStatus = override?.status ?? base?.status ?? 'on';
  const tag = base?.tag ? [base.tag, base.condition].filter(Boolean).join(', ') : '';
  const halfTag = (override?.halfTag || base?.halfTag || '').trim();
  if (!tag && !(status === 'off' && (key === 'innerTop' || key === 'innerBottom'))) return null;
  return { tag, status, halfTag, reveal: override ? undefined : base?.reveal, offSide: override ? undefined : base?.offSide };
}

/**
 * 把装备表编译成这一帧的正向服饰词与角色级负面。
 *
 * 三条确定性规则（不含任何推断，输入只有「槽位 tag + 状态码」）：
 * 1. 外装 `on` 时隐藏内衣——扣好的衬衫下面不该冒出 bra；
 * 2. 外装 `half` 时自动释放内衣——敞开/撩起就看得见了；
 * 3. 槽位 `off` 时压掉同品类词，而不是在正面写 `no bra` 这种反向声明。
 */
export function compileWardrobeForFrame(
  wardrobe: CharacterWardrobe | undefined,
  wearState: ImageCharacterPrompt['wearState'] = undefined,
  upperOnly = false,
): CompiledWardrobe {
  const positive: string[] = [];
  const negatives: string[] = [];
  const push = (value: string | undefined) => {
    if (value) positive.push(value);
  };

  const top = resolveSlot(wardrobe, wearState, 'top');
  const innerTop = resolveSlot(wardrobe, wearState, 'innerTop');
  const bottomRaw = resolveSlot(wardrobe, wearState, 'bottom');
  const innerBottom = resolveSlot(wardrobe, wearState, 'innerBottom');
  const legs = resolveSlot(wardrobe, wearState, 'legs');

  // 连身衣（道袍/汉服/连身裙/旗袍/和服）：只有上装一条记录，但上下可能分别半脱。
  // half_top=只解领口（上身露、下身还被长摆盖着），half_bottom=只掀裙摆（下身露、上身还穿着）。
  const isOnePiece = Boolean(top?.tag && ONEPIECE_GARMENT.test(top.tag));

  const outer = resolveSlot(wardrobe, wearState, 'outer');
  const shoes = resolveSlot(wardrobe, wearState, 'shoes');
  const styledOpen = (slot: ResolvedSlot | null) =>
    Boolean(slot && /\b(?:open[- ]front|open (?:coat|jacket|blazer)|worn open)\b/i.test(slot.tag));
  const outerOpen = canSeeNextLayer(outer, 'top') || styledOpen(outer);
  const coat = outer?.status === 'on' ? outer : top;
  const closedCoat = coat?.status === 'on' && /\b(?:trench coat|overcoat)\b/i.test(coat.tag)
    && !styledOpen(coat) && !/\b(?:open|unzipped|unbuttoned|sheer|transparent|cutout)\b/i.test(coat.tag);
  if (outer && outer.status !== 'off') {
    push(outer.tag);
    if (isHalfStatus(outer.status)) push(outer.halfTag);
  }
  // 外套敞开仍有衬衫，衬衫扣好时继续遮住内衣。
  if (outerOpen && top?.status === 'on') {
    push(top.tag);
  } else if (outerOpen && isHalfStatus(top?.status)) {
    push(top?.tag);
    push(top?.halfTag);
  } else if (top?.status === 'off') {
    negatives.push(...SLOT_NEGATIVES.top);
  }

  // 整齐穿着的风衣需要传达覆盖关系。已知高领打底时，只给镜头可见的领口。
  if (closedCoat) {
    push('closed coat');
    const lining = coat === outer ? top : innerTop;
    const collar = lining?.status === 'on' && splitTags(lining.tag).find(t => /\bturtleneck\b/i.test(t) && !/\b(?:bra|lingerie|bodystocking)\b/i.test(t));
    if (collar && !/\b(?:high collar|high neck|zipped to chin)\b/i.test(coat.tag)) {
      push(collar + ' visible at collar');
    }
  }

  // 上身是否露出：外装不在原位，且这一帧确实是「上身」半脱（half_bottom 只掀裙摆时不算）。
  const upperOpen = canSeeNextLayer(top, 'top', isOnePiece);

  // 只有「确实有上装或内衣记录，且外装不在原位」时才判定露出：完全没有装备记录时
  // 不该替模型断言她裸着（首次出场还没建表，那一格由正文与导演的 outfit 决定）。
  // 内搭**未建档（undefined）**＝正文没交代，同样不猜；只有明确脱了（off）才写裸露词。
  if (outerOpen && (top || innerTop) && upperOpen) {
    if (innerTop?.status === 'on') {
      push(innerTop.tag);
    } else if (isHalfStatus(innerTop?.status)) {
      push(innerTop?.tag);
      push(innerTop?.halfTag);
    } else if (innerTop?.status === 'off' && (!top || top.status === 'off')) {
      positive.push('bare breasts', 'nipples');
      negatives.push(...SLOT_NEGATIVES.innerTop);
    }
  }

  if (outer?.status === 'off') negatives.push(...SLOT_NEGATIVES.outer);
  if (upperOnly) return finishWardrobe(positive, negatives);

  // 下装（连身衣没有 bottom 记录时，状态跟着上装，但只有下身半脱/全脱才判露出）
  const bottom: ResolvedSlot | null =
    bottomRaw ?? (isOnePiece && top ? { ...top, tag: '' } : null);
  const bottomStatus = bottom?.status ?? null;
  const longOuter = Boolean(outer && /\b(?:ankle-length|floor-length|full-length)\b/i.test(outer.tag));
  const outerHemOpen = !longOuter || canSeeNextLayer(outer, 'bottom', true);
  const hemOpen = outerHemOpen && (!isOnePiece || canSeeNextLayer(top, 'bottom', true));
  const lowerOpen = hemOpen && (bottomRaw ? canSeeNextLayer(bottomRaw, 'bottom') : true);

  if (hemOpen && bottom?.tag && bottomStatus === 'on') {
    push(bottom.tag);
  } else if (hemOpen && bottom?.tag && isHalfStatus(bottomStatus)) {
    push(bottom.tag);
    push(bottom.halfTag);
  } else if (bottomStatus === 'off') {
    negatives.push(...SLOT_NEGATIVES.bottom);
  }

  if ((bottom || innerBottom) && lowerOpen) {
    if (innerBottom?.status === 'on') {
      push(innerBottom.tag);
    } else if (isHalfStatus(innerBottom?.status)) {
      push(innerBottom?.tag);
      push(innerBottom?.halfTag);
    } else if (innerBottom?.status === 'off') {
      if (bottomStatus === 'off') positive.push('bottomless');
      negatives.push(...SLOT_NEGATIVES.innerBottom);
    }
  }

  const oldShoeSlot = !shoes && Boolean(legs?.offSide);
  if (!oldShoeSlot) {
    const legTags = shoes && legs ? splitTags(legs.tag).filter(t => !SHOE_WORD.test(t)).join(', ') : legs?.tag;
    if (legs?.status === 'on') push(legTags);
    else if (isHalfStatus(legs?.status) && legs) {
      push(legTags);
      push(legs.halfTag);
    } else if (legs?.status === 'off') negatives.push(...SLOT_NEGATIVES.legs);
  }

  const footwear = oldShoeSlot ? legs : shoes;
  if (footwear?.status === 'off') negatives.push(...SLOT_NEGATIVES.shoes);
  if (footwear && footwear.status !== 'off') {
    if (footwear.offSide) {
      const opposite = footwear.offSide === 'left' ? 'right' : 'left';
      const [item, ...details] = splitTags(footwear.tag);
      const singular = item.replace(/(?:shoes|boots|heels|slippers|sneakers|sandals|loafers|pumps)$/i, tag => tag.slice(0, -1));
      push(singular + ' on ' + opposite + ' foot');
      push(footwear.offSide + ' foot without a shoe');
      details.forEach(push);
    } else {
      push(footwear.tag);
    }
    if (isHalfStatus(footwear.status)) push(footwear.halfTag);
  }
  return finishWardrobe(positive, negatives);
}

function finishWardrobe(positive: string[], negatives: string[]): CompiledWardrobe {
  const visible = positive.join(', ').toLowerCase().split(/[^a-z]+/);
  const visibleUnderwear = visible.some(word => ['panties', 'bra', 'underwear'].includes(word));
  const safe = negatives.filter(word => !visible.includes(word) && !(word === 'underwear' && visibleUnderwear));
  return { positive: dedupeTags(positive), negatives: dedupeTags(safe) };
}

/** 意图明确的敞开与真正露出下摆才透过一层；滑落半边、卷袖、开一颗扣子仍会遮住内搭。 */
function canSeeNextLayer(slot: ResolvedSlot | null, region: 'top' | 'bottom', onePiece = false): boolean {
  if (!slot || slot.status === 'off') return true;
  if (slot.status === 'on' || slot.reveal === 'none') return false;
  const side = halfSide(slot.status, slot.halfTag, onePiece);
  if (side !== 'both' && side !== region) return false;
  if (slot.reveal === 'layer') return true;
  const wear = slot.halfTag ?? '';
  return region === 'top'
    ? /\b(?:open front|front open|fully unbuttoned|fully unzipped|lifted above (?:the )?chest|pulled (?:down below|up above) (?:her |his |the )?(?:bust|chest)|revealing (?:her |his |the )?(?:bra|camisole|shirt))\b/i.test(wear)
    : /\b(?:(?:skirt|dress|robe|hem) (?:lift|lifted|raised|hiked up)|(?:above|over) (?:her |his |the )?hips|revealing (?:her |his |the )?panties)\b/i.test(wear);
}

/** 半脱状态（含连身衣的上下半脱）。 */
export function isHalfStatus(status: string | null | undefined): boolean {
  return status === 'half' || status === 'half_top' || status === 'half_bottom';
}

/**
 * 半脱落在哪一半。
 * - half_top / half_bottom 直接给答案；
 * - 旧值 half 没有侧别：连身衣看 halfTag 有没有裙摆/掀起词，有就算下身，否则按上身；
 *   非连身衣的 half（衬衫敞开、裙子撩起）两半都算，行为与旧版一致。
 */
export function halfSide(
  status: string | null | undefined,
  halfTag: string | undefined,
  onePiece: boolean,
): 'none' | 'top' | 'bottom' | 'both' {
  if (status === 'half_top') return 'top';
  if (status === 'half_bottom') return 'bottom';
  if (status !== 'half') return 'none';
  if (!onePiece) return 'both';
  const detail = halfTag ?? '';
  const lower = /\b(hem|skirt|dress lift|apron lift)\b/i.test(detail);
  const upper = /\b(collar|neckline|unbuttoned|front|chest|shoulders?)\b/i.test(detail);
  if (lower && upper) return 'both';
  return lower ? 'bottom' : upper ? 'top' : 'none';
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

const SHOT_SCALE = /^(?:medium shot|medium close-up|upper body|portrait|close[- ]?up|face focus|cowboy shot|full shot|full body|wide shot|long shot)$/i;
const LOCAL_FOCUS = /^(?:lower body|foot focus|feet focus|ankle focus|hand focus|leg focus|thigh focus|face focus|upper body focus)$/i;
const FULL_POSE = /\b(?:(?:the |straddle |middle |front |side )splits?|m[- ](?:shaped (?:split|pose)|legs)|grabbing (?:own|both|her own|his own) ankles)\b/i;
const DISTANT_DETAIL = /^(?:sanpaku|(?:long|thick|lower) eyelashes|mole (?:on|under|beside) (?:neck|mouth|eye|lip|nose|chin))$/i;
const COMPOSITION_TAG = /^(?:split screen|diptych|triptych|multiple views|multiple angles|inset (?:image|portrait)|character reference sheet|character sheet|portrait inset)$/i;
const CAMERA_ANGLE = /^(?:from side|profile view|front view|from front|three-quarter view|from behind|back view)$/i;

function fitShotToPose(image: ImageInsertion): string {
  const tags = splitTags(image.tag).filter(t => image.singleFrame === false || !COMPOSITION_TAG.test(t));
  const action = [image.tag, image.nl, ...image.characters.flatMap(c => [c.tag, c.nl])].join(', ');
  const local = image.extent === 'detail' || (!image.extent && tags.some(t => LOCAL_FOCUS.test(t)));
  const whole = !local && (image.extent === 'whole' || FULL_POSE.test(action)
    || [image.tag, ...image.characters.map(c => c.tag)].some(raw => splitTags(raw).some(t => /^splits$/i.test(t))));
  const resolution = whole
    ? tags.some(t => /^(?:wide shot|long shot)$/i.test(t)) ? 'wide shot' : 'full body'
    : tags.find(t => SHOT_SCALE.test(t) && (!local || !/^(?:full body|full shot|wide shot|long shot)$/i.test(t)));
  const kept: string[] = [];
  for (const token of tags) {
    if (SHOT_SCALE.test(token) || whole && LOCAL_FOCUS.test(token)) {
      if (resolution && !kept.includes(resolution)) kept.push(resolution);
    } else if (!CAMERA_ANGLE.test(token) || !kept.some(t => CAMERA_ANGLE.test(t))) {
      kept.push(token);
    }
  }
  if (resolution && !kept.includes(resolution)) kept.splice(Math.min(1, kept.length), 0, resolution);
  if (whole && /\b(?:m[- ]legs|m-shaped split|straddle split|middle split)\b/i.test(action)) {
    const side = kept.findIndex(t => /^(?:from side|profile view)$/i.test(t));
    if (side >= 0) kept[side] = 'three-quarter view';
  }
  return kept.join(', ');
}

/**
 * 把导演挑出的这一格编译成最终发给 NAI 的角色块。
 *
 * 顺序固定：固定外貌 → 本帧装备（按景别过滤）→ 导演的动作/表情/视线/标记。
 * uc = 导演 uc + 装备负面 + 防漂移 + 世界观穿帮词 + 高低差比例词 + 同框他人特征。
 * 男角色只留导演给的动作与局部位置，不接外貌、不接装备。
 */
export function assembleImageCharacters(
  image: ImageInsertion,
  entriesAtPos: CharTagEntry[],
  wardrobes: Map<string, CharacterWardrobe> = new Map(),
  world?: WorldAnchorConfig,
  visualSubjects = true,
): ImageInsertion {
  if (visualSubjects) image = resolveVisualSubjects(image, entriesAtPos);
  const tag = visualSubjects ? fitShotToPose(image) : image.tag;
  const footOnly = visualSubjects && /\b(?:foot|feet|ankle|shoe) focus\b/i.test(tag)
    && !/\b(?:full body|wide shot|long shot)\b/i.test(tag);
  const upperOnly = !footOnly && isUpperOnlyShot(tag);
  const shoesHidden = SHOES_HIDDEN_SHOT.test(tag) && !/\b(?:feet|foot|ankle|shoe) focus\b/i.test(tag);
  const distant = splitTags(tag).some(t => /^(?:full body|full shot|wide shot|long shot)$/i.test(t));
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
      const wardrobeGuard = visualSubjects ? guardrailNegatives(world, splitTags(maleTag)) : [];
      const uc = dedupeTags([...splitTags(character.uc ?? ''), ...wardrobeGuard]).join(', ');
      if (uc) male.uc = uc;
      return male;
    }

    const frameTags = dropLocalizedMarkers(splitTags(character.tag));
    const eyesClosed = frameTags.some(tag => /^closed eyes$/i.test(tag));
    const focus = [image.tag, image.nl, character.tag, character.nl].join(', ').toLowerCase();
    const frameBand = ageBand(character.frameAge);
    const archivedBand = ageBand(profileAge(entry));
    const differentAge = frameBand && archivedBand && frameBand !== archivedBand;
    const fixedTags = buildFixedAppearanceTags(entry, character.omitFeatures)
      .filter(t => !visualSubjects || (!RELATION_TAG.test(t)
        && (!frameBand || !ageBand(t) || ageBand(t) === frameBand)))
      .filter(t => !differentAge || !STATIC_BODY_TAG.test(t))
      .filter(t => !distant || !DISTANT_DETAIL.test(t) || focus.includes(t.toLowerCase()))
      .filter(tag => !eyesClosed || !/^(?:narrowed eyes|half-closed eyes|wide-eyed|open eyes)$/i.test(tag));
    const hasLibraryEntry = Boolean(entry);
    const wardrobe = wardrobes.get(character.name);
    const compiled = compileWardrobeForFrame(wardrobe, character.wearState, upperOnly);
    const outfitTags = compiled.positive.flatMap(splitTags).filter(tag => !(upperOnly && LOWER_ONLY.test(tag)));
    const directorTags = stripLeakedAppearance(frameTags, hasLibraryEntry)
      .filter(tag => !wardrobeOwnsTag(tag, wardrobe));

    const visibleInCrop = (t: string) => !(upperOnly && (LEG_ONLY.test(t) || LOWER_ONLY.test(t)))
      && !(shoesHidden && SHOE_WORD.test(t));
    const fixedVisible = footOnly ? fixedTags.filter(t => /^(?:girl|boy|.* skin|tan)$/i.test(t)) : fixedTags;
    const outfitVisible = footOnly ? outfitTags.filter(t => SHOE_WORD.test(t) || /\b(?:foot|feet|ankle|socks?|stockings?|pantyhose|thighhighs)\b/i.test(t)) : outfitTags;
    const mergedPositive = dedupeTags([
      ...fixedVisible.filter(visibleInCrop), ...outfitVisible.filter(visibleInCrop),
      ...directorTags.filter(t => DIRECTOR_MARKER.test(t) || ACTION_TOUCH_TAG.test(t) || visibleInCrop(t)),
    ]);
    const singleShoeOff = mergedPositive.some(tag => /^one (?:shoe|slipper|sandal|boot) off$/i.test(tag)
      || /^(?:left|right) foot without a shoe$/i.test(tag));
    const socksWorn = Boolean(wardrobe?.legs?.status === 'on' && /\b(?:socks?|stockings?|pantyhose|thighhighs)\b/i.test(wardrobe.legs.tag));
    const visiblePositive = mergedPositive.filter(tag => !COMPOSITION_TAG.test(tag) || !visualSubjects || image.singleFrame === false)
      .filter(tag => !(singleShoeOff && socksWorn && /^barefoot$/i.test(tag)))
      .map(tag => singleShoeOff && /^barefoot$/i.test(tag) ? 'one bare foot' : tag);
    const normalize = (value: string) => value.toLowerCase().replace(/(?:^|\s)-?\d+(?:\.\d+)?::|::/g, '').replace(/[_{}\[\]]/g, ' ').replace(/\s+/g, ' ').trim();

    const ownTraits = visiblePositive.map(tag => ` ${normalize(tag)} `);
    const affirms = (trait: string) => ownTraits.some(tag => tag.includes(` ${normalize(trait)} `));
    const negativeParts = [
      ...splitTags(character.uc ?? ''),
      ...compiled.negatives,
      ...(differentAge ? [] : buildSelfAntiDriftNegative(entry).filter(tag => !affirms(tag))),
      ...guardrailNegatives(world, visiblePositive),
      ...(heightGap ? PROPORTION_GUARDRAILS : []),
    ];

    if (femaleIndexes.length >= 2) {
      for (const otherIndex of femaleIndexes) {
        if (otherIndex === index) continue;
        const other = image.characters[otherIndex];
        const otherEntry = entriesAtPos.find(item => item.name === other.name);
        for (const feature of extractDistinctiveFeatures(otherEntry)) {
          if (affirms(feature)) continue;
          negativeParts.push(feature);
        }
      }
    }

    const mergedUc = dedupeTags(negativeParts.filter(t => !visualSubjects || !affirms(t))).join(', ');
    const result: ImageCharacterPrompt = {
      name: character.name,
      tag: visiblePositive.join(', '),
      nl: image.nl && image.nl.trim() === character.nl.trim() ? '' : visualSubjects ? trimWardrobeAside(character.nl, wardrobe) : character.nl,
    };
    if (mergedUc) result.uc = mergedUc;
    return result;
  });

  const allCostumesKnown = femaleIndexes.length && femaleIndexes.every(index => wardrobes.has(image.characters[index].name));
  const baseTag = visualSubjects && allCostumesKnown
    ? splitTags(tag).filter(t => !femaleIndexes.some(index => wardrobeOwnsTag(t, wardrobes.get(image.characters[index].name)))).join(', ')
    : tag;
  const soloWardrobe = image.characters.length === 1 ? wardrobes.get(image.characters[0].name) : undefined;
  const nl = visualSubjects ? trimWardrobeAside(image.nl, soloWardrobe) : image.nl;
  return { ...image, tag: baseTag, nl, characters };
}
