import { describe, expect, it } from 'vitest';
import { assembleImageCharacters } from '@/autoTag/assemblePrompt';
import { prepareTargetText } from '@/autoTag/clean';
import { parseUnifiedPlan } from '@/autoTag/protocol';
import { compileWardrobeSequence } from '@/autoTag/wardrobeSequence';
import { compactGeneratedScene } from '@/autoTag/sceneCompaction';
import { emptyCharFields, type CharTagEntry } from '@/state/charTags';
import { deriveWardrobes, makeWardrobeFloorDelta, type CharacterWardrobe } from '@/state/outfitState';
import { parseImageTagContent, parseImageTags, serializeImageTag } from '@/st/imageTagRegex';

import {
  applyVibes,
  buildNaiParameters,
  BUILTIN_NAI_ARTISTS,
  fullNegativePrompt,
  fullPositivePrompt,
  isBuiltinNaiArtist,
  naiArtistPrompt,
  naiDefaultQualityTags,
  naiDefaultUndesired,
  naiEndpoint,
  naiFixedSettings,
  naiRandomSeed,
  naiSupportsCharacterPrompts,
  naiSupportsVibes,
  parseNaiv4vibe,
  parseResolution,
  skipCfgAboveSigma,
  unzipNaiImage,
  vibeModelKey,
  NaiError,
} from '@/backends/nai';
import type { NaiArtistPreset, NaiModel, NaiRunConfig, NaiVibe, NaiVibeData } from '@/state/settings';
import { strToU8, zipSync } from 'fflate';

/** 一次请求的已解析配置(effectiveNai 的产物);后端只认它,不碰 settings。 */
function nai(overrides: Partial<NaiRunConfig> = {}): NaiRunConfig {
  return {
    endpointId: 'nep_official',
    url: 'https://image.novelai.net',
    key: 'nai-test',
    model: 'nai-diffusion-4-5-full',
    artist: null,
    qualityTags: '',
    undesiredContent: '',
    sampler: 'k_euler',
    steps: 28,
    scale: 5,
    cfgRescale: 0,
    noiseSchedule: 'karras',
    seed: 0,
    varietyBoost: true,
    normalizeRefStrength: true,
    vibes: [],
    portraitSize: '832×1216',
    landscapeSize: '1216×832',
    ...overrides,
  };
}

function vibe(overrides: Partial<NaiVibe> = {}): NaiVibe {
  return {
    id: 'v1',
    name: '测试Vibe',
    dataPath: '/user/files/v1.json',
    thumbnailPath: '/user/files/v1.jpg',
    modelKeys: ['v4-5full'],
    hasImage: true,
    fingerprint: 'v4-5full:ZW5jb2Rpbmc=',
    strength: 0.6,
    group: '',
    ...overrides,
  };
}

function vibeData(overrides: Partial<NaiVibeData> = {}): NaiVibeData {
  return {
    image: 'aW1hZ2U=',
    thumbnail: '',
    encodings: { 'v4-5full': { encoding: 'ZW5jb2Rpbmc=', infoExtracted: 1 } },
    ...overrides,
  };
}

describe('naiEndpoint', () => {
  it('自动补 /ai 前缀', () => {
    expect(naiEndpoint('https://image.novelai.net', 'generate-image')).toBe(
      'https://image.novelai.net/ai/generate-image',
    );
    expect(naiEndpoint('https://mirror.example.com/', 'encode-vibe')).toBe(
      'https://mirror.example.com/ai/encode-vibe',
    );
  });

  it('base 已是完整端点时原样使用', () => {
    expect(naiEndpoint('https://x.com/proxy/ai/generate-image', 'generate-image')).toBe(
      'https://x.com/proxy/ai/generate-image',
    );
  });

  it('空地址报错', () => {
    expect(() => naiEndpoint('  ', 'generate-image')).toThrow(NaiError);
  });
});

describe('parseResolution', () => {
  it('支持 × / x / * 分隔', () => {
    expect(parseResolution('832×1216')).toEqual({ width: 832, height: 1216 });
    expect(parseResolution('1024x1024')).toEqual({ width: 1024, height: 1024 });
  });

  it('拒绝非 64 倍数与非法格式', () => {
    expect(() => parseResolution('830×1216')).toThrow(/64/);
    expect(() => parseResolution('')).toThrow(NaiError);
    expect(() => parseResolution('4096×4096')).toThrow(/范围/);
  });
});

describe('提示词拼装', () => {
  it('使用模型官方质量词并拼到提示词末尾', () => {
    const full = fullPositivePrompt(nai(), '1girl, sitting');
    expect(full).toBe('1girl, sitting, location, very aesthetic, masterpiece, no text');
  });

  it('按模型切换官方质量词', () => {
    expect(fullPositivePrompt(nai({ model: 'nai-diffusion-4-5-curated' }), '1girl')).toBe(
      '1girl, location, masterpiece, no text, -0.8::feet::, rating:general',
    );
  });

  it('负面 = 模型官方默认词', () => {
    const neg = fullNegativePrompt(nai());
    expect(neg).toContain('worst quality');
  });

  it('方案旧字段不参与出图:未选画师串时使用模型官方词', () => {
    expect(fullPositivePrompt(nai({ qualityTags: 'legacy plan quality' }), '1girl')).toBe(
      '1girl, location, very aesthetic, masterpiece, no text',
    );
    expect(fullNegativePrompt(nai({ undesiredContent: 'legacy plan negative' }))).toBe(
      naiDefaultUndesired('nai-diffusion-4-5-full'),
    );
  });

  it('画师串覆盖值留空 = 跟随模型官方词(切模型内容跟着换)', () => {
    // 这是「空串 = 跟随官方」这条存储口径的核心契约
    const artist = { id: 'art_a', name: 'A', prompt: '', quality: '', negative: '' };
    const asFull = fullPositivePrompt(nai({ artist, model: 'nai-diffusion-3' }), '1girl');
    expect(asFull).toBe('1girl, best quality, amazing quality, very aesthetic, absurdres');
    expect(fullNegativePrompt(nai({ artist, model: 'nai-diffusion-3' }))).toContain('{bad}');
  });

  it('画师串纯空白覆盖值等同留空', () => {
    const artist = { id: 'art_a', name: 'A', prompt: '', quality: '   ', negative: '  \n ' };
    expect(fullPositivePrompt(nai({ artist }), '1girl')).toBe(
      '1girl, location, very aesthetic, masterpiece, no text',
    );
    expect(fullNegativePrompt(nai({ artist }))).toBe(naiDefaultUndesired('nai-diffusion-4-5-full'));
  });

  it('未知模型无官方词时回落空串,不抛', () => {
    expect(naiDefaultQualityTags('nai-diffusion-9')).toBe('');
    expect(naiDefaultUndesired('nai-diffusion-9')).toBe('');
    const odd = nai({ model: 'nai-diffusion-9' as NaiModel });
    expect(fullPositivePrompt(odd, '1girl')).toBe('1girl');
    expect(fullNegativePrompt(odd)).toBe('');
  });
});

describe('画师串拼装', () => {
  const preset = (prompt: string, id = 'art_a', extra: Partial<NaiArtistPreset> = {}): NaiArtistPreset => ({
    id,
    name: 'A',
    prompt,
    quality: '',
    negative: '',
    ...extra,
  });

  it('未选画师串 → 输出与本功能上线前逐字节一致(存量用户零变化)', () => {
    expect(fullPositivePrompt(nai(), '1girl')).toBe(
      '1girl, location, very aesthetic, masterpiece, no text',
    );
  });

  it('画师串拼在最前:画师串 → 画面 tag → 质量词', () => {
    const s = nai({ artist: preset('artist:wlop, artist:krenz') });
    expect(fullPositivePrompt(s, '1girl, sitting')).toBe(
      'artist:wlop, artist:krenz, 1girl, sitting, location, very aesthetic, masterpiece, no text',
    );
  });

  it('选中条目内容全空白 → 等同不使用,不留前导逗号', () => {
    // '   ' 是 truthy,filter(Boolean) 兜不住,故 naiArtistPrompt 内部必须 trim
    const s = nai({ artist: preset('   ') });
    expect(fullPositivePrompt(s, '1girl')).toBe(
      '1girl, location, very aesthetic, masterpiece, no text',
    );
  });

  it('与画师串质量词共存,顺序仍是 画师串 → tag → 质量词', () => {
    const s = nai({ artist: preset('artist:a', 'art_a', { quality: 'best quality' }) });
    expect(fullPositivePrompt(s, '1girl')).toBe('artist:a, 1girl, best quality');
  });

  it('naiArtistPrompt 两态:未选 / 选中(选中时首尾空白被去掉)', () => {
    expect(naiArtistPrompt(nai())).toBe('');
    expect(naiArtistPrompt(nai({ artist: preset(' artist:a ') }))).toBe('artist:a');
  });
});

describe('画师串正/负面词', () => {
  const preset: NaiArtistPreset = {
    id: 'art_a',
    name: 'A',
    prompt: 'artist:a',
    quality: 'artist quality',
    negative: 'artist negative',
  };

  it('画师串有值就只使用画师串,方案旧值与官方词都不叠加', () => {
    const s = nai({ artist: preset, qualityTags: 'plan quality', undesiredContent: 'plan negative' });
    expect(fullPositivePrompt(s, '1girl')).toBe('artist:a, 1girl, artist quality');
    expect(fullNegativePrompt(s)).toBe('artist negative');
  });

  it('正/负面分别回落:一边留空只让该边使用官方词', () => {
    const qualityOnly = nai({ artist: { ...preset, negative: '' } });
    expect(fullPositivePrompt(qualityOnly, '1girl')).toBe('artist:a, 1girl, artist quality');
    expect(fullNegativePrompt(qualityOnly)).toBe(naiDefaultUndesired('nai-diffusion-4-5-full'));

    const negativeOnly = nai({ artist: { ...preset, quality: '', negative: 'artist negative' } });
    expect(fullPositivePrompt(negativeOnly, '1girl')).toBe(
      'artist:a, 1girl, location, very aesthetic, masterpiece, no text',
    );
    expect(fullNegativePrompt(negativeOnly)).toBe('artist negative');
  });

  it('纯空白等同留空;方案旧值不能截胡官方回落', () => {
    const s = nai({
      artist: { ...preset, quality: '  \n ', negative: '\t' },
      qualityTags: 'plan quality',
      undesiredContent: 'plan negative',
    });
    expect(fullPositivePrompt(s, '1girl')).toBe(
      'artist:a, 1girl, location, very aesthetic, masterpiece, no text',
    );
    expect(fullNegativePrompt(s)).toBe(naiDefaultUndesired('nai-diffusion-4-5-full'));
  });
});

describe('NAI V5 support', () => {
  it('uses official model defaults and params_version 4', () => {
    for (const model of ['nai-diffusion-5-full', 'nai-diffusion-5-curated'] as const) {
      expect(naiDefaultQualityTags(model)).toBe('very aesthetic, masterpiece, no text');
      expect(naiDefaultUndesired(model)).toContain('dithering, halftone, screentone');
      const params = buildNaiParameters(nai({ model }), { prompt: '1girl', seed: 42 });
      expect(params.params_version).toBe(4);
      expect(params.v4_prompt).toBeTruthy();
      expect(params.skip_cfg_above_sigma).toBeNull();
      expect(params.sampler).toBe('k_euler');
    }
    const fallback = buildNaiParameters(nai({ model: 'nai-diffusion-5-full', sampler: 'ddim_v3' }), {
      prompt: '1girl',
      seed: 42,
    });
    expect(fallback.sampler).toBe('k_euler_ancestral');
  });

  it('V5 Full 默认负面只排缺陷,不再禁题材/风格/身材/画师', () => {
    // 老版在官方基线上串过一大串社区词,把 chibi、大胸、暗调、具体画师名等都禁了,
    // 会跟正向词与画师串长期打架(原作者已声明弃用)。这里锁死:通用默认不碰题材偏好。
    const neg = naiDefaultUndesired('nai-diffusion-5-full');
    // 官方基线原样保留(V5 调参依赖它,面板也靠这段认出「未自定义」)
    expect(neg).toContain('worst quality, bad quality, jpeg artifacts');
    expect(neg).toContain('dithering, halftone, screentone');
    for (const banned of [
      'chibi',
      'large breasts',
      'huge breasts',
      'dark',
      'high contrast',
      'artist:',
      'artist collaboration',
      '4koma',
      'oekaki',
      'black face',
      'extra people',
      'honey',
      'tight pants',
      'childish',
    ]) {
      expect(neg).not.toContain(banned);
    }
  });

  // 官方前端对 Medium 档隐藏步数/采样器/负面词/Rescale,发请求时强行改写;照抄同一口径
  it('V5 Full Medium 按官方锁死参数:14 步、Euler Ancestral、无 Rescale、负面词恒为官方 Heavy', () => {
    const model = 'nai-diffusion-5-full-medium' as const;
    const s = nai({
      model,
      steps: 28,
      sampler: 'k_dpmpp_2m',
      cfgRescale: 0.4,
      artist: { id: 'art_a', name: 'A', prompt: '', quality: '', negative: 'my negative' },
    });
    const params = buildNaiParameters(s, { prompt: '1girl', seed: 42 });
    expect(params).toMatchObject({ params_version: 4, steps: 14, sampler: 'k_euler_ancestral', cfg_rescale: 0 });
    expect(params.skip_cfg_above_sigma).toBeNull();
    // 官方 Heavy 原文,不串 5-full 的插件精选层;用户自填的不发
    expect(fullNegativePrompt(s)).toBe(naiDefaultUndesired(model));
    expect(fullNegativePrompt(s)).not.toContain('my negative');
    expect(fullNegativePrompt(s)).not.toContain('plastic skin');
    expect(naiDefaultQualityTags(model)).toBe('very aesthetic, masterpiece, no text');
    expect(naiFixedSettings(model)).toEqual({ steps: 14, sampler: 'k_euler_ancestral' });
    expect(naiFixedSettings('nai-diffusion-5-full')).toBeNull();
    // 与官方同口径:vibe 编码键归 v5full;角色提示照常走 V5 协议
    expect(vibeModelKey(model)).toBe('v5full');
    expect(naiSupportsCharacterPrompts(model)).toBe(true);
    // 正面质量词不受锁定影响,画师串自定义照常生效
    const artist = { id: 'art_a', name: 'A', prompt: '', quality: 'my quality', negative: 'my negative' };
    expect(fullPositivePrompt(nai({ model, artist }), '1girl')).toBe('1girl, my quality');
  });

  it('maps Base Tag + NL and native Character Prompts into the V5 caption schema', () => {
    const settings = nai({
      model: 'nai-diffusion-5-full',
      artist: { id: 'artist', name: 'Artist', prompt: 'artist:test', quality: 'very aesthetic', negative: '' },
    });
    const params = buildNaiParameters(settings, {
      prompt: '2girls, classroom, sunset',
      nl: 'Two girls in a sunset classroom.',
      characters: [
        { name: 'A', tag: '1girl, black hair, white dress', nl: 'On the left, waving.' },
        { name: 'B', tag: 'girl, silver hair, red dress', nl: '' },
      ],
      seed: 42,
    });
    const positive = params.v4_prompt as {
      caption: { base_caption: string; char_captions: Array<{ char_caption: string; centers: unknown[] }> };
      use_coords: boolean;
      use_order: boolean;
    };
    const negative = params.v4_negative_prompt as {
      caption: { char_captions: Array<{ char_caption: string; centers: unknown[] }> };
    };
    expect(positive.caption.base_caption).toBe(
      'artist:test, 2girls, classroom, sunset, very aesthetic. Two girls in a sunset classroom.',
    );
    expect(positive.caption.char_captions).toEqual([
      { char_caption: 'girl, black hair, white dress. On the left, waving.', centers: [{ x: 0.5, y: 0.5 }] },
      { char_caption: 'girl, silver hair, red dress', centers: [{ x: 0.5, y: 0.5 }] },
    ]);
    expect(negative.caption.char_captions).toEqual([
      { char_caption: '', centers: [{ x: 0.5, y: 0.5 }] },
      { char_caption: '', centers: [{ x: 0.5, y: 0.5 }] },
    ]);
    expect(positive.use_coords).toBe(false);
    expect(positive.use_order).toBe(true);
  });

  it('carries per-character uc into char_captions so 防复穿/防串色 真的提交给 NAI', () => {
    const settings = nai({ model: 'nai-diffusion-5-full' });
    const params = buildNaiParameters(settings, {
      prompt: '1girl, 1boy, bedroom',
      characters: [
        { name: 'A', tag: 'girl, white shirt', nl: '', uc: 'skirt, jacket' },
        { name: 'B', tag: 'boy, black jacket', nl: '', uc: '' },
      ],
      seed: 7,
    });
    const negative = params.v4_negative_prompt as {
      caption: { char_captions: Array<{ char_caption: string }> };
    };
    expect(negative.caption.char_captions[0].char_caption).toBe('skirt, jacket');
    expect(negative.caption.char_captions[1].char_caption).toBe('');
  });

  // V5 不支持 Vibe Transfer:有 v5 编码也不发,整组记为跳过
  it('skips vibes on V5 even when a V5 encoding exists', () => {
    expect(vibeModelKey('nai-diffusion-5-full')).toBe('v5full');
    expect(vibeModelKey('nai-diffusion-5-curated')).toBe('v5curated');
    expect(naiSupportsVibes('nai-diffusion-5-full')).toBe(false);
    expect(naiSupportsVibes('nai-diffusion-4-5-full')).toBe(true);
    const settings = nai({ model: 'nai-diffusion-5-full', vibes: [vibe({ name: 'V5 vibe' })] });
    const params = buildNaiParameters(settings, { prompt: 'x', seed: 1 });
    const data = vibeData({ encodings: { v5full: { encoding: 'djU=', infoExtracted: 1 } } });
    expect(applyVibes(params, settings, new Map([['v1', data]])).skipped).toEqual(['V5 vibe']);
    expect(params.reference_image_multiple_cached ?? []).toEqual([]);
  });

  // 回归锁:char_captions 所在字段本就叫 v4_prompt,这套结构是 V4 时代的协议,V5 只是继承。
  // 曾经按 isNai5 卡过,4.5 明明支持却一条角色提示都发不出去(角色外貌全糊进 Base)。
  // 边界在 4.5 而非整个 v4 系:自然语言是 4.5 引入的,原版 NAI4 只吃 tag。
  it('sends native Character Prompts on 4.5 as well as V5, but not on plain NAI 4', () => {
    const values = {
      prompt: '2girls, classroom',
      nl: 'Two girls in a classroom.',
      characters: [{ name: 'A', tag: '1girl, black hair, white dress', nl: 'On the left.' }],
      seed: 1,
    };
    const captionsOf = (model: NaiModel) =>
      (
        buildNaiParameters(nai({ model }), values).v4_prompt as {
          caption: { base_caption: string; char_captions: Array<{ char_caption: string }> };
        }
      ).caption;

    for (const model of ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated', 'nai-diffusion-5-full'] as const) {
      const caption = captionsOf(model);
      expect([model, caption.char_captions.map(c => c.char_caption)]).toEqual([
        model,
        ['girl, black hair, white dress. On the left.'],
      ]);
      // nl 拼接同样开放到 4.5:句点分隔接在 tag 串之后
      expect([model, caption.base_caption.endsWith('. Two girls in a classroom.')]).toEqual([model, true]);
    }

    // 原版 NAI4 保持单串形态:角色提示与 nl 都不发
    for (const model of ['nai-diffusion-4-full', 'nai-diffusion-4-curated-preview'] as const) {
      const caption = captionsOf(model);
      expect([model, caption.char_captions]).toEqual([model, []]);
      expect([model, caption.base_caption.includes('Two girls in a classroom.')]).toEqual([model, false]);
    }
  });
});

describe('buildNaiParameters', () => {
  it('v4 系带 v4_prompt 结构', () => {
    const p = buildNaiParameters(nai(), { prompt: '1girl', seed: 42 });
    expect(p.seed).toBe(42);
    expect(p.width).toBe(832);
    expect(p.height).toBe(1216);
    const v4 = p.v4_prompt as { caption: { base_caption: string }; use_order: boolean };
    expect(v4.caption.base_caption).toContain('1girl');
    expect(v4.use_order).toBe(true);
    expect(p.reference_image_multiple_cached).toEqual([]);
    expect(p.v4_negative_prompt).toBeTruthy();
    expect(p.ucPreset).toBe(3);
    expect(p.qualityToggle).toBe(true);
  });

  it('NAI3 不带 v4 结构,带原图参考数组与 sm 开关', () => {
    const p = buildNaiParameters(nai({ model: 'nai-diffusion-3' }), { prompt: '1girl', seed: 1 });
    expect(p.v4_prompt).toBeUndefined();
    expect(p.reference_image_multiple).toEqual([]);
    expect(p.reference_information_extracted_multiple).toEqual([]);
    expect(p.sm).toBe(false);
    expect(p.reference_image_multiple_cached).toBeUndefined();
  });

  it('v4_prompt 的 base_caption 与 fullPositivePrompt 同源(含画师串)', () => {
    // 顶层 input(generateNaiImage)与 parameters.v4_prompt 各拼一次的话,NAI3 读 input、
    // NAI4/4.5 读 v4_prompt,两者会拿到不同提示词且只在 NAI3 上暴露。此断言把「同源」钉死:
    // 任何拼装改动都必须留在 fullPositivePrompt 内部,不能在调用点单独加料。
    const s = nai({
      artist: { id: 'art_a', name: 'A', prompt: 'artist:a', quality: '', negative: '' },
    });
    const p = buildNaiParameters(s, { prompt: '1girl', seed: 1 });
    const v4 = p.v4_prompt as { caption: { base_caption: string } };
    expect(v4.caption.base_caption).toBe(fullPositivePrompt(s, '1girl'));
    expect(v4.caption.base_caption.startsWith('artist:a, 1girl')).toBe(true);
  });

  it('k_euler_ancestral 附加 brownian 修正', () => {
    const p = buildNaiParameters(nai({ sampler: 'k_euler_ancestral' }), { prompt: 'x', seed: 1 });
    expect(p.prefer_brownian).toBe(true);
    expect(p.deliberate_euler_ancestral_bug).toBe(false);
  });

  it('横屏画面取横屏尺寸,skip_cfg_above_sigma 随像素量同步变化', () => {
    const portrait = buildNaiParameters(nai(), { prompt: '1girl', seed: 1 });
    const landscape = buildNaiParameters(nai(), { prompt: '2girls', seed: 1, size: 'landscape' });
    expect(landscape.width).toBe(1216);
    expect(landscape.height).toBe(832);
    // 832×1216 与 1216×832 像素量相同,sigma 也应相同(证明它确实按尺寸推导)
    expect(landscape.skip_cfg_above_sigma).toBe(portrait.skip_cfg_above_sigma);

    const bigLandscape = buildNaiParameters(nai({ landscapeSize: '1536×1024' }), {
      prompt: '2girls',
      seed: 1,
      size: 'landscape',
    });
    expect(bigLandscape.width).toBe(1536);
    expect(Number(bigLandscape.skip_cfg_above_sigma)).toBeGreaterThan(
      Number(portrait.skip_cfg_above_sigma),
    );
  });

  it('缺 size 时按竖屏出图(与改动前的固定默认一致)', () => {
    const p = buildNaiParameters(nai(), { prompt: '1girl', seed: 1 });
    expect(p.width).toBe(832);
    expect(p.height).toBe(1216);
  });

  it('对应方向未填时回落内置竖屏默认', () => {
    const p = buildNaiParameters(nai({ landscapeSize: '' }), { prompt: 'x', seed: 1, size: 'landscape' });
    expect(p.width).toBe(832);
    expect(p.height).toBe(1216);
  });

  it('固定种子优先于随机', () => {
    const p = buildNaiParameters(nai({ seed: 123 }), { prompt: 'x' });
    expect(p.seed).toBe(123);
    const p2 = buildNaiParameters(nai({ seed: 123 }), { prompt: 'x', seed: 7 });
    expect(p2.seed).toBe(7);
  });
});

describe('skipCfgAboveSigma', () => {
  it('关 variety 时为 null', () => {
    expect(skipCfgAboveSigma(832, 1216, 'nai-diffusion-4-5-full', false)).toBeNull();
  });

  it('4.5 用 58,其余用 19', () => {
    const v45 = skipCfgAboveSigma(1024, 1024, 'nai-diffusion-4-5-full', true)!;
    const v4 = skipCfgAboveSigma(1024, 1024, 'nai-diffusion-4-full', true)!;
    expect(v45 / v4).toBeCloseTo(58 / 19, 5);
  });
});

describe('applyVibes', () => {
  it('NAI4/4.5:编码数据进 cached,强度并进 strength 数组', () => {
    const params = buildNaiParameters(nai(), { prompt: 'x', seed: 1 });
    const { applied, skipped } = applyVibes(params, nai({ vibes: [vibe()] }), new Map([['v1', vibeData()]]));
    expect(skipped).toEqual([]);
    // 随图记录的是面板配置强度与实际发送强度
    expect(applied).toEqual([
      { id: 'v1', name: '测试Vibe', group: '', strength: 0.6, effectiveStrength: 0.6 },
    ]);
    const cached = params.reference_image_multiple_cached as { cache_secret_key: string; data: string }[];
    expect(cached).toHaveLength(1);
    expect(cached[0].data).toBe('ZW5jb2Rpbmc=');
    expect(cached[0].cache_secret_key).toBeTruthy();
    expect(params.reference_strength_multiple).toEqual([0.6]);
  });

  it('缺当前模型编码的 vibe 被跳过并返回名字', () => {
    const params = buildNaiParameters(nai(), { prompt: 'x', seed: 1 });
    const { applied, skipped } = applyVibes(
      params,
      nai({ vibes: [vibe({ name: '旧模型Vibe', modelKeys: ['v3'] })] }),
      new Map([['v1', vibeData({ encodings: { v3: { encoding: 'eQ==', infoExtracted: 1 } } })]]),
    );
    expect(skipped).toEqual(['旧模型Vibe']);
    expect(applied).toEqual([]);
    expect(params.reference_image_multiple_cached).toEqual([]);
  });

  it('强度总和超过 1 且开归一化时按比例压回 1', () => {
    const params = buildNaiParameters(nai(), { prompt: 'x', seed: 1 });
    const { applied } = applyVibes(
      params,
      nai({
        vibes: [vibe({ id: 'a', strength: 0.8 }), vibe({ id: 'b', strength: 0.6 })],
      }),
      new Map([
        ['a', vibeData()],
        ['b', vibeData()],
      ]),
    );
    const strengths = params.reference_strength_multiple as number[];
    expect(strengths[0] + strengths[1]).toBeCloseTo(1, 6);
    // 记录里配置值保持原样，实际发送值反映归一化结果
    expect(applied.map(v => v.strength)).toEqual([0.8, 0.6]);
    expect(applied[0].effectiveStrength).toBeCloseTo(0.8 / 1.4, 6);
    expect(applied[1].effectiveStrength).toBeCloseTo(0.6 / 1.4, 6);
  });

  it('NAI3:参考原图进 reference_image_multiple', () => {
    const settings = nai({ model: 'nai-diffusion-3', vibes: [vibe()] });
    const params = buildNaiParameters(settings, { prompt: 'x', seed: 1 });
    const { skipped } = applyVibes(params, settings, new Map([['v1', vibeData()]]));
    expect(skipped).toEqual([]);
    expect(params.reference_image_multiple).toEqual(['aW1hZ2U=']);
    expect(params.reference_information_extracted_multiple).toEqual([1]);
    expect(params.reference_strength_multiple).toEqual([0.6]);
  });

  it('没勾选任何 vibe(vibes 为空)时什么都不加', () => {
    const params = buildNaiParameters(nai(), { prompt: 'x', seed: 1 });
    expect(applyVibes(params, nai({ vibes: [] }), new Map([['v1', vibeData()]]))).toEqual({
      applied: [],
      skipped: [],
    });
    expect(params.reference_image_multiple_cached).toEqual([]);
  });
});

describe('vibeModelKey', () => {
  it('按模型映射官方 key', () => {
    expect(vibeModelKey('nai-diffusion-4-5-full')).toBe('v4-5full');
    expect(vibeModelKey('nai-diffusion-4-5-curated')).toBe('v4-5curated');
    expect(vibeModelKey('nai-diffusion-4-full')).toBe('v4full');
    expect(vibeModelKey('nai-diffusion-4-curated-preview')).toBe('v4curated');
    expect(vibeModelKey('nai-diffusion-3')).toBe('v3');
  });
});

describe('parseNaiv4vibe', () => {
  it('解析官方格式', () => {
    const text = JSON.stringify({
      identifier: 'novelai-vibe-transfer',
      version: 1,
      image: 'aW1hZ2U=',
      name: 'abc123-def456',
      thumbnail: 'data:image/png;base64,xx',
      encodings: {
        'v4-5full': {
          k: { encoding: 'ZW5jb2Rpbmc=', params: { information_extracted: 1 } },
        },
      },
      importInfo: { model: 'nai-diffusion-4-5-full', information_extracted: 1, strength: 0.7 },
    });
    const v = parseNaiv4vibe(text);
    expect(v.name).toBe('abc123-def456');
    expect(v.encodings['v4-5full'].encoding).toBe('ZW5jb2Rpbmc=');
    expect(v.strength).toBe(0.7);
  });

  it('缺 strength 字段回落 0.6,不静默变成强度 0', () => {
    // 回归:旧实现走 Number(v),而 Number(null) / Number('') 都是 0 ——
    // vibe 会以「强度 0」导入,挂上了却对画面毫无影响,且极难排查。
    const build = (importInfo: unknown) =>
      JSON.stringify({
        identifier: 'novelai-vibe-transfer',
        version: 1,
        image: 'aW1hZ2U=',
        encodings: {
          'v4-5full': {
            k: { encoding: 'ZW5jb2Rpbmc=', params: { information_extracted: 1 } },
          },
        },
        importInfo,
      });
    expect(parseNaiv4vibe(build({ model: 'nai-diffusion-4-5-full' })).strength).toBe(0.6);
    expect(parseNaiv4vibe(build({ strength: null })).strength).toBe(0.6);
    expect(parseNaiv4vibe(build({ strength: '' })).strength).toBe(0.6);
  });

  it('拒绝非 vibe JSON', () => {
    expect(() => parseNaiv4vibe('{"foo":1}')).toThrow(/标识/);
    expect(() => parseNaiv4vibe('not json')).toThrow(NaiError);
  });
});

describe('unzipNaiImage', () => {
  it('解出 zip 内第一张图', () => {
    const zipped = zipSync({ 'image_0.png': strToU8('fake-png-bytes') });
    const { base64, filename } = unzipNaiImage(zipped.buffer as ArrayBuffer);
    expect(filename).toBe('image_0.png');
    expect(atob(base64)).toBe('fake-png-bytes');
  });

  it('非 zip 数据报友好错误', () => {
    expect(() => unzipNaiImage(strToU8('not a zip').buffer as ArrayBuffer)).toThrow(NaiError);
  });
});

describe('naiRandomSeed', () => {
  it('32 位无符号整数', () => {
    const s = naiRandomSeed();
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(2 ** 32);
  });
});

describe('内置画师串配方(只读、随版本更新、不进 settings)', () => {
  // 引用解析(方案 artistId → 用户库 / 内置库 / 悬空 = null)在 settings.naiArtistFor,
  // 见 settings.naiPlans.test.ts;这里只锁「解析出内置条目后」的拼装。
  it('方案选中内置条目时,画师串照常拼在最前', () => {
    const s = nai({ artist: BUILTIN_NAI_ARTISTS[0] });
    expect(naiArtistPrompt(s)).toBe(BUILTIN_NAI_ARTISTS[0].prompt.trim());
    expect(fullPositivePrompt(s, '1girl')).toBe(
      `${BUILTIN_NAI_ARTISTS[0].prompt.trim()}, 1girl, location, very aesthetic, masterpiece, no text`,
    );
  });

  it('isBuiltinNaiArtist:bi_ 前缀命中,用户条目(art_*)不命中', () => {
    expect(isBuiltinNaiArtist('bi_default')).toBe(true);
    expect(isBuiltinNaiArtist('art_abc')).toBe(false);
    expect(isBuiltinNaiArtist('')).toBe(false);
  });
});

describe('镜头编译后的 NovelAI 请求', () => {
  const person = (name: string, hair: string, body: string): CharTagEntry => ({
    name, source: 'ai', desc: '', raw: '', nl: '', history: [],
    fields: { ...emptyCharFields(), sex: '1girl', hair, body },
  });
  const entries = [person('段明星', 'brown hair, low bun', 'mature female, curvy'),
    person('段兰', 'black hair, parted bangs', 'adult, flat chest')];
  const before = new Map<string, CharacterWardrobe>([['段兰', {
    name: '段兰', outer: { tag: 'beige trench coat', status: 'on' }, top: { tag: 'white shirt', status: 'on' },
    innerTop: { tag: 'red bra', status: 'on' }, shoes: { tag: 'black boots', status: 'on' },
  }]]);
  function compile(text: string, images: object[], wardrobeUpdates: object[] = []) {
    const segments = prepareTargetText(text, []).segments;
    const plan = parseUnifiedPlan(JSON.stringify({ timeJump: 'same_day', images, wardrobeUpdates }), segments, 0, 4, { femaleScenesOnly: true, selectBeats: true });
    return compileWardrobeSequence(before, plan.wardrobeUpdates, plan.images, (shot, state) => compactGeneratedScene(assembleImageCharacters(shot, entries, state)), {
      segments, timeJump: plan.timeJump,
    }).frames;
  }
  function payload(image: ReturnType<typeof compile>[number], model: NaiModel) {
    const content = parseImageTagContent(parseImageTags(serializeImageTag(image))[0]);
    const params = buildNaiParameters(nai({ model }), {
      prompt: content.tag, nl: content.nl, characters: content.characters, seed: 7,
    });
    return (params.v4_prompt as {
      caption: { base_caption: string; char_captions: Array<{ char_caption: string }> };
    }).caption;
  }

  for (const model of ['nai-diffusion-4-5-full', 'nai-diffusion-5-full'] as const) {
    it(model + ' 同段前后请求分别呈现闭合及敞开的外套，只漏出下一层', () => {
      const frame = (clause: number) => ({
        position: 'P1', clause, tag: '1girl, medium shot, indoors',
        characters: [{ name: '段兰', tag: 'standing, red bra' }],
      });
      const shots = compile('段兰进门，段兰敞开风衣。', [frame(1), frame(2)], [
        { name: '段兰', position: 'P1', clause: 2, mode: 'patch',
          slots: { outer: { status: 'half_top', reveal: 'layer', halfTag: 'open front' } } },
      ]).map(shot => payload(shot, model).char_captions[0].char_caption);
      expect(shots[0]).toContain('beige trench coat, closed coat');
      expect(shots[0]).not.toMatch(/white shirt|red bra/);
      expect(shots[1]).toContain('beige trench coat, open front, white shirt');
      expect(shots[1]).not.toMatch(/closed coat|red bra/);
    });

    it(model + ' 收到可见衣层、正确的动作两端和成年女儿', () => {
      const [shot] = compile('段兰是段明星的女儿。段兰伸手用帕子轻擦段明星的嘴角。', [{
        position: 'P1', tag: '2girls, medium shot, indoors',
        nl: 'The little girl extends her arm toward her mother.',
        contact: ['段兰', '段明星', 'pressing a cloth to her mouth', 'turning her mouth toward the cloth in the other woman’s hand'],
        characters: [
          { name: '段兰', tag: '@段兰, daughter, little girl, wiping mouth, target#wiping mouth, red bra, black boots',
            nl: 'Wearing a red bra, she extends her right arm.' },
          { name: '段明星', tag: 'mother, source#wiping mouth, sitting' },
        ],
      }]);
      const sent = payload(shot, model);
      expect(sent.base_caption).toMatch(/woman with black hair.*woman with brown hair/);
      const [daughter, mother] = sent.char_captions.map(c => c.char_caption);
      expect(daughter).toMatch(/adult, flat chest.*beige trench coat.*source#wiping mouth.*pressing a cloth to her mouth/);
      expect(daughter.split(', ')).not.toContain('wiping mouth');
      expect(daughter).not.toMatch(/daughter|little girl|red bra|black boots|@段兰/);
      expect(mother).toMatch(/target#wiping mouth.*turning her mouth toward the cloth/);
    });
  }

  it('明确的童年镜头只调整该帧年龄，后面重逢仍取成年档案', () => {
    const [past, present] = compile('回忆中，段兰十岁时和段明星一起看花。\n成年后的段兰再次回来。', [
      { position: 'P1', tag: '2girls, medium shot', characters: [{ name: '段兰', tag: 'daughter, standing', age: 'child' }] },
      { position: 'P2', tag: '1girl, medium shot', characters: [{ name: '段兰', tag: 'standing' }] },
    ]);
    expect(past.characters[0].tag).toContain('child');
    expect(past.characters[0].tag).not.toMatch(/adult|flat chest/);
    expect(present.characters[0].tag).toMatch(/adult, flat chest/);
  });

  it('跨度大的动作才扩景，局部意图、名额、画幅方向和章节顺序保留', () => {
    const [wide, detail] = compile('段兰抓住自己的两个脚踝。\n她举起墨镜。', [
      { position: 'P1', size: 'landscape', tag: '1girl, from side, medium shot',
        extent: 'whole', characters: [{ name: '段兰', tag: 'grabbing own ankles' }] },
      { position: 'P2', size: 'portrait', tag: '1girl, close-up, hand focus',
        extent: 'detail', characters: [{ name: '段兰', tag: 'holding sunglasses' }] },
    ]);
    expect(wide.tag).toContain('full body');
    expect(wide.tag).not.toContain('medium shot');
    expect(wide.size).toBe('landscape');
    expect(detail.tag).toContain('close-up, hand focus');
    expect(detail.characters[0].tag).toContain('holding sunglasses');
    expect(detail.position).toBe('P2');
  });
});

describe('用户用例传入 NovelAI 4.5 的最终 caption', () => {
  function captions(text: string, images: object[], entries: CharTagEntry[] = [], wardrobe = new Map<string, CharacterWardrobe>()) {
    const segments = prepareTargetText(text, []).segments;
    const plan = parseUnifiedPlan(JSON.stringify({ images }), segments, 0, 5, { femaleScenesOnly: true, selectBeats: true });
    return plan.images.map(shot => {
      const assembled = compactGeneratedScene(assembleImageCharacters(shot, entries, wardrobe));
      const { tag, nl, characters } = parseImageTagContent(parseImageTags(serializeImageTag(assembled))[0]);
      return (buildNaiParameters(nai({ model: 'nai-diffusion-4-5-full' }), { prompt: tag, nl, characters, seed: 7 }).v4_prompt as
        { caption: { base_caption: string; char_captions: { char_caption: string }[] } }).caption;
    });
  }

  it('手机在脚边的地面，留足取景，不把章节后文的最终落点提前', () => {
    const [image] = captions('邱晓晓对着地上那部屏幕碎裂的手机，轻轻一踢。\n手机精准地停在了高嘉豪的脚边。', [{
      position: 'P1', tag: '1girl, 2boys, from side, medium shot, school hallway, daylight',
      nl: "The woman clings to one man's arm while kicking a cracked smartphone toward the other man's feet.",
      characters: [
        { name: '邱晓晓', tag: 'girl, standing, kicking, source#arm hold, holding his arm tightly', nl: 'She raises one foot lightly to kick the broken phone across the floor.' },
        { name: '秦开宇', tag: '1boy, boy, standing, target#arm hold' },
        { name: '高嘉豪', tag: '1boy, boy, standing' },
      ],
    }]);
    expect(image.base_caption).toMatch(/full body.*cracked smartphone on the floor.*shoe and phone both in frame/);
    expect(image.base_caption).not.toMatch(/toward the other|medium shot/);
    expect(image.char_captions[0].char_caption).toMatch(/shoe touching the cracked smartphone on the floor.*source#arm hold/);
    expect(image.char_captions[0].char_caption).not.toMatch(/raises one foot/);
  });

  it('三人同框只画接触当拍，保留支撑反应和它的正确归属', () => {
    const [image] = captions('邱晓晓下意识地抓紧了秦开宇的衣角。\n秦开宇一脚重重踹在高嘉豪的腹部。\n高嘉豪跌倒在地。', [{
      position: 'P2', tag: '1girl, 2boys, from side, medium shot, school hallway, daylight',
      nl: 'One boy kicks the other boy in the abdomen while the woman stands nearby holding his sleeve.',
      characters: [
        { name: '邱晓晓', tag: 'girl, scared, standing, holding onto sleeve', nl: "She grips the boy's clothing in alarm." },
        { name: '秦开宇', tag: '1boy, boy, serious, standing, kicking, leg lifted', nl: 'He lands a clean kick on his opponent.' },
        { name: '高嘉豪', tag: '1boy, boy, surprised, falling backward, clutching stomach', nl: 'He stumbles back from the impact.' },
      ],
    }]);
    expect(image.base_caption).toMatch(/full body.*both participants and point of contact visible/);
    expect(image.char_captions.map(char => char.char_caption)).toEqual([
      expect.stringContaining('holding onto shirt hem'),
      expect.stringContaining('foot in contact with the third person'),
      expect.stringContaining('recoiling at the instant of contact'),
    ]);
    expect(JSON.stringify(image)).not.toMatch(/falling backward|clutching stomach|leg lifted|sleeve|@\{/);
  });

  it('同一个侧马尾和蓝色连衣裙跨影院镜头沿用，穿法词不会重选衣领袖型', () => {
    const name = '邱晓晓';
    const entries: CharTagEntry[] = [{ name, raw: '', nl: '', desc: '', history: [], source: 'ai', fields: {
      ...emptyCharFields(), sex: '1girl', hair: 'dark brown hair, medium hair, wavy hair, side ponytail, wispy bangs',
      eyes: 'amber eyes, tareme', body: 'curvy, large breasts', extra: 'hair ribbon, oval face, arched eyebrows',
    } }];
    const wardrobe = new Map<string, CharacterWardrobe>([[name, { name, top: { tag: 'light blue dress', status: 'on' } }]]);
    const views = ['from side', 'three-quarter view', 'from front'];
    const images = captions('邱晓晓在影院坐下。\n她倚着靠背。\n她抬起手。', views.map((view, i) => ({
      position: 'P' + (i + 1), tag: '1girl, medium shot, theater, ' + view,
      characters: [{ name, tag: 'girl, sitting, holding the skirt', omitFeatures: ['oval face', 'side ponytail'], nl: 'She adjusts the skirt.' }],
    })), entries, wardrobe);

    for (const { char_captions: [role] } of images) {
      expect(role.char_caption).toMatch(/dark brown hair.*side ponytail.*oval face.*arched eyebrows.*light blue dress.*simple round neckline.*short sleeves.*single-piece dress/);
      expect(role.char_caption).not.toContain('the skirt');
      expect(role.char_caption).toContain('dress hem');
    }
  });
});

describe('服装缺档和跨楼恢复的 NovelAI 4.5 请求', () => {
  function run(
    story: string,
    images: object[],
    before = new Map<string, CharacterWardrobe>(),
    options: { previousStory?: string; timeJump?: 'new_day' | 'same_day'; updates?: object[] } = {},
  ) {
    const segments = prepareTargetText(story, []).segments;
    const plan = parseUnifiedPlan(JSON.stringify({ images, timeJump: options.timeJump, wardrobeUpdates: options.updates }),
      segments, 0, 8, { femaleScenesOnly: true, selectBeats: true });
    return compileWardrobeSequence(before, plan.wardrobeUpdates, plan.images, (shot, wardrobe) => {
      const image = assembleImageCharacters(shot, [], wardrobe);
      const parsed = parseImageTagContent(parseImageTags(serializeImageTag(image))[0]);
      const params = buildNaiParameters(nai({ model: 'nai-diffusion-4-5-full' }), {
        prompt: parsed.tag, nl: parsed.nl, characters: parsed.characters, seed: 7,
      });
      const positive = params.v4_prompt as { caption: { base_caption: string; char_captions: { char_caption: string }[] } };
      const negative = params.v4_negative_prompt as typeof positive;
      return { positive: positive.caption, role: positive.caption.char_captions[0].char_caption,
        uc: negative.caption.char_captions[0].char_caption };
    }, { segments, world: 'modern', timeJump: plan.timeJump, previousStory: options.previousStory });
  }

  const commutes = '林雨霖';
  const worker = '赵曼心';
  const officeShot = (position: string, nl = '') => ({
    position, tag: '1girl, medium shot, office, meeting room, daylight', nl,
    characters: [{ name: worker, tag: 'girl, bottomless, sitting, chin rest',
      nl: 'She sits without her skirt at the table.', uc: 'skirt' }],
  });
  const yesterday = new Map<string, CharacterWardrobe>([[worker, {
    name: worker,
    top: { tag: 'white short-sleeved blouse', style: 'collared', status: 'on' },
    bottom: { tag: 'black straight skirt', style: 'knee-length, matte woven fabric', status: 'off', condition: 'damp fabric' },
    innerBottom: { tag: 'blue briefs', status: 'off' },
  }]]);

  it('两张通勤图没提交衣物记录，裙子后文才提到，仍共同使用第一次建立的服装', () => {
    const result = run('林雨霖与林牧在地铁车厢，林雨霖扶住他的肩。\n出了地铁站，林雨霖用提包挡住自己湿漉漉的黑色裙子。', [
      { position: 'P1', tag: '1girl, 1boy, from side, medium shot, subway train, crowded, morning light',
        characters: [{ name: commutes, tag: 'girl, luxury handbag, standing, gripping his shoulders tightly' },
          { name: '林牧', tag: '1boy, standing' }] },
      { position: 'P2', tag: '1girl, pov, medium shot, city street, outdoors, daylight',
        nl: 'Outside the subway station, she holds her handbag in front of her damp skirt.',
        characters: [{ name: commutes, tag: 'girl, luxury handbag, standing, holding bag' }] },
    ]);
    expect(result.frames).toHaveLength(2);
    for (const frame of result.frames) expect(frame.role).toMatch(/ivory collared blouse.*black skirt/);
    expect(result.frames[1].positive.base_caption).toContain('her damp skirt');
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]).toMatchObject({ name: commutes, position: 'P1', mode: 'replace',
      slots: { top: { tag: 'ivory collared blouse', status: 'on' }, bottom: { tag: 'black skirt', status: 'on' } } });
  });

  it('正文未说裙款时，后镜头有归属的衣物词会补进同一套服装，并消解 dress hem 与裙子的冲突', () => {
    const result = run('林雨霖与林牧在地铁车厢。\n林雨霖出了地铁站，走向出租车。', [
      { position: 'P1', tag: '1girl, 1boy, medium shot, subway train',
        characters: [{ name: commutes, tag: 'girl, standing, luxury handbag' }, { name: '林牧', tag: '1boy, standing' }] },
      { position: 'P2', tag: '1girl, pov, medium shot, city street',
        nl: 'She holds her handbag in front of her damp skirt.',
        characters: [{ name: commutes, tag: 'girl, holding her handbag over the dress hem' }] },
    ]);
    expect(result.frames.map(frame => frame.role)).toEqual([
      expect.stringContaining('ivory collared blouse, charcoal knee-length straight skirt'),
      expect.stringContaining('ivory collared blouse, charcoal knee-length straight skirt'),
    ]);
    expect(result.frames[1].role).toContain('holding her handbag over the skirt hem');
    expect(JSON.stringify(result.frames)).not.toMatch(/dress hem|trousers/);
  });

  it('隔天办公室即使导演漏报时间和换装，仍恢复已知下装并清理冲突的描述和负面词', () => {
    const result = run('昨天的事情过去了。\n隔天，赵曼心坐在会议桌前，双手托腮。', [
      officeShot('P2', 'The woman sits bottomless at the conference table resting her chin in both hands.'),
    ], yesterday);
    const [frame] = result.frames;
    expect(frame.role).toMatch(/white short-sleeved blouse, collared.*black straight skirt, knee-length, matte woven fabric.*sitting, chin rest/);
    expect(JSON.stringify(frame)).not.toMatch(/bottomless|without her skirt|damp fabric|blue briefs/);
    expect(frame.uc).not.toMatch(/\bskirt\b/);
    const delta = makeWardrobeFloorDelta(result.updates, 0);
    const chat = [{ mes: '', name: '赵曼心', is_user: false, is_system: false, extra: { bbiOutfitOps: delta } }];
    expect(deriveWardrobes(chat).get(worker)?.bottom).toMatchObject({ status: 'on', tag: 'black straight skirt' });
  });

  it('只存了上衣的旧档也能在正常上班的镜头补下装，忽略未经正文支持的 off 更新', () => {
    const before = new Map<string, CharacterWardrobe>([[worker,
      { name: worker, top: { tag: 'white short-sleeved blouse', status: 'on' } }]]);
    const result = run('次日赵曼心来到公司开会。', [officeShot('P1')], before, { updates: [{
      name: worker, position: 'P1', mode: 'replace',
      slots: { top: { tag: 'white short-sleeved blouse', status: 'on' },
        bottom: { tag: 'navy pleated skirt', status: 'off' }, innerBottom: { status: 'off' } },
    }] });
    expect(result.frames[0].role).toMatch(/white short-sleeved blouse.*navy pleated skirt/);
    expect(JSON.stringify(result.frames[0])).not.toMatch(/bottomless|without her skirt|underwear/);
  });

  it('跨楼仍是同一会议时延用上一刻的状态，后面的穿回动作单独生效', () => {
    const result = run('会议仍在继续，赵曼心仍坐在会议室。\n赵曼心穿回裙子。', [officeShot('P1'), officeShot('P2')],
      yesterday, { previousStory: '赵曼心在会议室坐着，会议还没有结束。' });
    expect(result.frames[0].role).toContain('bottomless');
    expect(result.frames[1].role).toContain('black straight skirt');
    expect(result.frames[1].role).not.toContain('bottomless');
    expect(result.updates).toHaveLength(1);
  });

  it('跨到正常到岗能恢复衣件；次日正文明确延续某个穿着状态时以正文为准', () => {
    const arrived = run('赵曼心准时来到公司开会。', [officeShot('P1')], yesterday, {
      previousStory: '晚上赵曼心独自在家里。', timeJump: 'new_day',
    });
    expect(arrived.frames[0].role).toContain('black straight skirt');
    expect(arrived.frames[0].role).not.toContain('bottomless');

    const continued = run('翌日，赵曼心仍没穿裙子，独自在家。', [
      { ...officeShot('P1'), tag: '1girl, medium shot, living room' },
    ], yesterday);
    expect(continued.frames[0].role).toContain('bottomless');
    expect(continued.updates).toHaveLength(0);
  });

  it('日历切点分开当天与隔天；隔天正文新发生的服装变化仍从该处生效', () => {
    const result = run('赵曼心坐在家中。\n翌日赵曼心来到公司。\n赵曼心换上灰色西装裤。', [
      { ...officeShot('P1'), tag: '1girl, medium shot, living room' },
      officeShot('P2'), officeShot('P3'),
    ], yesterday, { updates: [{
      name: worker, position: 'P3', mode: 'swap', slots: { bottom: { tag: 'grey suit trousers', status: 'on' } },
    }] });
    expect(result.frames.map(f => f.role)).toEqual([
      expect.stringContaining('bottomless'), expect.stringContaining('black straight skirt'), expect.stringContaining('grey suit trousers'),
    ]);
    expect(result.frames[2].role).not.toContain('black straight skirt');
  });
});
