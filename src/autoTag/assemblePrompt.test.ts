import { describe, expect, it } from 'vitest';

import {
  assembleImageCharacters,
  compileWardrobeForFrame,
  stripLeakedAppearance,
} from './assemblePrompt';
import type { CharacterWardrobe } from '@/state/outfitState';
import type { CharTagEntry } from '@/state/charTags';
import type { ImageInsertion } from './protocol';
import { defaultWorldAnchor } from '@/state/worldAnchor';

function entry(name: string, fields: Partial<CharTagEntry['fields']> = {}): CharTagEntry {
  return {
    name,
    fields: {
      sex: '1girl',
      hair: 'long black hair, straight hair, hair down, blunt bangs',
      eyes: 'brown eyes, tareme',
      skin: 'fair skin',
      body: 'petite, medium breasts',
      extra: 'silver hairpin, mole under eye',
      outfit: '',
      fandom: '',
      ...fields,
    },
    raw: '',
  } as CharTagEntry;
}

function wardrobe(name: string, slots: Partial<Record<keyof CharacterWardrobe, { tag: string; status: 'on' | 'half' | 'off'; halfTag?: string }>>): CharacterWardrobe {
  return { name, ...slots } as CharacterWardrobe;
}

describe('compileWardrobeForFrame', () => {
  it('外装穿着时隐藏内衣（扣好的衬衫下面不该冒出 bra）', () => {
    const compiled = compileWardrobeForFrame(
      wardrobe('温岚', {
        top: { tag: 'white cotton shirt, long sleeves', status: 'on' },
        innerTop: { tag: 'pink cotton bra', status: 'on' },
      }),
    );
    expect(compiled.positive).toContain('white cotton shirt, long sleeves');
    expect(compiled.positive).not.toContain('pink cotton bra');
    expect(compiled.negatives).toEqual([]);
  });

  it('外装半脱时释放内衣并带上半脱形态', () => {
    const compiled = compileWardrobeForFrame(
      wardrobe('温岚', {
        top: { tag: 'white cotton shirt, long sleeves', status: 'half', halfTag: 'open front' },
        innerTop: { tag: 'pink cotton bra', status: 'on' },
      }),
    );
    expect(compiled.positive).toEqual(
      expect.arrayContaining(['white cotton shirt, long sleeves', 'open front', 'pink cotton bra']),
    );
  });

  it('外装与内衣都脱掉时露胸，并把品类压进负面（不写 no bra）', () => {
    const compiled = compileWardrobeForFrame(
      wardrobe('温岚', {
        top: { tag: 'white cotton shirt, long sleeves', status: 'off' },
        innerTop: { tag: 'pink cotton bra', status: 'off' },
      }),
    );
    expect(compiled.positive).toEqual(expect.arrayContaining(['bare breasts', 'nipples']));
    expect(compiled.negatives).toEqual(expect.arrayContaining(['shirt', 'blouse', 'bra', 'underwear']));
    expect(compiled.positive.join(', ')).not.toContain('no bra');
  });

  it('下装与内裤都脱掉时加 bottomless 并压裙裤词；半身构图不输出下身词', () => {
    // 内裤未建档＝正文没交代，不能替模型断言 bottomless；只有明确 off 才算。
    const full = compileWardrobeForFrame(
      wardrobe('温岚', {
        top: { tag: 'white shirt', status: 'on' },
        bottom: { tag: 'blue jeans', status: 'off' },
        innerBottom: { tag: 'white panties', status: 'off' },
      }),
    );
    expect(full.positive).toContain('bottomless');
    expect(full.negatives).toEqual(expect.arrayContaining(['skirt', 'pants', 'shorts']));

    const upper = compileWardrobeForFrame(
      wardrobe('温岚', {
        top: { tag: 'white shirt', status: 'on' },
        bottom: { tag: 'blue jeans', status: 'off' },
        innerBottom: { tag: 'white panties', status: 'off' },
      }),
      undefined,
      true,
    );
    expect(upper.positive).not.toContain('bottomless');
    expect(upper.negatives).not.toContain('skirt');
  });

  it('连身长袍没有下装记录时，下装状态跟着上装走', () => {
    const compiled = compileWardrobeForFrame(
      wardrobe('顾子衿', {
        top: { tag: 'plain white silk taoist robe, cross-collar, ankle-length', status: 'off' },
      }),
    );
    expect(compiled.positive).not.toContain('plain white silk taoist robe, cross-collar, ankle-length');
    expect(compiled.negatives).toEqual(expect.arrayContaining(['robe', 'hanfu']));
  });

  it('wearState 当帧覆盖槽位状态，但装备描述沿用账本', () => {
    const compiled = compileWardrobeForFrame(
      wardrobe('温岚', {
        top: { tag: 'white cotton shirt, long sleeves', status: 'on' },
        innerTop: { tag: 'pink cotton bra', status: 'on' },
      }),
      { top: { status: 'half', halfTag: 'shirt lifted above chest' } },
    );
    expect(compiled.positive).toContain('white cotton shirt, long sleeves');
    expect(compiled.positive).toContain('shirt lifted above chest');
    expect(compiled.positive).toContain('pink cotton bra');
  });
});

describe('stripLeakedAppearance', () => {
  it('剥掉导演偷塞的人数、发色瞳色与体型词，保留动作与标记', () => {
    const kept = stripLeakedAppearance(
      ['1girl', 'blue eyes', 'blonde hair', 'large breasts', 'blush', 'looking at viewer', 'source#holding her wrist'],
      true,
    );
    expect(kept).toEqual(['blush', 'looking at viewer', 'source#holding her wrist']);
  });

  it('不剥服装词（服装由装备表决定，导演这一格写的 outfit 也要保留）', () => {
    const kept = stripLeakedAppearance(['white shirt', 'open front', 'blush'], true);
    expect(kept).toEqual(['white shirt', 'open front', 'blush']);
  });

  it('接触短语（hand in hair）不会被当成发色词剥掉', () => {
    const kept = stripLeakedAppearance(['hand in hair', 'holding her hair', 'blush'], true);
    expect(kept).toEqual(['hand in hair', 'holding her hair', 'blush']);
  });
});

describe('assembleImageCharacters', () => {
  const world = defaultWorldAnchor();

  function image(overrides: Partial<ImageInsertion> = {}): ImageInsertion {
    return {
      position: 'P4',
      sourceLine: 3,
      tag: '1girl, 1boy, bedroom, pov, from above, cowboy shot, dim lighting',
      nl: '',
      negative: '',
      size: 'portrait',
      characters: [
        {
          name: '温岚',
          tag: '1girl, blonde hair, blue eyes, large breasts, white dress, blush, source#lifting her robe',
          nl: 'She leans back.',
        },
        {
          name: '李斌',
          tag: '1boy, faceless male, hand on her waist, target#lifting her robe',
          nl: 'He pulls her close.',
        },
      ],
      ...overrides,
    } as ImageInsertion;
  }

  it('中景过滤平底鞋时保留 flat chest；全身景别只投影当前动作需要的微小特征', () => {
    const profile = entry('甲', { body: 'tall female, flat chest, toned', extra: 'earrings, mole on neck', eyes: 'blue eyes, sanpaku' });
    const beat = image({ tag: '1girl, medium shot', characters: [{ name: '甲', tag: 'holding sunglasses', nl: '' }] });
    const state = new Map([['甲', wardrobe('甲', { shoes: { tag: 'black ballet flats', status: 'on' } })]]);
    const assemble = () => assembleImageCharacters(beat, [profile], state).characters[0].tag;
    expect(assemble()).toContain('flat chest');
    expect(assemble()).not.toContain('ballet flats');
    expect(assemble()).toContain('sanpaku');
    beat.tag = '1girl, full shot';
    expect(assemble()).toContain('flat chest');
    expect(assemble()).toContain('holding sunglasses');
    expect(assemble()).toContain('black ballet flats');
    expect(assemble()).not.toMatch(/sanpaku|mole on neck/);
    beat.nl = 'She points to the mole on her neck.';
    beat.characters[0].tag = 'pointing, mole on neck';
    expect(assemble()).toContain('mole on neck');
  });

  it('双手抓踝的整体姿态修正景别，普通沙发对话和刻意的局部特写保留原构图', () => {
    const beat = image({ tag: '1girl, from side, medium shot, sofa', characters: [{ name: '甲', tag: 'grabbing own ankles, m legs', nl: '' }] });
    const full = assembleImageCharacters(beat, []).tag;
    expect(full).toBe('1girl, three-quarter view, full body, sofa');
    expect(assembleImageCharacters({ ...beat, extent: 'detail', tag: '1girl, close-up, foot focus' }, []).tag).toContain('close-up');
    beat.characters[0].tag = 'sitting';
    expect(assembleImageCharacters(beat, []).tag).toBe(beat.tag);
    expect(assembleImageCharacters({ ...beat, extent: 'whole' }, []).tag).toContain('full body');
  });

  it('正常穿风衣可见高领，内衣入账不上镜；敞开外套或脱掉毛衣时按层展开', () => {
    const beat = image({ tag: '1girl, full body', characters: [{ name: '甲', tag: 'burgundy embroidered bra, holding spare bra', nl: '' }] });
    const outfit = wardrobe('甲', { outer: { tag: 'beige trench coat', status: 'on' }, top: { tag: 'black turtleneck', status: 'on' },
      innerTop: { tag: 'red bra', status: 'on' } });
    const assemble = () => assembleImageCharacters(beat, [], new Map([['甲', outfit]])).characters[0].tag;
    expect(assemble()).toMatch(/closed coat.*black turtleneck visible at collar/);
    expect(assemble()).not.toMatch(/red bra|burgundy embroidered bra/);
    expect(assemble()).toContain('holding spare bra');
    outfit.outer!.status = 'half_top';
    expect(assemble()).toContain('black turtleneck');
    expect(assemble()).not.toMatch(/closed coat|red bra/);
    outfit.top!.status = 'off';
    expect(assemble()).toContain('red bra');
  });

  it('短发高马尾不会被自身或同框角色的自动负面压掉；闭眼只覆盖本帧的睁眼表情', () => {
    const person = entry('许婷', { hair: 'black hair, short hair, high ponytail', eyes: 'emerald eyes, narrowed eyes' });
    const other = entry('乙', { hair: 'ponytail, curly hair' });
    const frame = image({ tag: '2girls, full body', characters: [
      { name: '许婷', tag: 'closed eyes, one slipper off, barefoot', nl: '', uc: 'camera' },
      { name: '乙', tag: 'smile', nl: '' },
    ] });
    const first = assembleImageCharacters(frame, [person, other]).characters[0];
    expect(first.uc?.split(', ')).not.toContain('ponytail');
    expect(first.uc?.split(', ')).toEqual(expect.arrayContaining(['camera', 'very long hair', 'curly hair']));
    expect(first.tag.split(', ')).toEqual(expect.arrayContaining(['high ponytail', 'closed eyes', 'emerald eyes', 'one bare foot']));
    expect(first.tag).not.toMatch(/narrowed eyes|barefoot/);
    frame.characters[0].tag = 'smile, barefoot';
    expect(assembleImageCharacters(frame, [person, other]).characters[0].tag).toMatch(/narrowed eyes.*barefoot/);
  });

  it('固定外貌在前、装备居中、导演动作在后；导演偷塞的身份词被剥掉', () => {
    const wardrobes = new Map<string, CharacterWardrobe>([
      ['温岚', wardrobe('温岚', { top: { tag: 'white cotton blouse, long sleeves', status: 'on' } })],
    ]);
    const result = assembleImageCharacters(image(), [entry('温岚'), entry('李斌', { sex: '1boy' })], wardrobes, world);
    const woman = result.characters[0];
    const tags = woman.tag.split(', ');
    expect(tags.slice(0, 4)).toEqual(['girl', 'long black hair', 'straight hair', 'hair down']);
    expect(woman.tag).toContain('white cotton blouse, long sleeves');
    expect(woman.tag).toContain('blush');
    expect(woman.tag).toContain('source#lifting her robe');
    expect(woman.tag).not.toContain('blonde hair');
    expect(woman.tag).not.toContain('large breasts');
    expect(woman.tag).not.toContain('1girl');
  });

  it('男角色只留导演给的动作，不接外貌与装备', () => {
    const wardrobes = new Map<string, CharacterWardrobe>([
      ['温岚', wardrobe('温岚', { top: { tag: 'white cotton blouse', status: 'on' } })],
    ]);
    const result = assembleImageCharacters(image(), [entry('温岚'), entry('李斌', { sex: '1boy' })], wardrobes, world);
    const man = result.characters[1];
    expect(man.tag).toBe('1boy, faceless male, hand on her waist, target#lifting her robe');
    expect(man.tag).not.toContain('blouse');
  });

  it('内衣脱掉时 uc 里出现 bra/underwear 负面', () => {
    const wardrobes = new Map<string, CharacterWardrobe>([
      [
        '温岚',
        wardrobe('温岚', {
          top: { tag: 'white cotton blouse, long sleeves', status: 'off' },
          innerTop: { tag: 'pink cotton bra', status: 'off' },
        }),
      ],
    ]);
    const result = assembleImageCharacters(image(), [entry('温岚'), entry('李斌', { sex: '1boy' })], wardrobes, world);
    const woman = result.characters[0];
    expect(woman.tag).toContain('bare breasts');
    expect(woman.uc ?? '').toContain('bra, underwear, bikini top');
  });

  it('两个女角同框时，把对方的标志性特征压进自己的 uc（防串色）', () => {
    const withTwo = image({
      tag: '2girls, bedroom, cowboy shot',
      characters: [
        { name: '温岚', tag: 'blush', nl: '' },
        { name: '苏小雨', tag: 'smile', nl: '' },
      ],
    });
    const result = assembleImageCharacters(
      withTwo,
      [entry('温岚'), entry('苏小雨', { hair: 'silver twin braids, straight hair, blunt bangs' })],
      new Map(),
      world,
    );
    expect(result.characters[0].uc ?? '').toContain('silver twin braids');
  });

  it('脱掉上衣但还穿着裙子时，负面里绝不含 clothes 这类核弹词', () => {
    const out = compileWardrobeForFrame(
      {
        name: '温岚',
        top: { tag: 'white shirt', status: 'off' },
        bottom: { tag: 'pleated skirt, knee-length', status: 'on' },
      },
      undefined,
      false,
    );
    expect(out.negatives).not.toContain('clothes');
    // 裙子仍在正面：上衣的 off 不该把下装一起屏蔽掉。
    expect(out.positive).toContain('pleated skirt, knee-length');
    expect(out.negatives).toContain('shirt');
  });

  it('只穿内衣出场（top 为空、innerTop 有记录）时正常输出内衣', () => {
    const out = compileWardrobeForFrame(
      { name: '温岚', innerTop: { tag: 'red halterneck camisole, backless', status: 'on' } },
      undefined,
      false,
    );
    expect(out.positive).toContain('red halterneck camisole, backless');
    expect(out.positive).not.toContain('bare breasts');
  });
});