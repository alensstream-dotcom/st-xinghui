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

  it('下装脱掉时加 bottomless 并压裙裤词；半身构图不输出下身词', () => {
    const full = compileWardrobeForFrame(
      wardrobe('温岚', {
        top: { tag: 'white shirt', status: 'on' },
        bottom: { tag: 'blue jeans', status: 'off' },
      }),
    );
    expect(full.positive).toContain('bottomless');
    expect(full.negatives).toEqual(expect.arrayContaining(['skirt', 'pants', 'shorts']));

    const upper = compileWardrobeForFrame(
      wardrobe('温岚', {
        top: { tag: 'white shirt', status: 'on' },
        bottom: { tag: 'blue jeans', status: 'off' },
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
});