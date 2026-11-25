import { reactive } from 'vue';

import { getContext } from '@/st/context';
import type { CharChange } from '@/autoTag/protocol';
import type { CharTagEntry } from '@/state/charTags';
import type { WorldPresetId } from '@/state/worldAnchor';

/**
 * 外貌随机抽卡池（全局，跨聊天共享）。
 *
 * 为什么要有它：模型自己「想」外貌时会偷懒——白/黑/紫发 + 大胸循环，越写越像同一个人。
 * 这里把「可选的封闭词条」摊开给用户看、让用户增删，再由代码 `Math.random()` 真随机抽
 * 几组完整候选包塞进提示词。模型只保留两项权力：正文写死的维度必须服从；正文没写的
 * 维度按人设跨组选择；定档时再与同剧角色比对脸型与眉形。
 *
 * 存储：extensionSettings[TRAIT_POOL_KEY]（→ 服务器 settings.json，跨设备同步）。
 */

export type TraitCategoryKey =
  | 'hairColor'
  | 'hairLength'
  | 'hairTexture'
  | 'hairStyle'
  | 'bangs'
  | 'eyeColor'
  | 'eyeShape'
  | 'faceShape'
  | 'eyebrows'
  | 'skin'
  | 'breastSize'
  | 'bodyBuild'
  | 'faceFeature'
  | 'accessory';

export type TraitScope = 'all' | 'modern' | 'ancient' | 'fantasy';

export interface TraitPoolItem {
  id: string;
  /** 英文 Danbooru 词（发给 NovelAI）。 */
  tag: string;
  /** 中文备注（方便用户看懂，新增时可留空）。 */
  label: string;
  /** 适用世界观，用户自定义新增默认 'all'。 */
  scope: TraitScope;
  /** 开关：禁用后不参与抽卡但保留在列表里。 */
  enabled: boolean;
}

const TRAIT_POOL_KEY = 'xinghui_trait_pool';
const SCHEMA_VERSION = 1;

export interface TraitCategoryMeta {
  key: TraitCategoryKey;
  label: string;
  /** UI 分组：面部与首饰合并展示。 */
  group: 'hair' | 'eyes' | 'body' | 'extra';
}

export const TRAIT_CATEGORIES: TraitCategoryMeta[] = [
  { key: 'hairColor', label: '发色', group: 'hair' },
  { key: 'hairLength', label: '发长', group: 'hair' },
  { key: 'hairTexture', label: '直卷度', group: 'hair' },
  { key: 'hairStyle', label: '扎发', group: 'hair' },
  { key: 'bangs', label: '刘海', group: 'hair' },
  { key: 'eyeColor', label: '瞳色', group: 'eyes' },
  { key: 'eyeShape', label: '眼型', group: 'eyes' },
  { key: 'faceShape', label: '脸部轮廓', group: 'eyes' },
  { key: 'eyebrows', label: '眉形', group: 'eyes' },
  { key: 'skin', label: '肤色', group: 'body' },
  { key: 'breastSize', label: '胸围', group: 'body' },
  { key: 'bodyBuild', label: '体型', group: 'body' },
  { key: 'faceFeature', label: '面部特征', group: 'extra' },
  { key: 'accessory', label: '常驻配饰', group: 'extra' },
];

type DefaultTable = Record<TraitCategoryKey, Array<[string, string, TraitScope?]>>;

const DEFAULTS: DefaultTable = {
  hairColor: [
    ['black hair', '乌黑'],
    ['dark brown hair', '深棕'],
    ['brown hair', '栗棕'],
    ['light brown hair', '奶茶浅棕'],
    ['auburn hair', '红棕'],
    ['orange hair', '姜橘'],
    ['red hair', '绯红'],
    ['wine red hair', '酒红'],
    ['blonde hair', '金发'],
    ['platinum blonde hair', '铂金'],
    ['silver hair', '银白'],
    ['white hair', '雪白'],
    ['grey hair', '灰发'],
    ['dark blue hair', '墨蓝'],
    ['light blue hair', '浅蓝'],
    ['dark green hair', '墨绿'],
    ['pink hair', '樱粉'],
    ['purple hair', '薰衣草紫'],
  ],
  hairLength: [
    ['short hair', '短发'],
    ['medium hair', '中长发'],
    ['long hair', '长发'],
    ['very long hair', '及腰超长发'],
  ],
  hairTexture: [
    ['straight hair', '顺直'],
    ['wavy hair', '微卷'],
    ['curly hair', '大波浪卷'],
    ['messy hair', '蓬松微乱'],
  ],
  hairStyle: [
    ['hair down', '披发'],
    ['high ponytail', '高马尾'],
    ['low ponytail', '低马尾'],
    ['side ponytail', '侧马尾'],
    ['twintails', '双马尾'],
    ['low twintails', '低双马尾'],
    ['single braid', '单麻花辫'],
    ['twin braids', '双麻花辫'],
    ['side braid', '侧麻花辫'],
    ['low bun', '低丸子头'],
    ['single hair bun', '高丸子头'],
    ['double bun', '双丸子头'],
    ['half updo', '半扎发'],
    ['bob cut', '短波波头'],
    ['hime cut', '姬发式'],
    ['wolf cut', '层次狼尾'],
  ],
  bangs: [
    ['blunt bangs', '齐刘海'],
    ['parted bangs', '中分/八字刘海'],
    ['side-swept bangs', '斜刘海'],
    ['wispy bangs', '碎刘海'],
    ['hair over one eye', '遮单眼刘海'],
    ['short bangs', '眉上短刘海'],
    ['forehead', '露额头'],
    ['see-through bangs', '空气刘海'],
  ],
  eyeColor: [
    ['black eyes', '黑瞳'],
    ['brown eyes', '深棕'],
    ['amber eyes', '琥珀'],
    ['yellow eyes', '金瞳'],
    ['blue eyes', '蓝瞳'],
    ['aqua eyes', '冰蓝'],
    ['green eyes', '绿瞳'],
    ['emerald eyes', '翠绿'],
    ['purple eyes', '紫瞳'],
    ['red eyes', '红瞳'],
    ['pink eyes', '粉瞳'],
    ['grey eyes', '灰银'],
    ['heterochromia', '异色瞳', 'fantasy'],
  ],
  eyeShape: [
    ['tsurime', '上挑御姐眼'],
    ['tareme', '下垂温柔眼'],
    ['jitome', '冷淡半眯眼'],
    ['sanpaku', '三白眼'],
    ['narrowed eyes', '狭长媚眼'],
    ['big eyes', '圆润大眼'],
  ],
  faceShape: [['round face', '圆脸'], ['oval face', '鹅蛋脸'], ['angular face', '棱角分明'], ['heart-shaped face', '心形脸'], ['high cheekbones', '高颧骨']],
  eyebrows: [['arched eyebrows', '弧形眉'], ['straight eyebrows', '平直眉'], ['thick eyebrows', '浓眉'], ['thin eyebrows', '细眉'], ['short eyebrows', '短眉']],
  skin: [
    ['pale skin', '冷白皮'],
    ['fair skin', '白皙'],
    ['light skin', '暖白自然'],
    ['tan', '健康小麦/微黑皮'],
    ['dark skin', '古铜深麦皮'],
  ],
  breastSize: [
    ['flat chest', '平胸'],
    ['small breasts', '小胸'],
    ['medium breasts', '匀称中胸'],
    ['large breasts', '大胸'],
    ['huge breasts', '丰满巨乳'],
  ],
  bodyBuild: [
    ['petite', '娇小'],
    ['slender', '纤细'],
    ['slim', '匀称'],
    ['athletic, toned', '运动紧致'],
    ['tall female', '高挑'],
    ['curvy', '丰腴曲线'],
    ['voluptuous, wide hips', '成熟丰满'],
    ['mature female', '成熟御姐'],
  ],
  faceFeature: [
    ['mole under eye', '泪痣'],
    ['mole under mouth', '唇下美人痣'],
    ['mole on neck', '颈侧痣'],
    ['freckles', '雀斑'],
    ['fang', '小虎牙'],
    ['ahoge', '呆毛'],
    ['long eyelashes', '长睫毛'],
    ['pointy ears', '精灵尖耳', 'fantasy'],
    ['forehead mark', '眉心花钿', 'ancient'],
    ['scar across eye', '眼部小疤', 'ancient'],
  ],
  accessory: [
    ['round eyewear', '圆框眼镜', 'modern'],
    ['semi-rimless eyewear', '半框眼镜', 'modern'],
    ['rimless eyewear', '无框眼镜', 'modern'],
    ['choker', '颈链', 'modern'],
    ['necklace', '细项链'],
    ['pearl necklace', '珍珠项链'],
    ['stud earrings', '耳钉'],
    ['drop earrings', '长流苏耳环'],
    ['hoop earrings', '圆环耳环', 'modern'],
    ['hair ribbon', '发带蝴蝶结'],
    ['hairclip', '发夹'],
    ['hairband', '发箍'],
    ['ribbon', '丝带发绳'],
    ['hairpin, hair ornament', '古风发簪', 'ancient'],
    ['kanzashi', '发钗步摇', 'ancient'],
    ['jade pendant', '玉佩', 'ancient'],
  ],
};

function slug(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** 内置默认词库（深拷贝，调用方可随意改）。 */
export function defaultTraitPool(): Record<TraitCategoryKey, TraitPoolItem[]> {
  const pool = {} as Record<TraitCategoryKey, TraitPoolItem[]>;
  for (const category of TRAIT_CATEGORIES) {
    pool[category.key] = DEFAULTS[category.key].map(([tag, label, scope]) => ({
      id: `${category.key}:${slug(tag)}`,
      tag,
      label,
      scope: scope ?? 'all',
      enabled: true,
    }));
  }
  return pool;
}

export const traitPool = reactive<Record<TraitCategoryKey, TraitPoolItem[]>>(defaultTraitPool());

export function emptyTraitPool(): Record<TraitCategoryKey, TraitPoolItem[]> {
  const pool = {} as Record<TraitCategoryKey, TraitPoolItem[]>;
  for (const category of TRAIT_CATEGORIES) pool[category.key] = [];
  return pool;
}

const SCOPES: TraitScope[] = ['all', 'modern', 'ancient', 'fantasy'];

function normalizeItem(raw: unknown, category: TraitCategoryKey): TraitPoolItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const tag = typeof record.tag === 'string' ? record.tag.trim().replace(/[\r\n]+/g, ' ') : '';
  if (!tag) return null;
  const scope = typeof record.scope === 'string' && SCOPES.includes(record.scope as TraitScope)
    ? (record.scope as TraitScope)
    : 'all';
  const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : `${category}:${slug(tag)}`;
  return {
    id,
    tag,
    label: typeof record.label === 'string' ? record.label.trim() : '',
    scope,
    enabled: record.enabled !== false,
  };
}

function normalizePool(raw: unknown): Record<TraitCategoryKey, TraitPoolItem[]> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const saved = raw as Record<string, unknown>;
  const record = saved.categories && typeof saved.categories === 'object' && !Array.isArray(saved.categories)
    ? saved.categories as Record<string, unknown> : saved;
  const pool = emptyTraitPool();
  let filled = false;
  for (const category of TRAIT_CATEGORIES) {
    const list = record[category.key];
    if (!Array.isArray(list)) {
      if (category.key === 'faceShape' || category.key === 'eyebrows') pool[category.key] = defaultTraitPool()[category.key];
      continue;
    }
    filled = true;
    const seen = new Set<string>();
    for (const item of list) {
      const normalized = normalizeItem(item, category.key);
      if (!normalized || seen.has(normalized.id)) continue;
      seen.add(normalized.id);
      pool[category.key].push(normalized);
    }
  }
  return filled ? pool : null;
}

/** ST 就绪后调用一次；可安全重复调用。 */
export function hydrateTraitPool(): void {
  const ctx = getContext();
  const stored = ctx?.extensionSettings?.[TRAIT_POOL_KEY];
  const pool = normalizePool(stored);
  const source = pool ?? defaultTraitPool();
  for (const category of TRAIT_CATEGORIES) {
    traitPool[category.key] = source[category.key];
  }
}

function persist(): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  ctx.extensionSettings[TRAIT_POOL_KEY] = {
    schemaVersion: SCHEMA_VERSION,
    categories: JSON.parse(JSON.stringify(traitPool)),
  };
  ctx.saveSettingsDebounced?.();
}

export function saveTraitPool(): void {
  persist();
}

export function resetTraitPool(): void {
  const defaults = defaultTraitPool();
  for (const category of TRAIT_CATEGORIES) traitPool[category.key] = defaults[category.key];
  persist();
}

export function toggleTraitItem(category: TraitCategoryKey, id: string): void {
  const item = traitPool[category].find(entry => entry.id === id);
  if (!item) return;
  item.enabled = !item.enabled;
  persist();
}

export function removeTraitItem(category: TraitCategoryKey, id: string): void {
  traitPool[category] = traitPool[category].filter(entry => entry.id !== id);
  persist();
}

/** 新增词条：英文 tag 支持逗号一次批量加多个；中文备注只有一条时给第一个用。 */
export function addTraitItems(category: TraitCategoryKey, label: string, rawTags: string): number {
  const tags = rawTags
    .split(/[,，\n]/)
    .map(tag => tag.trim())
    .filter(Boolean);
  if (!tags.length) return 0;
  const existing = new Set(traitPool[category].map(item => item.id));
  let added = 0;
  for (const tag of tags) {
    let id = `${category}:${slug(tag)}`;
    let suffix = 2;
    while (existing.has(id)) id = `${category}:${slug(tag)}-${suffix++}`;
    existing.add(id);
    traitPool[category].push({
      id,
      tag,
      label: added === 0 ? label.trim() : '',
      scope: 'all',
      enabled: true,
    });
    added += 1;
  }
  if (added) persist();
  return added;
}

/** 世界观 → 允许的 scope 集合。 */
export function scopesForPreset(preset: WorldPresetId | string): TraitScope[] {
  switch (preset) {
    case 'chinese_ancient':
    case 'retro_republic':
      return ['all', 'ancient'];
    case 'western_fantasy':
      return ['all', 'fantasy', 'modern'];
    case 'urban_fantasy':
    case 'scifi_cyberpunk':
      return ['all', 'fantasy', 'modern'];
    default:
      return ['all', 'modern'];
  }
}

export interface TraitCandidate {
  hair: string;
  eyes: string;
  skin: string;
  body: string;
  extra: string;
}

const USAGE_BUCKETS: Array<keyof TraitCandidate> = ['hair', 'eyes', 'skin', 'body', 'extra'];

function inventoryUsage(entries: CharTagEntry[]): Map<string, number> {
  const usage = new Map<string, number>();
  for (const entry of entries) {
    for (const key of USAGE_BUCKETS) {
      const value = entry.fields[key] ?? '';
      for (const token of value.split(',')) {
        const word = token.trim().toLowerCase();
        if (!word) continue;
        usage.set(word, (usage.get(word) ?? 0) + 1);
        // 档案允许 "long black hair"，候选池里的颜色词是 "black hair"。
        const composite = key === 'hair' && word.match(/^(very long|long|medium|short) (.+ hair)$/);
        if (composite) {
          for (const trait of [composite[1] + ' hair', composite[2]]) {
            usage.set(trait, (usage.get(trait) ?? 0) + 1);
          }
        }
      }
    }
  }
  return usage;
}

/** 优先抽「用得最少」的：先算最小使用次数，再在该层里随机。 */
function pick(items: TraitPoolItem[], usage: Map<string, number>, taken: Set<string>): TraitPoolItem | null {
  const fresh = items.filter(item => !taken.has(item.tag.toLowerCase()));
  if (!items.length) return null;
  const scored = (fresh.length ? fresh : items).map(item => ({
    item, count: Math.max(...item.tag.toLowerCase().split(/,\s*/).map(word => usage.get(word) ?? 0)),
  }));
  const lowest = Math.min(...scored.map(entry => entry.count));
  const tier = scored.filter(entry => entry.count === lowest).map(entry => entry.item);
  return tier[Math.floor(Math.random() * tier.length)] ?? null;
}

function enabledIn(pool: Record<TraitCategoryKey, TraitPoolItem[]>, category: TraitCategoryKey, allowed: TraitScope[]): TraitPoolItem[] {
  return (pool[category] ?? []).filter(item => item.enabled && allowed.includes(item.scope));
}

/**
 * 真随机抽 3 组互不重复的完整候选外貌包。
 * 只抽「启用 + 适配当前世界观」的词条，并优先避开已建档角色用过的词。
 */
export function rollTraitCandidates(
  worldPreset: WorldPresetId | string,
  existingEntries: CharTagEntry[] = [],
  count = 3,
  pool: Record<TraitCategoryKey, TraitPoolItem[]> = traitPool,
): TraitCandidate[] {
  const allowed = scopesForPreset(worldPreset);
  const usage = inventoryUsage(existingEntries);
  const taken = new Set<string>();
  const draw = (key: TraitCategoryKey) => {
    let items = enabledIn(pool, key, allowed);
    // 年龄不是体态抽签项。只有原文、人物卡或用户指定才决定这一维。
    if (key === 'bodyBuild') items = items.filter(item => !/^(?:mature female|adult|child|teenager|elderly)$/i.test(item.tag));
    if (worldPreset === 'chinese_ancient' && key === 'hairColor') {
      const historical = items.filter(item => /^(?:(?:dark |light )?brown|black|grey|white|auburn) hair$/i.test(item.tag)
        || !DEFAULTS.hairColor.some(([tag]) => tag === item.tag));
      if (historical.length) items = historical;
    }
    const item = pick(items, usage, taken);
    if (item) {
      // 同批后面的候选也计入占用；某一维词少时可复用，其他维继续抽。
      taken.add(item.tag.toLowerCase());
      for (const word of item.tag.toLowerCase().split(/,\s*/)) usage.set(word, (usage.get(word) ?? 0) + 1);
    }
    return item;
  };
  const groups: TraitCandidate[] = [];
  const total = Math.max(1, Math.min(6, Math.floor(count)));

  for (let index = 0; index < total; index += 1) {
    const hairColor = draw('hairColor');
    const hairLength = draw('hairLength');
    const hairTexture = draw('hairTexture');
    const hairStyle = draw('hairStyle');
    const bangs = draw('bangs');
    const eyeColor = draw('eyeColor');
    const eyeShape = draw('eyeShape');
    const skin = draw('skin');
    const breastSize = draw('breastSize');
    const bodyBuild = draw('bodyBuild');
    const faceFeature = draw('faceFeature');
    const accessory = draw('accessory');

    const hairParts = [
      hairColor?.tag,
      hairLength?.tag,
      hairTexture?.tag,
      hairStyle?.tag,
      bangs?.tag,
    ].filter(Boolean) as string[];
    const eyeParts = [eyeColor?.tag, eyeShape?.tag].filter(Boolean) as string[];
    const bodyParts = [breastSize?.tag, bodyBuild?.tag].filter(Boolean) as string[];
    const extraParts = [faceFeature?.tag, accessory?.tag].filter(Boolean) as string[];

    if (!hairParts.length && !eyeParts.length && !bodyParts.length && !skin && !extraParts.length) break;
    groups.push({
      hair: hairParts.join(', '),
      eyes: eyeParts.join(', '),
      skin: skin?.tag ?? '',
      body: bodyParts.join(', '),
      extra: extraParts.join(', '),
    });
  }

  return groups;
}

/** 喂给提示词的候选包文本块。 */
export function formatTraitCandidates(groups: TraitCandidate[]): string {
  if (!groups.length) return '（词库为空或全部被禁用：按正文与人设自行决定，但发色与体型必须彼此错开）';
  const lines = groups.map((group, index) => {
    const label = ['甲', '乙', '丙', '丁', '戊', '己'][index] ?? String(index + 1);
    return `候选${label}：hair[${group.hair}]｜eyes[${group.eyes}]｜skin[${group.skin}]｜body[${group.body}]｜extra[${group.extra}]`;
  });
  return lines.join('\n');
}

/** 抽卡 + 格式化，一步到位（提示词与重Roll 共用）。 */
export function traitCandidateBlock(
  worldPreset: WorldPresetId | string,
  existingEntries: CharTagEntry[] = [],
  count = 3,
): string {
  return [
    '【本次代码真随机抽卡候选池（新女角建档 / 重Roll 必用）】',
    formatTraitCandidates(rollTraitCandidates(worldPreset, existingEntries, count)),
    ...FACE_AXES.map(key => (key === 'faceShape' ? '脸部轮廓' : '眉形') + '：' +
      enabledIn(traitPool, key, scopesForPreset(worldPreset)).map(item => item.tag).join(' / ')),
    '正文写死的维度严格照正文；空缺维度可跨候选按人设组合。温婉成熟女性可选柔和眼型、丰腴身形；成熟、婚姻状况或侍女身份本身不能代替性格与体态描写。新原创角色可用 faceOptions 给 2～4 个符合人设且正文允许的轮廓/眉形备选；已明确的特征写入 extra。匿名转真名、同人或要求相貌相同的人物省略 faceOptions。',
  ].join('\n');
}
const FACE_AXES = ['faceShape', 'eyebrows'] as const;
type Look = Partial<TraitCandidate>;
const words = (text = '') => text.toLowerCase().split(',').map(t => t.trim()).filter(Boolean);

/** 优先区分发型、眼型或体态已相似的角色。两项仅从导演认可且用户启用的备选中补入。 */
export function allocateFaceDetails(look: Look, options: unknown, others: Look[], preset: string): string {
  if (!Array.isArray(options)) return look.extra ?? '';
  const proposed = new Set(options.filter((item): item is string => typeof item === 'string').map(item => item.trim().toLowerCase()));
  const extra = words(look.extra);
  const similarities = others.map(other => {
    const overlap = (field: keyof Look) => words(look[field]).filter(t => words(other[field]).includes(t)).length;
    return { extra: words(other.extra), weight: 1 + overlap('hair') * 2 + overlap('eyes') + overlap('body') + overlap('skin') };
  });
  const added: string[] = [];
  for (const axis of FACE_AXES) {
    const fixed = [...extra, ...words(look.eyes), ...words(look.body)];
    const described = axis === 'eyebrows' ? /\b(?:eyebrows?|brows?)\b/i : /\b(?:face|cheekbones|jawline)\b/i;
    if (fixed.some(word => described.test(word)) || traitPool[axis].some(item => fixed.includes(item.tag.toLowerCase()))) continue;
    const enabled = enabledIn(traitPool, axis, scopesForPreset(preset));
    // 同占用时保留导演按人设给出的优先顺序。
    const choices = [...proposed].flatMap(tag => enabled.find(item => item.tag.toLowerCase() === tag) ?? []);
    const scores = choices.map(item => ({
      item, cost: similarities.reduce((sum, other) => sum + (other.extra.includes(item.tag.toLowerCase()) ? other.weight : 0), 0),
    }));
    scores.sort((a, b) => a.cost - b.cost);
    if (scores.length) added.push(scores[0].item.tag);
  }
  return [look.extra, ...added].filter(Boolean).join(', ');
}

export function allocateNewProfileFaces(changes: CharChange[], entries: CharTagEntry[], preset: string): void {
  const assigned = new Map<string, Look>(entries.map(entry => [entry.name, entry.fields]));
  const profiles = changes.filter(change => change.field === 'new' && change.value.startsWith('{'))
    .sort((a, b) => Number(Boolean(a.faceOptions?.length)) - Number(Boolean(b.faceOptions?.length)) || a.sourceLine - b.sourceLine);
  for (const profile of profiles) {
    if (assigned.has(profile.name)) continue;
    // parseImagePlan 只保留已归一化的建档 JSON，旧镜头复用的档案也由 JSON.stringify 构造。
    const fields = JSON.parse(profile.value) as Look & { fandom?: string };
    if (profile.faceOptions?.length && !fields.fandom) {
      const extra = allocateFaceDetails(fields, profile.faceOptions, [...assigned.values()], preset);
      if (extra !== (fields.extra ?? '')) profile.value = JSON.stringify({ ...fields, extra });
      fields.extra = extra;
    }
    assigned.set(profile.name, fields);
  }
}
