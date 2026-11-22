import { describe, expect, it, vi } from 'vitest';

import { buildPortraitCharacterTag, generateCharacterPortrait } from '@/autoTag/portrait';
import { emptyCharFields, findCharTag, normalizeCharTagStore, upsertCharTag, type CharTagEntry } from '@/state/charTags';

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

function entry(overrides: Partial<CharTagEntry> = {}): CharTagEntry {
  const fields = emptyCharFields();
  fields.hair = 'black hair, long hair';
  fields.eyes = 'brown eyes';
  fields.skin = 'pale skin';
  fields.body = 'slender';
  return { name: '温岚', fields, raw: '', nl: '', source: 'ai', desc: '', history: [], ...overrides };
}

describe('立绘', () => {
  it('角色块用固定外貌 + 默认日常装 + 固定微笑', () => {
    const tag = buildPortraitCharacterTag(entry());
    expect(tag).toContain('girl');
    expect(tag).toContain('long hair');
    expect(tag).toContain('white shirt');
    expect(tag).toContain('slight smile');
    // 剧情相关词一律不进立绘
    expect(tag).not.toMatch(/blood|tears|bedroom/i);
  });

  it('男性条目用 boy 而不是 girl', () => {
    const male = entry();
    male.fields.sex = '1boy';
    expect(buildPortraitCharacterTag(male).startsWith('boy')).toBe(true);
  });

  it('生成立绘:Base 固定白底全身构图,角色走 char caption,存进本地缓存', async () => {
    generateImage.mockResolvedValueOnce({
      result: { url: 'data:image/png;base64,AAAA', filename: 'a.png', format: 'png', revoke: () => {} },
      seed: 4242,
      size: 'portrait',
      backend: 'nai',
      charactersApplied: true,
      meta: {},
    });
    const result = await generateCharacterPortrait(entry());
    expect(result.key).toBe('p-test-key');
    expect(result.dataUrl).toBe('data:image/png;base64,AAAA');
    const input = generateImage.mock.calls.at(-1)?.[0] as { prompt: string; characters: Array<{ tag: string }>; size: string };
    expect(input.size).toBe('portrait');
    expect(input.prompt).toContain('white background');
    expect(input.prompt).toContain('full body');
    expect(input.prompt).not.toContain('long hair');
    expect(input.characters[0]?.tag).toContain('long hair');
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