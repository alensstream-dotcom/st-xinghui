import { getContext } from '@/st/context';

/**
 * 本聊天世界观锚点(V2 模块 1)。
 *
 * 为什么要它:同一个「白裙」在现代是连衣裙、在古风是广袖襦裙;同一个角色在古风聊天里
 * 被模型塞了现代眼镜、在科技聊天里被画成汉服,都是因为建档、重Roll、五层服装、立绘、
 * 导演五条链路各自猜世界。这里给它们一个统一的事实来源,存在聊天级元数据里,
 * 不同聊天互不影响。
 */

export type WorldPresetId =
  | 'modern'
  | 'chinese_ancient'
  | 'western_fantasy'
  | 'retro_republic'
  | 'urban_fantasy'
  | 'scifi_cyberpunk'
  | 'custom';

export interface WorldAnchorConfig {
  presetId: WorldPresetId;
  /** true 表示用户手动选定或修改过,后续楼层 AI 不得自动覆盖。 */
  lockedByUser: boolean;
  /** 中文显示名称。 */
  label: string;
  /** 约束建档与重Roll 的发色、配饰与原型边界。 */
  characterGuidelines: string;
  /** 约束五层服装在当前世界观下的具体映射。 */
  outfitMappingHint: string;
  /** 立绘专用极简素色常服(不抄剧情实时穿搭,只保证时代画风一致)。 */
  portraitAttire: string;
  /** 自动附加到立绘与防穿帮场景的负面屏蔽词。 */
  negativeGuardrails: string;
}

export const BBI_WORLD_ANCHOR_KEY = 'bbiWorldAnchor';

type PresetTable = Record<Exclude<WorldPresetId, 'custom'>, Omit<WorldAnchorConfig, 'lockedByUser'>>;

export const WORLD_PRESETS: PresetTable = {
  modern: {
    presetId: 'modern',
    label: '现代日常 / 都市校园',
    characterGuidelines:
      '现代自然发色(黑/棕/栗/浅金)或日系轻小说鲜明发色;原型要鲜明(运动微黑皮/娇小/御姐知性/清纯学生);配饰克制(细框眼镜、耳钉、细项链、发带、泪痣/唇下痣)。禁尖耳、额纹、夸张古风金冠、中世纪铠甲。',
    outfitMappingHint:
      'outer=西装/校服/便服/连衣裙;bra=胸罩/运动内衣;bottom=裙裤;panties=内裤;hosiery=丝袜/长短袜/鞋。用 modern 词汇:blazer, cardigan, T-shirt, jeans, pleated skirt, sneakers, loafers。',
    portraitAttire: 'plain white collared blouse',
    negativeGuardrails: 'hanfu, medieval armor, futuristic armor',
  },
  chinese_ancient: {
    presetId: 'chinese_ancient',
    label: '中式古风 / 仙侠武侠',
    characterGuidelines:
      '发色以黑/墨蓝/银白为主;古典发髻或披发,配精致发簪、步摇、细发带、克制眉心花钿/泪痣;严禁巴洛克/异域巨型金冠大耳环,严禁现代眼镜。',
    outfitMappingHint:
      'outer=广袖外袍/道袍/大袖衫/披帛;bra=交领中衣/肚兜(dudou);bottom=马面裙/襦裙/长裙;panties=丝绸亵裤;hosiery=白绫罗袜/绣花鞋。用古风词汇:hanfu, dudou, mamianqun, silk, embroidered shoes。',
    portraitAttire: 'plain white traditional hanfu, simple cross-collar',
    negativeGuardrails: 'jeans, sneakers, t-shirt, modern clothes, smartphone, modern building',
  },
  western_fantasy: {
    presetId: 'western_fantasy',
    label: '西式奇幻 / 剑与魔法',
    characterGuidelines:
      '可用金/银/红/紫发、异色瞳、尖耳(pointy ears)、精致头饰耳环;气质偏骑士/法师/圣女/游侠。',
    outfitMappingHint:
      'outer=长袍/礼服/轻甲/斗篷;bra=衬衣/束腰(chemise, corset);bottom=长裙/马裤;panties=蕾丝衬裤;hosiery=长筒袜/皮靴。',
    portraitAttire: 'plain white medieval linen blouse',
    negativeGuardrails: 'jeans, sneakers, t-shirt, modern building, skyscraper',
  },
  retro_republic: {
    presetId: 'retro_republic',
    label: '民国 / 复古年代',
    characterGuidelines:
      '乌黑手推波浪卷/低盘发/麻花辫,珍珠耳环,细金丝眼镜,温婉复古眉眼;旗袍或学生装气质,忌现代染发与夸张发色。',
    outfitMappingHint:
      'outer=旗袍(cheongsam)/民国学生装/呢子大衣/披肩;bra=复古丝质内衣/肚兜;bottom=过膝长裙;panties=丝质衬裤;hosiery=丝袜/复古皮鞋。',
    portraitAttire: 'plain light-colored cheongsam, mandarin collar',
    negativeGuardrails: 'sneakers, hoodie, modern skyscraper',
  },
  urban_fantasy: {
    presetId: 'urban_fantasy',
    label: '都市异能 / 现代奇幻 / 妖怪奇谭',
    characterGuidelines:
      '允许现代或传统和风背景与二次元发色、异色瞳、兽耳/狐耳、鬼角、额纹等超自然特征并存;服饰可现代可和风,允许混搭奇幻/战术配饰。',
    outfitMappingHint:
      '按正文实际衣着映射:现代五层(外套/内衣/下装/内裤/袜鞋),或和风(kimono, nagajuban, hakama, tabi);允许混搭。',
    portraitAttire: 'plain white collared shirt',
    negativeGuardrails: '',
  },
  scifi_cyberpunk: {
    presetId: 'scifi_cyberpunk',
    label: '科幻 / 赛博朋克 / 未来',
    characterGuidelines:
      '高对比挑染/渐变发色、霓虹瞳色、战术目镜/耳机/轻度机械饰件;气质偏技术员/佣兵/义体改造者。',
    outfitMappingHint:
      'outer=机能夹克/作战紧身衣(plugsuit, bodysuit);bra=运动内衣;bottom=战术裤/短裙;panties=紧身内裤;hosiery=机能袜/战靴。',
    portraitAttire: 'plain sleek dark turtleneck top',
    negativeGuardrails: 'hanfu, medieval armor',
  },
};

export const WORLD_PRESET_IDS: Exclude<WorldPresetId, 'custom'>[] = [
  'modern',
  'chinese_ancient',
  'western_fantasy',
  'retro_republic',
  'urban_fantasy',
  'scifi_cyberpunk',
];

/** 未识别前的默认:现代。用户没锁定时首楼 AI 可改写。 */
export function defaultWorldAnchor(): WorldAnchorConfig {
  return { ...WORLD_PRESETS.modern, lockedByUser: false };
}

export function isWorldPresetId(value: unknown): value is Exclude<WorldPresetId, 'custom'> {
  return typeof value === 'string' && WORLD_PRESET_IDS.includes(value as Exclude<WorldPresetId, 'custom'>);
}

function normalizeConfig(raw: unknown): WorldAnchorConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<WorldAnchorConfig>;
  const presetId = value.presetId;
  const valid = presetId === 'custom' ? 'custom' : isWorldPresetId(presetId) ? presetId : null;
  if (!valid) return null;
  const base = valid === 'custom' ? { ...defaultWorldAnchor(), presetId: 'custom' as const, label: '自定义' } : WORLD_PRESETS[valid];
  return {
    presetId: valid,
    lockedByUser: Boolean(value.lockedByUser),
    label: typeof value.label === 'string' && value.label.trim() ? value.label.trim() : base.label,
    characterGuidelines:
      typeof value.characterGuidelines === 'string' ? value.characterGuidelines : base.characterGuidelines,
    outfitMappingHint: typeof value.outfitMappingHint === 'string' ? value.outfitMappingHint : base.outfitMappingHint,
    portraitAttire:
      typeof value.portraitAttire === 'string' && value.portraitAttire.trim()
        ? value.portraitAttire.trim()
        : base.portraitAttire,
    negativeGuardrails:
      typeof value.negativeGuardrails === 'string' ? value.negativeGuardrails : base.negativeGuardrails,
  };
}

/** 读当前聊天的世界观锚点;没存过 = 未锁定的现代默认。 */
export function readWorldAnchor(): WorldAnchorConfig {
  const meta = getContext()?.chatMetadata as Record<string, unknown> | undefined;
  return normalizeConfig(meta?.[BBI_WORLD_ANCHOR_KEY]) ?? defaultWorldAnchor();
}

/** 写回当前聊天(只影响本聊天)。 */
export function saveWorldAnchor(config: WorldAnchorConfig): void {
  const ctx = getContext();
  if (!ctx?.chatMetadata) return;
  ctx.chatMetadata[BBI_WORLD_ANCHOR_KEY] = { ...config };
  ctx.saveMetadataDebounced?.();
}

/** 用户手动选择预设:立刻锁定,后续 AI 不得覆盖。 */
export function selectWorldPreset(presetId: Exclude<WorldPresetId, 'custom'>): WorldAnchorConfig {
  const next: WorldAnchorConfig = { ...WORLD_PRESETS[presetId], lockedByUser: true };
  saveWorldAnchor(next);
  return next;
}

/** 切到自定义:以当前配置为底稿,允许用户改三个自由文本。 */
export function toCustomWorldAnchor(current: WorldAnchorConfig): WorldAnchorConfig {
  const next: WorldAnchorConfig = { ...current, presetId: 'custom', label: '自定义', lockedByUser: true };
  saveWorldAnchor(next);
  return next;
}

/**
 * 首楼 AI 识别结果落地。用户锁过就原样返回当前配置(绝不覆盖),否则写回并返回新配置。
 */
export function applyDetectedWorldPreset(presetId: unknown): WorldAnchorConfig {
  const current = readWorldAnchor();
  if (current.lockedByUser) return current;
  if (!isWorldPresetId(presetId)) return current;
  const next: WorldAnchorConfig = { ...WORLD_PRESETS[presetId], lockedByUser: false };
  saveWorldAnchor(next);
  return next;
}

/** 给系统提示词用的紧凑文本块。 */
export function worldAnchorBlock(config: WorldAnchorConfig): string {
  const lines = [
    `世界观:${config.label}${config.lockedByUser ? '(用户已锁定)' : '(自动识别)'}`,
    `角色边界:${config.characterGuidelines}`,
    `服装映射:${config.outfitMappingHint}`,
  ];
  if (config.negativeGuardrails.trim()) lines.push(`防穿帮负面:${config.negativeGuardrails.trim()}`);
  return lines.join('\n');
}

/** 立绘素服的最终取值:角色自己填了固定常服就用它,否则用世界观锚点。 */
export function portraitAttireFor(config: WorldAnchorConfig, entryOutfit?: string): string {
  const own = String(entryOutfit ?? '').trim();
  return own || config.portraitAttire.trim() || WORLD_PRESETS.modern.portraitAttire;
}