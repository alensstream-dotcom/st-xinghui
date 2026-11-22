import { describe, expect, it, vi } from 'vitest';
import { buildRerollMessages, parseRerolledAppearance, REROLL_FIELDS } from './rerollChar';
import { WORLD_PRESETS } from '@/state/worldAnchor';
import type { CharTagEntry } from '@/state/charTags';

vi.mock('@/st/context', () => ({ getContext: () => null }));
vi.mock('@/state/settings', () => ({
  settings: { excludes: { customStripTags: [] } },
  getTagGenChannel: () => null,
}));
vi.mock('@/api/client', () => ({
  requestCompletion: async () => '',
  requestViaMainApi: async () => '',
}));

const valid =
  '{"hair":"short hair, black hair, straight hair, high ponytail, blunt bangs","eyes":"amber eyes, tsurime","skin":"tan","body":"petite, athletic, toned, small breasts","extra":"mole under eye, choker"}';

describe('重Roll形象解析', () => {
  it('剥掉 thinking 段与代码块后取 JSON', () => {
    const raw = `<thinking>\n先看正文再设计。\n</thinking>\n\`\`\`json\n${valid}\n\`\`\``;
    const result = parseRerolledAppearance(raw);
    expect(result.hair).toContain('high ponytail');
    expect(result.eyes).toBe('amber eyes, tsurime');
    expect(result.skin).toBe('tan');
    expect(result.extra).toContain('mole under eye');
  });

  it('容忍前后废话与多余字段,只留五个固定外貌字段', () => {
    const raw = `好的,方案如下:\n${valid.slice(0, -1)},"fandom":"x (y)"}\n希望满意。`;
    const result = parseRerolledAppearance(raw);
    expect(Object.keys(result).sort()).toEqual([...REROLL_FIELDS].sort());
  });

  it('漏字段直接报错,不静默填空', () => {
    const raw = '{"hair":"long hair, brown hair, hair down","eyes":"brown eyes, tareme","skin":"fair skin","body":"tall female, medium breasts"}';
    expect(() => parseRerolledAppearance(raw)).toThrow(/漏写了 extra/);
  });

  it('hair 里没有 hair 原子词时报错', () => {
    const raw = '{"hair":"black","eyes":"brown eyes, tareme","skin":"fair skin","body":"petite, slender","extra":"fang"}';
    expect(() => parseRerolledAppearance(raw)).toThrow(/hair/);
  });
});

describe('重Roll 注入世界观', () => {
  const entry: CharTagEntry = {
    name: '温岚',
    fields: { fandom: '', sex: '1girl', hair: 'long black hair', eyes: 'brown eyes', skin: 'pale skin', body: 'slender', extra: '', outfit: '' },
    raw: '',
    nl: '',
    source: 'manual',
    desc: '',
    history: [],
  };

  it('提示词带上世界观边界,古风不再允许现代发色与配饰越界', () => {
    const world = { ...WORLD_PRESETS.chinese_ancient, lockedByUser: true };
    const messages = buildRerollMessages({ name: '温岚', currentEntry: entry, otherEntries: [], world, userHint: '更冷一点' });
    const body = messages.at(-1)?.content ?? '';
    expect(body).toContain('本聊天世界观');
    expect(body).toContain('中式古风');
    expect(body).toContain('hanfu');
    expect(body).toContain('严禁现代眼镜');
    expect(body).toContain('更冷一点');
  });

  it('不传世界观时按默认现代注入,不会留空', () => {
    const messages = buildRerollMessages({ name: '温岚', currentEntry: entry, otherEntries: [] });
    const body = messages.at(-1)?.content ?? '';
    expect(body).toContain('本聊天世界观');
    expect(body).toContain('现代');
  });
});
