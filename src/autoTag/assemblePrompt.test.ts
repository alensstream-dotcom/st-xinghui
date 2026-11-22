import { describe, expect, it } from 'vitest';

import { assembleImageCharacters } from '@/autoTag/assemblePrompt';
import { parseImagePlan, type ImageInsertion } from '@/autoTag/protocol';
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
function disrupted(tag: string, stateTag: string): OutfitLayerState {
  return { tag, status: 'disheveled', stateTag };
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

function image(
  baseTag: string,
  characters: Array<{ name: string; tag?: string; nl?: string; uc?: string; omitFeatures?: string[] }>,
): ImageInsertion {
  return {
    position: 'P2',
    sourceLine: 1,
    tag: baseTag,
    nl: 'Base 自然语言。',
    negative: '',
    characters: characters.map(item => ({
      name: item.name,
      tag: item.tag ?? '',
      nl: item.nl ?? '',
      ...(item.uc ? { uc: item.uc } : {}),
      ...(item.omitFeatures ? { omitFeatures: item.omitFeatures } : {}),
    })),
    size: 'portrait',
  };
}

describe('本地提示词编译器：景别裁剪', () => {
  it('upper body 不写下半身五层,close-up + thigh focus 则照常写', () => {
    const entries = [entry('温岚', { sex: '1girl' })];
    const outfits = new Map([
      outfit('温岚', {
        outer: worn('white shirt'),
        bottom: worn('blue pleated skirt'),
        hosiery: worn('kneehighs'),
      }),
    ]);

    const upper = assembleImageCharacters(image('1girl, upper body', [{ name: '温岚' }]), entries, outfits);
    expect(upper.characters[0].tag).toContain('white shirt');
    expect(upper.characters[0].tag).not.toContain('skirt');
    expect(upper.characters[0].tag).not.toContain('kneehighs');

    const thigh = assembleImageCharacters(
      image('1girl, close-up, thigh focus', [{ name: '温岚' }]),
      entries,
      outfits,
    );
    expect(thigh.characters[0].tag).toContain('blue pleated skirt');
    expect(thigh.characters[0].tag).toContain('kneehighs');
  });
});

describe('本地提示词编译器：连身裙与外衣遮蔽', () => {
  it('连身裙在身上时胸罩与内裤不出现,也不写 bottomless', () => {
    const entries = [entry('温岚', { sex: '1girl' })];
    const outfits = new Map([
      outfit('温岚', {
        outer: worn('white dress'),
        bra: worn('pink bra'),
        panties: worn('white panties'),
      }),
    ]);
    const result = assembleImageCharacters(image('1girl, full body', [{ name: '温岚' }]), entries, outfits);
    expect(result.characters[0].tag).toContain('white dress');
    expect(result.characters[0].tag).not.toContain('pink bra');
    expect(result.characters[0].tag).not.toContain('white panties');
    expect(result.characters[0].tag).not.toContain('bottomless');
  });

  it('外套穿好时胸罩不写;外套敞开且胸罩脱下时写 bare breasts,品类压进 uc', () => {
    const entries = [entry('温岚', { sex: '1girl' })];
    const covered = assembleImageCharacters(
      image('1girl, upper body', [{ name: '温岚' }]),
      entries,
      new Map([outfit('温岚', { outer: worn('black jacket'), bra: worn('white bra') })]),
    );
    expect(covered.characters[0].tag).not.toContain('white bra');

    const open = assembleImageCharacters(
      image('1girl, upper body', [{ name: '温岚' }]),
      entries,
      new Map([
        outfit('温岚', {
          outer: disrupted('black jacket', 'hanging open'),
          bra: { tag: 'white bra', status: 'removed' },
        }),
      ]),
    );
    expect(open.characters[0].tag).toContain('bare breasts');
    expect(open.characters[0].tag).not.toContain('white bra');
    expect(open.characters[0].uc).toContain('bra');
    expect(open.characters[0].uc).toContain('underwear');
    expect(open.characters[0].uc).toContain('bikini top');
  });

  it('正向提示词里不出现 no bra / no panties 这类否定词', () => {
    const entries = [entry('温岚', { sex: '1girl' })];
    const result = assembleImageCharacters(
      image('1girl, full body', [{ name: '温岚' }]),
      entries,
      new Map([
        outfit('温岚', {
          outer: { tag: 'white shirt', status: 'removed' },
          bottom: { tag: 'blue skirt', status: 'removed' },
          bra: { tag: 'white bra', status: 'removed' },
          panties: { tag: 'white panties', status: 'removed' },
        }),
      ]),
    );
    const tag = result.characters[0].tag ?? '';
    expect(tag).not.toMatch(/\bno (?:bra|panties|skirt|pants|shirt)\b/);
    expect(tag).toContain('topless');
    expect(tag).toContain('bottomless');
    expect(result.characters[0].uc).toContain('panties');
  });
});

describe('本地提示词编译器：外貌与导演 tag 的合流', () => {
  it('顺序是固定外貌 → 五层服装 → 导演 tag,导演的动作与 source#/target# 必须留下', () => {
    const entries = [
      entry('温岚', {
        sex: '1girl',
        hair: 'long black hair',
        eyes: 'brown eyes',
        body: 'slender',
      }),
    ];
    const outfits = new Map([outfit('温岚', { outer: worn('white shirt'), bottom: worn('jeans') })]);
    const result = assembleImageCharacters(
      image('1girl, 1boy, bedroom, cowboy shot', [
        {
          name: '温岚',
          tag: 'parted lips, lying on back, spread legs, target#pushing into her',
          nl: 'She lies on her back.',
        },
      ]),
      entries,
      outfits,
    );
    const tag = result.characters[0].tag ?? '';
    const order = ['long black hair', 'brown eyes', 'slender', 'white shirt', 'jeans', 'target#pushing into her'];
    let cursor = -1;
    for (const token of order) {
      const at = tag.indexOf(token);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(tag).toContain('lying on back');
    expect(tag).not.toContain('mutual#');
    expect(result.characters[0].nl).toBe('She lies on her back.');
  });

  it('omitFeatures 指定眼镜时不写,不指定时自动恢复,且结果里不留 omitFeatures', () => {
    const entries = [entry('温岚', { sex: '1girl', hair: 'long black hair', extra: 'round eyewear' })];
    const omitted = assembleImageCharacters(
      image('1girl, upper body', [{ name: '温岚', omitFeatures: ['round eyewear'] }]),
      entries,
      new Map(),
    );
    expect(omitted.characters[0].tag).not.toContain('round eyewear');
    expect(omitted.characters[0].omitFeatures).toBeUndefined();

    const kept = assembleImageCharacters(
      image('1girl, upper body', [{ name: '温岚' }]),
      entries,
      new Map(),
    );
    expect(kept.characters[0].tag).toContain('round eyewear');
  });

  it('男角色跳过外貌与五层,只保留导演给的 boy 与局部动作', () => {
    // 导演原先爱把中文人名塞进标记位,那串现在会被清掉(见「导演标记清理」那组用例)
    const entries = [entry('李斌', { sex: '1boy', hair: 'short black hair', body: 'tall' })];
    const outfits = new Map([outfit('李斌', { outer: worn('black jacket') })]);
    const result = assembleImageCharacters(
      image('1girl, 1boy, bedroom, cowboy shot', [
        { name: '李斌', tag: '1boy, faceless male, penis, source#thrusting into her' },
      ]),
      entries,
      outfits,
    );
    expect(result.characters[0].tag).toBe('1boy, faceless male, penis, source#thrusting into her');
    expect(result.characters[0].uc).toBeUndefined();
  });

  it('多人同框防串色:各自 uc 含对方的发型/眼镜,不含自己的', () => {
    const entries = [
      entry('温岚', { sex: '1girl', hair: 'long blue hair, twintails' }),
      entry('顾遥', { sex: '1girl', hair: 'black hair, hair bun', extra: 'round eyewear' }),
    ];
    const outfits = new Map([
      outfit('温岚', { outer: worn('white shirt') }),
      outfit('顾遥', { outer: worn('black dress') }),
    ]);
    const result = assembleImageCharacters(
      image('2girls, living room, full body', [{ name: '温岚' }, { name: '顾遥' }]),
      entries,
      outfits,
    );
    const her = result.characters.find(item => item.name === '温岚');
    const other = result.characters.find(item => item.name === '顾遥');
    expect(her?.uc).toContain('round eyewear');
    expect(her?.uc).toContain('hair bun');
    expect(her?.uc).not.toContain('twintails');
    expect(other?.uc).toContain('twintails');
    expect(other?.uc).not.toContain('round eyewear');
  });
});

describe('建档容错与导演标记清理', () => {
  it('漏写 sex 的 field:"new" 也能入库,并拼出固定外貌', () => {
    const raw =
      '{"images":[],"changes":[{"name":"温岚","field":"new","position":"P1","fields":{"hair":"long black hair, straight hair","body":"slender"}}]}';
    const segments = [{ id: 'P1', sourceLine: 0, text: '第一幕结束' }];
    const plan = parseImagePlan(raw, segments, 0, 1);
    const change = plan.changes.find(item => item.field === 'new');
    expect(change).toBeTruthy();
    const fields = JSON.parse(change!.value) as Record<string, string>;
    const profile: CharTagEntry = { ...entry('温岚'), fields: { ...emptyCharFields(), ...fields } };

    const result = assembleImageCharacters(
      image('1girl, bedroom, upper body', [{ name: '温岚', tag: 'parted lips' }]),
      [profile],
      new Map(),
    );
    expect(result.characters[0].tag).toContain('girl');
    expect(result.characters[0].tag).toContain('long black hair');
    expect(result.characters[0].tag).toContain('slender');
  });

  it('带中文人名的 source# / target# / mutual# 会被清掉,英文原样保留', () => {
    const entries = [
      entry('温岚', { sex: '1girl' }),
      entry('李斌', { sex: '1boy' }),
    ];
    const result = assembleImageCharacters(
      image('1girl, 1boy, bedroom, upper body', [
        { name: '温岚', tag: 'parted lips, target#温岚, source#李斌, mutual#舔吮' },
        { name: '李斌', tag: '1boy, faceless male, source#李斌' },
      ]),
      entries,
      new Map(),
    );
    const her = result.characters.find(item => item.name === '温岚');
    const him = result.characters.find(item => item.name === '李斌');
    expect(her?.tag).toContain('parted lips');
    expect(her?.tag).not.toContain('target#温岚');
    expect(her?.tag).not.toContain('source#李斌');
    expect(her?.tag).not.toContain('mutual#舔吮');
    expect(him?.tag).toBe('1boy, faceless male');
  });

  it('正确的英文 source#licking nipple / target#licking nipple 原样保留', () => {
    const entries = [
      entry('温岚', { sex: '1girl' }),
      entry('李斌', { sex: '1boy' }),
    ];
    const result = assembleImageCharacters(
      image('1girl, 1boy, bedroom, upper body', [
        { name: '温岚', tag: 'arched back, target#licking nipple' },
        { name: '李斌', tag: '1boy, faceless male, source#licking nipple' },
      ]),
      entries,
      new Map(),
    );
    const her = result.characters.find(item => item.name === '温岚');
    const him = result.characters.find(item => item.name === '李斌');
    expect(her?.tag).toBe('girl, arched back, target#licking nipple');
    expect(him?.tag).toBe('1boy, faceless male, source#licking nipple');
  });
});
