import { describe, expect, it } from 'vitest';

import { assembleImageCharacters, isOnePieceOuter, stripLeakedAppearanceAndOutfit } from '@/autoTag/assemblePrompt';
import { parseImagePlan, type ImageInsertion } from '@/autoTag/protocol';
import { emptyCharFields, type CharTagEntry } from '@/state/charTags';
import type { CharOutfitState, OutfitLayerState } from '@/state/outfitState';
import { WORLD_PRESETS, applyDetectedWorldPreset, defaultWorldAnchor } from '@/state/worldAnchor';

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

describe('本地提示词编译器：脱衣后的服装漂移屏蔽', () => {
  it('外衣判定 removed 时,把衬衣/外套类压进角色负面,不管内衣状态', () => {
    const entries = [entry('温岚', { sex: '1girl' })];
    const nakedTop = assembleImageCharacters(
      image('1girl, upper body', [{ name: '温岚' }]),
      entries,
      new Map([outfit('温岚', { outer: { tag: 'white shirt', status: 'removed' }, bra: { tag: 'pink bra', status: 'removed' } })]),
    );
    const uc = nakedTop.characters[0].uc ?? '';
    for (const word of ['shirt', 'blouse', 'dress', 'coat', 'robe', 'hanfu']) expect(uc).toContain(word);
    expect(nakedTop.characters[0].tag).toContain('topless');

    // 上半身镜头里也必须有这条屏蔽词,否则 NAI 会照世界观默认衣装补一件上衣
    const stillPinned = assembleImageCharacters(
      image('1girl, close-up', [{ name: '温岚' }]),
      entries,
      new Map([outfit('温岚', { outer: { tag: 'white shirt', status: 'removed' }, bra: worn('pink bra') })]),
    );
    expect(stillPinned.characters[0].uc).toContain('shirt');
    expect(stillPinned.characters[0].tag).toContain('pink bra');
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

describe('景别裁切：下身词与鞋袜', () => {
  it('upper body 时外貌里的 long legs / thick thighs 一并清掉,full body 保留', () => {
    const entries = [entry('温岚', { sex: '1girl', hair: 'long black hair', body: 'long legs, thick thighs, slender' })];
    const upper = assembleImageCharacters(image('1girl, upper body', [{ name: '温岚' }]), entries, new Map());
    expect(upper.characters[0].tag).toContain('slender');
    expect(upper.characters[0].tag).not.toContain('long legs');
    expect(upper.characters[0].tag).not.toContain('thick thighs');

    const full = assembleImageCharacters(image('1girl, full body', [{ name: '温岚' }]), entries, new Map());
    expect(full.characters[0].tag).toContain('long legs');
  });

  it('cowboy shot / medium shot 时 hosiery 里的鞋子词被清掉,丝袜本身保留', () => {
    const entries = [entry('温岚', { sex: '1girl' })];
    const outfits = new Map([
      outfit('温岚', { hosiery: worn('20 denier sheer black pantyhose, black leather loafers') }),
    ]);
    const cowboy = assembleImageCharacters(image('1girl, cowboy shot', [{ name: '温岚' }]), entries, outfits);
    expect(cowboy.characters[0].tag).toContain('sheer black pantyhose');
    expect(cowboy.characters[0].tag).not.toContain('loafers');

    const wide = assembleImageCharacters(image('1girl, wide shot', [{ name: '温岚' }]), entries, outfits);
    expect(wide.characters[0].tag).toContain('loafers');
  });
});

describe('核心外貌锁死：omitFeatures 只摘配饰', () => {
  it('omitFeatures 写了 hair / eyes 也不许摘掉发型瞳色，只摘 extra 里的发饰', () => {
    const entries = [
      entry('温岚', {
        sex: '1girl',
        hair: 'long black hair, straight hair',
        eyes: 'brown eyes, tareme',
        skin: 'fair skin',
        body: 'petite, small breasts',
        extra: 'hairpin, round eyewear, mole under eye',
      }),
    ];
    const result = assembleImageCharacters(
      image('1girl, upper body', [{ name: '温岚', omitFeatures: ['hair', 'eyes', 'hairpin', 'round eyewear'] }]),
      entries,
      new Map(),
    );
    const tag = result.characters[0].tag;
    expect(tag).toContain('long black hair');
    expect(tag).toContain('straight hair');
    expect(tag).toContain('brown eyes');
    expect(tag).toContain('fair skin');
    expect(tag).toContain('small breasts');
    expect(tag).not.toContain('hairpin');
    expect(tag).not.toContain('round eyewear');
    expect(tag).toContain('mole under eye');
  });
});

describe('状态表与导演穿脱冲突仲裁', () => {
  it('bra 穿着时导演写的 bare breasts / topless / nipples 全被剔掉', () => {
    const entries = [entry('温岚', { sex: '1girl', hair: 'long black hair' })];
    const outfits = new Map([
      outfit('温岚', { bra: worn('white cotton bra'), bottom: worn('navy wool skirt') }),
    ]);
    const result = assembleImageCharacters(
      image('1girl, cowboy shot', [
        { name: '温岚', tag: 'blush, bare breasts, topless, nipples, sitting' },
      ]),
      entries,
      outfits,
    );
    const tag = result.characters[0].tag;
    expect(tag).not.toContain('bare breasts');
    expect(tag).not.toContain('topless');
    expect(tag).not.toContain('nipples');
    expect(tag).toContain('white cotton bra');
    expect(tag).toContain('sitting');
  });

  it('下装穿着时导演写的 bottomless / nude / pussy 被剔掉', () => {
    const entries = [entry('温岚', { sex: '1girl' })];
    const outfits = new Map([
      outfit('温岚', { bottom: worn('navy wool trousers'), panties: worn('white cotton panties') }),
    ]);
    const result = assembleImageCharacters(
      image('1girl, full body', [{ name: '温岚', tag: 'bottomless, nude, pussy, standing' }]),
      entries,
      outfits,
    );
    const tag = result.characters[0].tag;
    expect(tag).not.toContain('bottomless');
    expect(tag).not.toContain('nude');
    expect(tag).not.toContain('pussy');
    expect(tag).toContain('navy wool trousers');
  });
});

describe('连身长袍压住短裙', () => {
  it('isOnePieceOuter 认得道袍/斗篷/风衣', () => {
    expect(isOnePieceOuter('white silk taoist robe')).toBe(true);
    expect(isOnePieceOuter('long black cloak')).toBe(true);
    expect(isOnePieceOuter('beige trench coat')).toBe(true);
    expect(isOnePieceOuter('white cotton shirt')).toBe(false);
  });

  it('长袍穿好未掀开时，bottom 里的 short skirt 词不出现', () => {
    const entries = [entry('苏青', { sex: '1girl' })];
    const outfits = new Map([
      outfit('苏青', {
        outer: worn('plain white silk taoist robe, ankle-length'),
        bottom: worn('black pleated miniskirt'),
      }),
    ]);
    const result = assembleImageCharacters(image('1girl, full body', [{ name: '苏青' }]), entries, outfits);
    expect(result.characters[0].tag).toContain('taoist robe');
    expect(result.characters[0].tag).not.toContain('miniskirt');
    expect(result.characters[0].tag).not.toContain('pleated skirt');
  });
});

describe('世界观防穿帮豁免', () => {
  it('正文明确写了的牛仔裤不再被古风负面屏蔽', () => {
    const world = { ...defaultWorldAnchor(), ...WORLD_PRESETS.chinese_ancient, presetId: 'chinese_ancient' as const, lockedByUser: true };
    const entries = [entry('苏青', { sex: '1girl' })];
    const outfits = new Map([outfit('苏青', { bottom: worn('blue denim jeans') })]);
    const result = assembleImageCharacters(
      image('1girl, full body', [{ name: '苏青' }]),
      entries,
      outfits,
      world,
    );
    const uc = result.characters[0].uc ?? '';
    expect(uc).not.toContain('jeans');
    expect(uc).toContain('sneakers');
  });
});

describe('状态表唯一权威：导演偷塞的外貌与服装全部剥离', () => {
  it('已建档女角 + 已有服装状态时，导演写的 1girl / blue eyes / large breasts / white dress / hanfu 全被剥掉', () => {
    const entries = [
      entry('温岚', {
        sex: '1girl',
        hair: 'long black hair, straight hair, hair down, blunt bangs',
        eyes: 'brown eyes, tareme',
        skin: 'fair skin',
        body: 'petite, small breasts',
        extra: 'mole under eye',
      }),
    ];
    const outfits = new Map([
      outfit('温岚', {
        outer: worn('plain white silk taoist robe, long sleeves, cross-collar, ankle-length'),
        bra: worn('white cotton dudou'),
        bottom: off(''),
        panties: worn('white silk drawers'),
        hosiery: worn('white silk socks'),
      }),
    ]);
    const result = assembleImageCharacters(
      image('1girl, cowboy shot', [
        {
          name: '温岚',
          tag: '1girl, blue eyes, large breasts, white dress, hanfu, blush, looking up, kneeling, target#pulling her close',
        },
      ]),
      entries,
      outfits,
    );
    const tag = result.characters[0].tag;
    // 角色库外貌保留
    expect(tag).toContain('long black hair');
    expect(tag).toContain('brown eyes');
    expect(tag).toContain('small breasts');
    // 状态表五层保留（道袍穿好时肚兜属被遮住的内层,按可见性规则不进 tag）
    expect(tag).toContain('taoist robe');
    expect(tag).toContain('white silk socks');
    expect(tag).not.toContain('white cotton dudou');
    // 导演偷塞的外貌/服装/人数词被清掉
    expect(tag).not.toContain('blue eyes');
    expect(tag).not.toContain('large breasts');
    expect(tag).not.toContain('white dress');
    expect(tag).not.toContain('hanfu');
    expect(tag.split(',').map(item => item.trim())).not.toContain('1girl');
    // 纯动作/表情/标记保留
    expect(tag).toContain('blush');
    expect(tag).toContain('looking up');
    expect(tag).toContain('kneeling');
    expect(tag).toContain('target#pulling her close');
  });

  it('stripLeakedAppearanceAndOutfit 不动标记词与「手在头发里」这类接触动作', () => {
    const kept = stripLeakedAppearanceAndOutfit(
      ['1girl', 'silver hair', 'blue eyes', 'slender', 'white dress', 'hand in hair', 'holding her hair', 'blush'],
      true,
      true,
    );
    expect(kept).toEqual(['hand in hair', 'holding her hair', 'blush']);
  });
});

describe('状态表 priority：冲突只剔导演的词', () => {
  it('bra worn 与导演 bare breasts 冲突时保留 white cotton bra、剔掉 bare breasts', () => {
    const entries = [entry('温岚', { sex: '1girl', hair: 'long black hair', eyes: 'brown eyes' })];
    const outfits = new Map([outfit('温岚', { bra: worn('white cotton bra, plunge neckline') })]);
    const result = assembleImageCharacters(
      image('1girl, upper body', [{ name: '温岚', tag: 'bare breasts, topless, blush' }]),
      entries,
      outfits,
    );
    const tag = result.characters[0].tag;
    expect(tag).toContain('white cotton bra');
    expect(tag).not.toContain('bare breasts');
    expect(tag).not.toContain('topless');
    expect(tag).toContain('blush');
  });
});

describe('比例防畸变', () => {
  it('站着 + 跪着的高低差画面会给角色负面补 giantess / size difference / miniature', () => {
    const entries = [entry('温岚', { sex: '1girl', hair: 'long black hair' })];
    const result = assembleImageCharacters(
      image('1girl, 1boy, bedroom, cowboy shot', [
        { name: '温岚', tag: 'kneeling, blush' },
        { name: '李斌', tag: '1boy, faceless male, standing', uc: '' },
      ]),
      entries,
      new Map(),
    );
    const uc = result.characters[0].uc ?? '';
    expect(uc).toContain('giantess');
    expect(uc).toContain('size difference');
    expect(uc).toContain('miniature');
  });

  it('没有高低差时不会无端加比例负面', () => {
    const entries = [entry('温岚', { sex: '1girl', hair: 'long black hair' })];
    const result = assembleImageCharacters(
      image('1girl, upper body', [{ name: '温岚', tag: 'standing, blush' }]),
      entries,
      new Map(),
    );
    expect(result.characters[0].uc ?? '').not.toContain('giantess');
  });
});

describe('P0 回归：全裸/遮蔽/脱下装的三处边界', () => {
  it('五层全 removed 时仍剥离导演偷塞的衣物词（hasOutfitState 不能因为 tag 空判 false）', () => {
    const entries = [entry('温岚', { sex: '1girl', hair: 'long black hair' })];
    const nude = new Map([outfit('温岚', {})]);
    const result = assembleImageCharacters(
      image('1girl, 1boy, bedroom, upper body', [
        { name: '温岚', tag: '1girl, white dress, hanfu, blue eyes, lying on bed' },
      ]),
      entries,
      nude,
    );
    const tag = result.characters[0].tag;
    expect(tag).not.toContain('white dress');
    expect(tag).not.toContain('hanfu');
    expect(tag).not.toContain('blue eyes');
    // 动作与姿势必须留着,别把导演写对的也一起删掉
    expect(tag).toContain('lying on bed');
  });

  it('外衣穿着时 cover.upper 为 true：导演写的 topless 被剔掉', () => {
    const entries = [entry('温岚', { sex: '1girl', hair: 'long black hair' })];
    const outerOn = new Map([outfit('温岚', { outer: worn('black jacket'), bra: off('white bra') })]);
    const result = assembleImageCharacters(
      image('1girl, upper body', [{ name: '温岚', tag: 'topless, blush' }]),
      entries,
      outerOn,
    );
    expect(result.characters[0].tag).not.toContain('topless');
    expect(result.characters[0].tag).toContain('blush');
  });

  it('下装已脱但仍穿内裤时,负面照样压 skirt/pants/shorts', () => {
    const entries = [entry('温岚', { sex: '1girl', hair: 'long black hair' })];
    const bottomOff = new Map([
      outfit('温岚', { outer: worn('white shirt'), bottom: off('blue pleated skirt'), panties: worn('white panties') }),
    ]);
    const result = assembleImageCharacters(
      image('1girl, full body', [{ name: '温岚' }]),
      entries,
      bottomOff,
    );
    const uc = result.characters[0].uc ?? '';
    expect(uc).toContain('skirt');
    expect(uc).toContain('pants');
    expect(uc).toContain('shorts');
    expect(result.characters[0].tag).toContain('white panties');
  });
});

describe('P0 回归：首楼世界观当楼生效', () => {
  it('检测到 chinese_ancient 后同一楼拼装就带古风防穿帮负面，且不压正文已写的汉服', () => {
    const world = applyDetectedWorldPreset('chinese_ancient');
    const entries = [entry('温岚', { sex: '1girl', hair: 'long black hair' })];
    const wardrobe = new Map([outfit('温岚', { outer: worn('plain white traditional hanfu') })]);
    const withWorld = assembleImageCharacters(
      image('1girl, full body', [{ name: '温岚' }]),
      entries,
      wardrobe,
      world,
    );
    expect(withWorld.characters[0].tag).toContain('hanfu');
    expect(withWorld.characters[0].uc ?? '').toContain('jeans');
    // 正文明写了汉服，世界观负面就不能再把 hanfu 当穿帮词压掉
    expect(withWorld.characters[0].uc ?? '').not.toContain('hanfu');

    const withoutWorld = assembleImageCharacters(image('1girl, full body', [{ name: '温岚' }]), entries, wardrobe);
    expect(withoutWorld.characters[0].uc ?? '').not.toContain('jeans');
  });
});
