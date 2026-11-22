import { describe, expect, it, vi } from 'vitest';

import { buildPortraitCharacterTag, generateCharacterPortrait } from '@/autoTag/portrait';
import { emptyCharFields, findCharTag, normalizeCharTagStore, upsertCharTag, type CharTagEntry } from '@/state/charTags';
import { WORLD_PRESETS, type WorldAnchorConfig } from '@/state/worldAnchor';

const generateImage = vi.fn();
const savePortrait = vi.fn();

vi.mock('@/generate', () => ({
  backendStatus: () => ({ backend: 'nai', configured: true, supportsCharacters: true, model: 'nai-diffusion-4-5-full', reason: '' }),
  decideSeed: () => 4242,
  generateImage: (...args: unknown[]) => generateImage(...args),
}));

vi.mock('@/floor/storage', () => ({
  prepareImageForStorage: async () => ({ base64: 'AAAA', format: 'png' }),
}));

vi.mock('@/state/portraits', () => ({
  newPortraitKey: () => 'p-test-key',
  savePortrait: (...args: unknown[]) => savePortrait(...args),
}));

const modern: WorldAnchorConfig = { ...WORLD_PRESETS.modern, lockedByUser: true };
const ancient: WorldAnchorConfig = { ...WORLD_PRESETS.chinese_ancient, lockedByUser: true };

function entry(overrides: Partial<CharTagEntry> = {}): CharTagEntry {
  const fields = emptyCharFields();
  fields.hair = 'black hair, long hair';
  fields.eyes = 'brown eyes';
  fields.skin = 'pale skin';
  fields.body = 'slender';
  return { name: '温岚', fields, raw: '', nl: '', source: 'ai', desc: '', history: [], ...overrides };
}

describe('立绘', () => {
  it('角色块用固定外貌 + 世界观素服 + 固定微笑', () => {
    const tag = buildPortraitCharacterTag(entry(), modern);
    expect(tag).toContain('girl');
    expect(tag).toContain('long hair');
    expect(tag).toContain('plain white collared blouse');
    expect(tag).toContain('slight smile');
    expect(tag).not.toMatch(/blood|tears|bedroom/i);
  });

  it('古风世界观用汉服素服,不再塞牛仔裤运动鞋', () => {
    const tag = buildPortraitCharacterTag(entry(), ancient);
    expect(tag).toContain('plain white traditional hanfu');
    expect(tag).not.toMatch(/jeans|sneakers/);
  });

  it('半身构图过滤纯下身身材词', () => {
    const tall = entry();
    tall.fields.body = 'slender, long legs, thick thighs, wide hips';
    const tag = buildPortraitCharacterTag(tall, modern);
    expect(tag).not.toMatch(/long legs|thick thighs|wide hips/);
    expect(tag).toContain('slender');
  });

  it('男性条目用 boy 而不是 girl', () => {
    const male = entry();
    male.fields.sex = '1boy';
    expect(buildPortraitCharacterTag(male, modern).startsWith('boy')).toBe(true);
  });

  it('生成立绘:正脸平视半身构图 + 防鱼眼与防穿帮负面', async () => {
    generateImage.mockResolvedValueOnce({
      result: { url: 'data:image/png;base64,AAAA', filename: 'a.png', format: 'png', revoke: () => {} },
      seed: 4242,
      size: 'portrait',
      backend: 'nai',
      charactersApplied: true,
      meta: {},
    });
    const result = await generateCharacterPortrait(entry(), undefined, ancient);
    expect(result.key).toBe('p-test-key');
    expect(result.dataUrl).toBe('data:image/png;base64,AAAA');
    const input = generateImage.mock.calls.at(-1)?.[0] as {
      prompt: string;
      characters: Array<{ tag: string; uc?: string }>;
      size: string;
      extraNegative?: string;
    };
    expect(input.size).toBe('portrait');
    expect(input.prompt).toContain('cowboy shot');
    expect(input.prompt).toContain('straight-on');
    expect(input.prompt).toContain('eye-level');
    expect(input.prompt).not.toContain('long hair');
    expect(input.characters[0]?.tag).toContain('hanfu');
    expect(input.extraNegative).toContain('fisheye');
    expect(input.extraNegative).toContain('from above');
    expect(input.extraNegative).toContain('jeans');
    expect(input.characters[0]?.uc).toContain('fisheye');
    expect(savePortrait).toHaveBeenCalledWith('p-test-key', expect.objectContaining({ dataUrl: 'data:image/png;base64,AAAA' }));
  });
});

describe('portraitKey 持久化', () => {
  it('读档保留 portraitKey', () => {
    const [restored] = normalizeCharTagStore({ version: 3, entries: [{ ...entry(), portraitKey: 'p-1' }] });
    expect(restored?.portraitKey).toBe('p-1');
  });

  it('改名保存时不会把已有立绘丢掉', () => {
    const base = entry();
    upsertCharTag({ ...base, portraitKey: 'p-1' });
    upsertCharTag({ ...base }, base.name, { recordChanges: false });
    expect(findCharTag(base.name)?.portraitKey).toBe('p-1');
  });
});