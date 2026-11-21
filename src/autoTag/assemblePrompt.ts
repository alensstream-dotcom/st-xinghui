import type { CharTagEntry } from '@/state/charTags';
import {
  OUTFIT_LAYER_KEYS,
  type CharOutfitState,
  type OutfitLayerKey,
  type OutfitLayerState,
} from '@/state/outfitState';

/**
 * 本地确定性编译器。
 *
 * 分工：模型只做两件它擅长的事——读剧情填「五层服装状态表」，以及当导演挑画面、写表情/视线/动作。
 * **外貌、服装 tag、防复穿、防串色全部由代码拼**，模型不再有机会把「她的白衬衫」写到别人身上，
 * 也不会因为上下文里出现过「白衬衫」就在下一格又给她穿回去。
 *
 * 这样做的代价是灵活性：代码只能拼它认识的形状。所以每条规则都写成「拿不到就不写」，
 * 而不是「拿不到就猜一个」——猜出来的 tag 会直接画错。
 */

export interface DirectorCharacter {
  name: string;
  /** 这一格看不见的身体部位（face/hair/eyes/skin/body），用来剥固定外貌。 */
  omitFeatures?: string[];
  /** 表情 tag（英文，可空）。 */
  expression?: string;
  /** 视线/朝向 tag（英文，可空）。 */
  gaze?: string;
  /** 动作，一句简短英文（可空）。 */
  action?: string;
  /** 施动者名字：动作由谁做（可空）。 */
  source?: string;
  /** 受动者名字：动作落在谁身上（可空）。 */
  target?: string;
}

export interface AssembleInput {
  entries: CharTagEntry[];
  /** 该 P 节点那一刻的五层服装状态。 */
  outfit: Map<string, CharOutfitState>;
  director: DirectorCharacter[];
  /** 景别（英文 tag，如 "cowboy shot"）。决定下半身/脚是否可见。 */
  scale: string;
}

export interface AssembledCharacter {
  name: string;
  tag: string;
  nl: string;
  /** 角色负面提示词：防复穿、防串色。空串表示不写。 */
  uc: string;
  omitFeatures: string[];
}

const FEATURE_FIELDS = ['hair', 'eyes', 'skin', 'body', 'extra'] as const;

const ONEPIECE = /\b(?:dress|gown|qipao|cheongsam|onepiece|one-piece|jumpsuit|robe)\b/i;
const FULL_BODY = /\b(?:full body|wide shot|whole body|full-length)\b/i;
const THIGH_UP = /\b(?:cowboy shot|medium shot|thigh)\b/i;
const UPPER_ONLY = /\b(?:upper body|portrait|close-?up|face focus|bust)\b/i;

/** 这层在当前景别下看不看得见；看不见就不写，写了只会被模型塞到奇怪的位置。 */
function layerVisibleIn(layer: OutfitLayerKey, scale: string): boolean {
  if (FULL_BODY.test(scale)) return true;
  if (UPPER_ONLY.test(scale)) return layer === 'outer';
  if (THIGH_UP.test(scale)) return layer === 'outer' || layer === 'bottom' || layer === 'panties' || layer === 'bra';
  return true;
}

function layerTokens(state: OutfitLayerState): string[] {
  const tokens = [state.tag, state.stateTag ?? '']
    .join(',')
    .split(',')
    .map(token => token.trim())
    .filter(Boolean);
  return tokens;
}

/** 去掉形容词后的品类词：反穿着用（"black lace bra" → "bra"）。 */
const GARMENT_NOUNS = [
  'bra',
  'panties',
  'underwear',
  'lingerie',
  'shirt',
  'blouse',
  'sweater',
  'jacket',
  'coat',
  'cardigan',
  'skirt',
  'pants',
  'jeans',
  'shorts',
  'dress',
  'stockings',
  'thighhighs',
  'socks',
  'shoes',
  'boots',
];

function layerNouns(state: OutfitLayerState): string[] {
  const text = `${state.tag} ${state.stateTag ?? ''}`.toLowerCase();
  return GARMENT_NOUNS.filter(noun => new RegExp(`\\b${noun}\\b`).test(text));
}

function featureTokens(entry: CharTagEntry | undefined, omit: Set<string>): string[] {
  if (!entry) return [];
  const tokens: string[] = [];
  for (const field of FEATURE_FIELDS) {
    if (omit.has(field)) continue;
    const value = (entry.fields[field] ?? '').trim();
    if (!value) continue;
    tokens.push(...value.split(',').map(token => token.trim()).filter(Boolean));
  }
  if (!tokens.length && !omit.size && entry.raw.trim()) {
    tokens.push(...entry.raw.split(',').map(token => token.trim()).filter(Boolean));
  }
  return tokens;
}

function bloodlineTag(entry: CharTagEntry | undefined): string[] {
  const sex = (entry?.fields.sex ?? '').toLowerCase();
  if (/\b(?:1boy|male|man|boy)\b/.test(sex)) return ['1boy'];
  if (/\b(?:1girl|female|woman|girl)\b/.test(sex)) return ['1girl'];
  return [];
}

function dedupe(tokens: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    const key = token.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
}

/**
 * 五层 → 可见衣物 tag。
 *
 * - worn：直接写这层。
 * - disheveled：写这层 + 形态词（"shirt, unbuttoned, off shoulder"）。
 * - removed：**不写这层**，改写成「这层不在身上」的证明（"no panties"）；
 *   同时把品类词放进 uc，阻止 NAI 按常识把内裤画回来。
 *
 * 连身裙/旗袍这类一件式：只要下装还在身上且是连身，胸罩与内裤一律不写，
 * 除非它们自己处于 disheveled/removed（说明是真的露出来了）。
 */
function garmentTokens(outfit: CharOutfitState | undefined, scale: string, floorLine: string[]): {
  tokens: string[];
  negatives: string[];
} {
  if (!outfit) return { tokens: [], negatives: [] };
  const tokens: string[] = [];
  const negatives: string[] = [];
  const bottom = outfit.layers.bottom;
  const onepiece = ONEPIECE.test(bottom.tag) && bottom.status !== 'removed';
  // 景别裁掉下半身时，内裤/袜子不该出现——但「没穿」这件事仍然要留在 uc 里，
  // 否则同一个角色在下一张半身图里会被 NAI 自动补上内裤。
  const textLine = floorLine.join(', ');

  for (const layer of OUTFIT_LAYER_KEYS) {
    const state = outfit.layers[layer];
    if (!state.tag.trim() && state.status !== 'removed') continue;
    const visible = layerVisibleIn(layer, scale);
    const nouns = layerNouns(state);

    if (state.status === 'removed') {
      if (visible && nouns.length) tokens.push(`no ${nouns[0]}`);
      // 「她说自己没穿」但正文点名了这件衣物：以正文为准，别再加反向词。
      if (nouns.length && !textLine.toLowerCase().includes(nouns[0])) negatives.push(...nouns);
      continue;
    }

    if ((layer === 'bra' || layer === 'panties') && onepiece && state.status === 'worn') continue;
    if (!visible) {
      // 看不见也要防复穿：半身图里把「她穿着牛仔裤」的裤腿截掉，NAI 可能凭空补一条裙子。
      if (nouns.length) negatives.push(...nouns.slice(0, 1));
      continue;
    }

    tokens.push(...layerTokens(state));
  }

  return { tokens, negatives };
}

export function assembleCharacterPrompt(
  input: AssembleInput,
  character: DirectorCharacter,
  others: DirectorCharacter[],
): AssembledCharacter {
  const entry = input.entries.find(item => item.name === character.name);
  const omitFeatures = (character.omitFeatures ?? [])
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
  const omit = new Set(omitFeatures);

  const outfit = input.outfit.get(character.name);
  const garment = garmentTokens(outfit, input.scale, [character.action ?? '']);

  const tokens: string[] = [
    ...bloodlineTag(entry),
    ...featureTokens(entry, omit),
    ...garment.tokens,
    ...(character.expression ? character.expression.split(',').map(t => t.trim()) : []),
    ...(character.gaze ? character.gaze.split(',').map(t => t.trim()) : []),
  ];

  const negatives = new Set(garment.negatives.map(item => item.toLowerCase()));

  // 多人防串色：别人身上有、而她身上没有的衣物品类，进她的 uc。
  // 自己也在穿的品类必须排除——否则「两人都穿白衬衫」时，她的正向写着 shirt、
  // uc 里又压着 shirt，等于自己把自己的衣服抹掉。
  const ownNouns = new Set<string>();
  if (outfit) {
    for (const layer of OUTFIT_LAYER_KEYS) {
      const state = outfit.layers[layer];
      if (state.status === 'removed') continue;
      for (const noun of layerNouns(state)) ownNouns.add(noun.toLowerCase());
    }
  }
  for (const other of others) {
    if (other.name === character.name) continue;
    const otherOutfit = input.outfit.get(other.name);
    if (!otherOutfit) continue;
    for (const layer of OUTFIT_LAYER_KEYS) {
      const state = otherOutfit.layers[layer];
      if (state.status === 'removed') continue;
      for (const noun of layerNouns(state)) {
        const key = noun.toLowerCase();
        if (ownNouns.has(key) || negatives.has(key)) continue;
        negatives.add(key);
      }
    }
  }

  const nl = composeNaturalLanguage(character, input, others);

  return {
    name: character.name,
    tag: dedupe(tokens).join(', '),
    nl,
    uc: [...negatives].join(', '),
    omitFeatures,
  };
}

/** 一句英文：谁对谁做了什么，落到哪个空间位置。写不长也不写空。 */
function composeNaturalLanguage(
  character: DirectorCharacter,
  input: AssembleInput,
  others: DirectorCharacter[],
): string {
  const action = (character.action ?? '').trim();
  if (!action) return '';
  const target = (character.target ?? '').trim();
  const source = (character.source ?? '').trim();
  const role =
    source && source !== character.name
      ? `receives`
      : target && target !== character.name
        ? `does it to ${target}`
        : '';
  const pieces = [action.replace(/[.。]+$/, '')];
  if (role === 'receives' && source) pieces.unshift(`as ${source} `);
  if (role.startsWith('does it to')) pieces.push(`toward ${target}`);
  void others;
  const sentence = pieces.join(' ').replace(/\s+/g, ' ').trim();
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

export function assembleImagePrompts(input: AssembleInput): AssembledCharacter[] {
  return input.director.map(character =>
    assembleCharacterPrompt(input, character, input.director),
  );
}

/**
 * 把各角色块里的 `1girl` / `1boy` 累加成 NAI 认的人数词。
 *
 * 之先去重成一个 `1girl`,双女主图会被画成一个人。这里按性别分开数,再加 `s`,
 * 顺序与 NAI 惯例一致（girls 在前、boys 在后），单人仍输出 `1girl` / `1boy`。
 */
export function countHeadcounts(characterTags: string[]): string[] {
  let girls = 0;
  let boys = 0;
  let others = 0;
  for (const tag of characterTags) {
    for (const token of tag.split(',')) {
      const trimmed = token.trim().toLowerCase();
      const matched = /^(\d+)(girl|boy|other)s?$/.exec(trimmed);
      if (!matched) continue;
      const amount = Number(matched[1]) || 1;
      if (matched[2] === 'girl') girls += amount;
      else if (matched[2] === 'boy') boys += amount;
      else others += amount;
    }
  }
  const counts: string[] = [];
  if (girls === 1) counts.push('1girl');
  else if (girls > 1) counts.push(`${girls}girls`);
  if (boys === 1) counts.push('1boy');
  else if (boys > 1) counts.push(`${boys}boys`);
  if (others === 1) counts.push('1other');
  else if (others > 1) counts.push(`${others}others`);
  return counts;
}
