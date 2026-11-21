import { describe, expect, it } from 'vitest';

import { assembleCharacterPrompt, assembleImagePrompts, countHeadcounts, type AssembleInput } from '@/autoTag/assemblePrompt';
import { emptyCharFields, type CharTagEntry } from '@/state/charTags';
import type { CharOutfitState, OutfitLayerState } from '@/state/outfitState';

function entry(name: string, fields: Partial<Record<string, string>> = {}): CharTagEntry {
  return {
    name,
    fields: { ...emptyCharFields(), ...fields },
    raw: '',
    nl: '',
    source: 'manual',
    desc: '',
    history: [],
  };
}

function worn(tag: string): OutfitLayerState {
  return { tag, status: 'worn' };
}
function off(tag: string): OutfitLayerState {
  return { tag, status: 'removed' };
}

function outfit(name: string, layers: Partial<Record<string, OutfitLayerState>>): [string, CharOutfitState] {
  return [
    name,
    {
      name,
      layers: {
        outer: off(''),
        bra: off(''),
        bottom: off(''),
        panties: off(''),
        hosiery: off(''),
        ...layers,
      } as CharOutfitState['layers'],
    },
  ];
}

function input(partial: Partial<AssembleInput>): AssembleInput {
  return {
    entries: [],
    outfit: new Map(),
    director: [],
    scale: 'cowboy shot',
    ...partial,
  };
}

describe('本地提示词编译器', () => {
  it('半身景别把下装与袜子裁掉,但仍把品类压进 uc,防止下一张凭空补一条裙子', () => {
    const outfitMap = new Map([
      outfit('温岚', {
        outer: worn('white shirt'),
        bottom: worn('blue pleated skirt'),
        hosiery: worn('kneehighs'),
      }),
    ]);
    const [result] = assembleImagePrompts(
      input({
        entries: [entry('温岚', { sex: '1girl', hair: 'long black hair' })],
        outfit: outfitMap,
        director: [{ name: '温岚', expression: 'blush' }],
        scale: 'upper body',
      }),
    );
    expect(result.tag).toContain('white shirt');
    expect(result.tag).not.toContain('skirt');
    expect(result.tag).not.toContain('kneehighs');
    expect(result.uc).toContain('skirt');
  });

  it('连身裙在身上时胸罩与内裤不出现(它们被裙子盖住),账本里仍记着', () => {
    const outfitMap = new Map([
      outfit('温岚', {
        outer: worn('white shirt'),
        bottom: worn('floral dress'),
        bra: worn('pink bra'),
        panties: worn('white panties'),
      }),
    ]);
    const [result] = assembleImagePrompts(
      input({
        entries: [entry('温岚', { sex: '1girl' })],
        outfit: outfitMap,
        director: [{ name: '温岚' }],
        scale: 'full body',
      }),
    );
    expect(result.tag).toContain('floral dress');
    expect(result.tag).not.toContain('pink bra');
    expect(result.tag).not.toContain('white panties');
  });

  it('脱掉的内裤写 no panties 并把 panties 压进 uc(防 NAI 按常识画回来)', () => {
    const outfitMap = new Map([
      outfit('温岚', {
        outer: worn('white shirt'),
        bottom: worn('blue pleated skirt'),
        panties: { tag: 'white panties', status: 'removed' },
      }),
    ]);
    const [result] = assembleImagePrompts(
      input({
        entries: [entry('温岚', { sex: '1girl' })],
        outfit: outfitMap,
        director: [{ name: '温岚' }],
        scale: 'full body',
      }),
    );
    expect(result.tag).toContain('no panties');
    expect(result.uc).toContain('panties');
  });

  it('omitFeatures 指定头发时不写发色瞳色,别人不受影响', () => {
    const results = assembleImagePrompts(
      input({
        entries: [entry('温岚', { sex: '1girl', hair: 'long black hair', eyes: 'brown eyes' })],
        director: [{ name: '温岚', omitFeatures: ['hair', 'eyes'] }],
        scale: 'cowboy shot',
      }),
    );
    expect(results[0].tag).not.toContain('black hair');
    expect(results[0].tag).not.toContain('brown eyes');
    expect(results[0].omitFeatures).toEqual(['hair', 'eyes']);
  });

  it('多人防串色:只把她自己的衣服写给她,同时也排除「自己也在穿」的同品类', () => {
    const outfitMap = new Map([
      outfit('温岚', { outer: worn('white shirt'), bottom: worn('blue pleated skirt') }),
      outfit('李斌', { outer: worn('black jacket'), bottom: worn('jeans') }),
    ]);
    const results = assembleImagePrompts(
      input({
        entries: [entry('温岚', { sex: '1girl' }), entry('李斌', { sex: '1boy' })],
        outfit: outfitMap,
        director: [{ name: '温岚' }, { name: '李斌' }],
        scale: 'full body',
      }),
    );
    const her = results.find(item => item.name === '温岚');
    const him = results.find(item => item.name === '李斌');
    expect(her?.tag).toContain('white shirt');
    expect(her?.tag).not.toContain('black jacket');
    expect(her?.uc).toContain('jacket');
    expect(him?.tag).toContain('black jacket');
    // 两人都穿 bottom 类:她的 uc 里不该出现 skirt,否则会把自己裙子压掉
    expect(her?.uc).not.toContain('skirt');
  });

  it('nl 只写一句:动作落在谁身上写清楚,没有动作就是空串', () => {
    const withAction = assembleCharacterPrompt(
      input({}),
      { name: '温岚', action: 'kneels on the bed', source: '温岚' },
      [],
    );
    expect(withAction.nl).toBe('Kneels on the bed.');
    const noAction = assembleCharacterPrompt(input({}), { name: '温岚' }, []);
    expect(noAction.nl).toBe('');
  });
});
describe('人数词累加(不是去重)', () => {
  it('两个女角是 2girls,不是一个 1girl', () => {
    expect(countHeadcounts(['1girl, black hair', '1girl, silver hair'])).toEqual(['2girls']);
  });

  it('一女一男分开写', () => {
    expect(countHeadcounts(['1girl, white shirt', '1boy, black jacket'])).toEqual(['1girl', '1boy']);
  });

  it('三人以上与其它性别也照常', () => {
    expect(countHeadcounts(['1girl', '1girl', '1girl'])).toEqual(['3girls']);
    expect(countHeadcounts(['1boy', '1boy', '1other'])).toEqual(['2boys', '1other']);
  });

  it('没有血统词就不发明人数', () => {
    expect(countHeadcounts(['black hair, white dress'])).toEqual([]);
  });
});
