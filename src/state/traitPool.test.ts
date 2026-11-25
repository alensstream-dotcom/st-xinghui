import { describe, expect, it, vi } from 'vitest';

const getContextMock = vi.hoisted(() => vi.fn());

vi.mock('@/st/context', () => ({ getContext: getContextMock }));

import {
  addTraitItems,
  hydrateTraitPool, saveTraitPool, allocateNewProfileFaces,
  defaultTraitPool,
  rollTraitCandidates,
  scopesForPreset,
  removeTraitItem,
  toggleTraitItem,
  traitCandidateBlock,
  traitPool,
  TRAIT_CATEGORIES,
  type TraitCategoryKey,
} from './traitPool';
import type { CharChange } from '@/autoTag/protocol';
import type { CharTagEntry } from '@/state/charTags';

function clone(): Record<TraitCategoryKey, ReturnType<typeof defaultTraitPool>[TraitCategoryKey]> {
  return JSON.parse(JSON.stringify(defaultTraitPool()));
}

describe('外貌随机池', () => {
  it('14 类词池都有词条，且每类都能取到中文标签', () => {
    const pool = defaultTraitPool();
    expect(TRAIT_CATEGORIES).toHaveLength(14);
    for (const meta of TRAIT_CATEGORIES) {
      expect(pool[meta.key].length, meta.key).toBeGreaterThan(0);
      expect(pool[meta.key][0]?.label, meta.key).toBeTruthy();
    }
  });

  it('按世界观过滤：古风池里没有 modern 专属词（t-shirt / hoodie 之类）', () => {
    const allowed = scopesForPreset('chinese_ancient');
    expect(allowed).toContain('ancient');
    expect(allowed).not.toContain('modern');
    const pool = clone();
    pool.hairStyle = pool.hairStyle.map(item =>
      item.tag === 'twin braids' ? { ...item, scope: 'modern' as const } : item,
    );
    const groups = rollTraitCandidates('chinese_ancient', [], 3, pool);
    for (const group of groups) expect(group.hair).not.toContain('twin braids');
  });

  it('随机抽 3 组完整候选包，hair 至少含发色、eyes 含两项', () => {
    const groups = rollTraitCandidates('modern', [], 3);
    expect(groups).toHaveLength(3);
    for (const group of groups) {
      expect(group.hair.split(', ').length).toBeGreaterThanOrEqual(3);
      expect(group.eyes.split(', ').length).toBe(2);
      expect(group.body.length).toBeGreaterThan(0);
    }
  });

  it('避开已建档角色用过的词（用量最低的优先）', () => {
    const entries = [
      { name: '甲', fields: { hair: 'long black hair, straight hair', eyes: 'brown eyes', extra: '' } },
      { name: '乙', fields: { hair: 'long black hair, straight hair', eyes: 'brown eyes', extra: '' } },
    ] as unknown as CharTagEntry[];
    const groups = rollTraitCandidates('modern', entries, 1);
    expect(groups[0]?.hair ?? '').not.toContain('black hair');
  });

  it('禁用的词不会出现在候选里，自定义添加的词会生效', () => {
    const first = traitPool.hairColor[0];
    toggleTraitItem('hairColor', first.id);
    try {
      const groups = rollTraitCandidates('modern', [], 3);
      for (const group of groups) expect(group.hair).not.toContain(first.tag);
    } finally {
      toggleTraitItem('hairColor', first.id);
    }

    const added = addTraitItems('hairColor', '雾霾蓝', 'misty blue hair');
    expect(added).toBeGreaterThan(0);
    const custom = traitPool.hairColor.find(item => item.tag === 'misty blue hair');
    expect(custom).toBeTruthy();
    removeTraitItem('hairColor', custom!.id);
    expect(traitPool.hairColor.some(item => item.tag === 'misty blue hair')).toBe(false);
  });

  it('候选包文本带标题与使用规则，空池给兜底提示', () => {
    const block = traitCandidateBlock('chinese_ancient', [], 2);
    expect(block).toContain('真随机抽卡候选池');
    expect(block).toContain('候选甲：');
    expect(block).toContain('正文写死的维度严格照正文');
  });
});
it('按真实保存格式恢复禁用和自定义词，旧格式只补新增类别、保留主动清空的词池', () => {
  const ctx = { extensionSettings: {} as Record<string, unknown>, saveSettingsDebounced: vi.fn() };
  getContextMock.mockReturnValue(ctx);
  try {
    traitPool.hairColor[0].enabled = false;
    addTraitItems('accessory', '自设', 'amber brooch');
    saveTraitPool();
    traitPool.hairColor[0].enabled = true;
    traitPool.accessory = [];
    hydrateTraitPool();
    expect(traitPool.hairColor[0].enabled).toBe(false);
    expect(traitPool.accessory.some(t => t.tag === 'amber brooch')).toBe(true);
    ctx.extensionSettings.xinghui_trait_pool = { hairColor: [], skin: [] };
    hydrateTraitPool();
    expect(traitPool.hairColor).toEqual([]);
    expect(traitPool.faceShape.length).toBeGreaterThan(0);
  } finally {
    getContextMock.mockReturnValue(undefined);
    hydrateTraitPool();
  }
});

it('同楼同人设也可分配不同脸型眉形；既有档案、指定外貌与同人受到保护', () => {
  const design = { hair: 'long black hair, low bun', eyes: 'brown eyes', body: 'mature female, large breasts', extra: 'earrings' };
  const make = (name: string, fields = design): CharChange => ({
    name, field: 'new', position: 'P1', sourceLine: 0, reason: '', value: JSON.stringify(fields),
    faceOptions: ['round face', 'oval face', 'thick eyebrows', 'arched eyebrows'],
  });
  const records = [make('甲'), make('乙'), make('丙', { ...design, extra: 'oval face, thin eyebrows' }), make('旧')];
  const fandom = make('同人'); fandom.value = JSON.stringify({ ...design, fandom: 'character (series)' });
  records.push(fandom);
  allocateNewProfileFaces(records, [{ name: '旧', fields: design } as CharTagEntry], 'chinese_ancient');
  const looks = records.map(c => JSON.parse(c.value));
  expect(looks[0].extra).toContain('round face');
  expect(looks[1].extra).toContain('oval face');
  expect(looks[0].extra).toContain('thick eyebrows');
  expect(looks[1].extra).toContain('arched eyebrows');
  expect(looks[2].extra).toBe('oval face, thin eyebrows');
  expect(looks[3]).toEqual(design);
  expect(looks[4].extra).toBe(design.extra);
  expect(looks.every(v => v.hair === design.hair && v.body === design.body)).toBe(true);
});

it('发色只有一种时仍按其他维度分别抽候选', () => {
  const pool = clone();
  pool.hairColor = [pool.hairColor[0]];
  const looks = rollTraitCandidates('chinese_ancient', [], 3, pool);
  expect(looks).toHaveLength(3);
  expect(new Set(looks.map(v => v.eyes.split(', ')[1])).size).toBe(3);
  expect(new Set(looks.map(v => v.body.split(', ')[0])).size).toBe(3);
});
