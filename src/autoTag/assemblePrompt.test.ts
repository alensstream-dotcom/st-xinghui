import { describe, expect, it } from 'vitest';

import {
  assembleImageCharacters,
  buildRemovedNegatives,
  proportionGuardrailsFor,
  stripLeakedAppearance,
} from '@/autoTag/assemblePrompt';
import type { CharTagEntry } from '@/state/charTags';
import type { ImageInsertion } from '@/autoTag/protocol';
import { defaultWorldAnchor, WORLD_PRESETS, type WorldAnchorConfig } from '@/state/worldAnchor';

function entry(name: string, fields: Partial<CharTagEntry['fields']> = {}): CharTagEntry {
  return {
    name,
    fields: {
      fandom: '',
      sex: '1girl',
      hair: 'long black hair, straight hair',
      eyes: 'brown eyes, tsurime',
      skin: 'pale skin',
      body: 'slender',
      extra: '',
      outfit: '',
      ...fields,
    },
    raw: '',
    nl: '',
    source: 'manual',
    desc: '',
    history: [],
  };
}

function image(tag: string, characters: ImageInsertion['characters']): ImageInsertion {
  return { position: 'P1', sourceLine: 0, tag, nl: '', negative: '', characters, size: 'portrait' };
}

const ancient: WorldAnchorConfig = {
  ...defaultWorldAnchor(),
  ...WORLD_PRESETS.chinese_ancient,
  presetId: 'chinese_ancient',
  lockedByUser: true,
};

describe('stripLeakedAppearance:只剥身份词,不碰服装', () => {
  it('已建档女角:人数/发色/发型/瞳色/体型全剥,动作与标记留下', () => {
    const tags = ['1girl', 'blue eyes', 'large breasts', 'white dress', 'source#licking', 'blush', 'kneeling'];
    expect(stripLeakedAppearance(tags, true)).toEqual(['white dress', 'source#licking', 'blush', 'kneeling']);
  });

  it('未建档时身份词原样保留(这一格全靠导演写),标记与接触动作永不误伤', () => {
    const tags = ['1girl', 'hand in hair', 'holding her hair', 'mutual#kissing'];
    expect(stripLeakedAppearance(tags, false)).toEqual(['1girl', 'hand in hair', 'holding her hair', 'mutual#kissing']);
  });
});

describe('buildRemovedNegatives:谁真的脱了,就把品类压进这个角色的负面', () => {
  it('胸罩脱掉压 bra/underwear,下装脱掉压裙裤(仅限非上半身特写)', () => {
    expect(buildRemovedNegatives(['bra'], false)).toEqual(['bra', 'underwear', 'bikini top']);
    expect(buildRemovedNegatives(['bottom'], false)).toEqual(['skirt', 'pants', 'shorts']);
    expect(buildRemovedNegatives(['bottom'], true)).toEqual([]);
  });

  it('外衣脱掉按外衣类压,不会顺手把内裤也压掉', () => {
    expect(buildRemovedNegatives(['outer'], false)).toEqual(['shirt', 'blouse', 'dress', 'coat', 'robe', 'hanfu']);
    expect(buildRemovedNegatives(['hosiery'], false)).toEqual(['pantyhose', 'stockings', 'thighhighs', 'socks']);
  });
});

describe('导演当帧穿脱编译', () => {
  it('顺序是固定外貌 → 导演 outfit → 导演动作词,标记词必须留下', () => {
    const out = assembleImageCharacters(
      image('1girl, cowboy shot, bedroom, from front', [
        { name: '温岚', tag: 'blush, source#licking nipple, kneeling', nl: 'She kneels and looks up.', outfit: 'white shirt, jeans', uc: '' },
      ]),
      [entry('温岚')],
    );
    const got = out.characters[0].tag.split(', ');
    expect(got.slice(0, 7)).toEqual(['girl', 'long black hair', 'straight hair', 'brown eyes', 'tsurime', 'pale skin', 'slender']);
    expect(out.characters[0].tag).toContain('white shirt, jeans');
    expect(out.characters[0].tag).toContain('source#licking nipple');
    expect(out.characters[0].tag).toContain('blush');
  });

  it('导演偷塞的发色/人数/体型被剥掉,但服装照他的 outfit 走', () => {
    const out = assembleImageCharacters(
      image('cowboy shot, bedroom', [
        { name: '温岚', tag: '1girl, blue eyes, large breasts, white dress, blush', nl: '', outfit: 'red hanfu, long sleeves', uc: '' },
      ]),
      [entry('温岚')],
    );
    const tag = out.characters[0].tag;
    expect(tag).not.toContain('1girl');
    expect(tag).not.toContain('blue eyes');
    expect(tag).not.toContain('large breasts');
    expect(tag).toContain('red hanfu, long sleeves');
    expect(tag).toContain('blush');
  });

  it('违规当帧由导演给的 removed 决定:胸罩脱了就压 bra,下装还在就不压裙子', () => {
    const out = assembleImageCharacters(
      image('full body, bedroom', [
        { name: '温岚', tag: 'blush', nl: '', outfit: 'white shirt, jeans', removed: ['bra'], uc: '' },
      ]),
      [entry('温岚')],
    );
    expect(out.characters[0].uc).toContain('bra, underwear, bikini top');
    expect(out.characters[0].uc).not.toContain('skirt');
  });

  it('上半身特写里下装词先被剔掉,腿与鞋也不再冒出来', () => {
    const out = assembleImageCharacters(
      image('upper body, close-up, bedroom', [
        { name: '温岚', tag: 'blush', nl: '', outfit: 'white shirt, pleated skirt, sheer black pantyhose, leather loafers', uc: '' },
      ]),
      [entry('温岚')],
    );
    const tag = out.characters[0].tag;
    expect(tag).toContain('white shirt');
    expect(tag).not.toContain('skirt');
    expect(tag).not.toContain('pantyhose');
    expect(tag).not.toContain('loafers');
  });

  it('cowboy shot 只压鞋,丝袜本身保留', () => {
    const out = assembleImageCharacters(
      image('cowboy shot, bedroom', [
        { name: '温岚', tag: 'blush', nl: '', outfit: 'white shirt, jeans, sheer black pantyhose, black loafers', uc: '' },
      ]),
      [entry('温岚')],
    );
    expect(out.characters[0].tag).toContain('sheer black pantyhose');
    expect(out.characters[0].tag).not.toContain('loafers');
  });

  it('男角色跳过外貌与服装,只留导演给的 boy 与局部动作', () => {
    const out = assembleImageCharacters(
      image('1girl, 1boy, bedroom', [
        { name: '温岚', tag: 'blush', nl: '', outfit: 'white shirt', uc: '' },
        { name: '李斌', tag: '1boy, faceless male, hand on her waist', nl: '', outfit: 'black shirt', uc: '' },
      ]),
      [entry('温岚'), entry('李斌', { sex: '1boy', hair: 'short black hair' })],
    );
    expect(out.characters[1].tag).toBe('1boy, faceless male, hand on her waist');
    expect(out.characters[1].tag).not.toContain('black shirt');
    expect(out.characters[1].tag).not.toContain('short black hair');
  });

  it('omitFeatures 只摘配饰,摘不到发型瞳色;结果里不留临时字段', () => {
    const out = assembleImageCharacters(
      image('cowboy shot', [
        { name: '温岚', tag: 'blush', nl: '', outfit: 'white shirt', omitFeatures: ['glasses', 'hair'], uc: '' },
      ]),
      [entry('温岚', { extra: 'glasses, hairpin' })],
    );
    const tag = out.characters[0].tag;
    expect(tag).not.toContain('glasses');
    expect(tag).toContain('hairpin');
    expect(tag).toContain('long black hair');
    expect('omitFeatures' in out.characters[0]).toBe(false);
  });

  it('多人同框防串色:各自 uc 含对方标志特征,不含自己的', () => {
    const out = assembleImageCharacters(
      image('2girls, bedroom', [
        { name: '温岚', tag: 'blush', nl: '', outfit: 'white shirt', uc: '' },
        { name: '顾子衿', tag: 'blush', nl: '', outfit: 'hanfu', uc: '' },
      ]),
      [
        entry('温岚', { hair: 'long black hair, high ponytail', extra: 'hairpin' }),
        entry('顾子衿', { hair: 'silver hair, low bun', extra: 'glasses' }),
      ],
    );
    expect(out.characters[0].uc).toContain('glasses');
    expect(out.characters[1].uc).toContain('high ponytail');
    expect(out.characters[1].uc).not.toContain('low bun');
  });
});

describe('比例防畸变与世界观防穿帮', () => {
  it('站着 + 跪着的高低差画面给角色负面补比例词,没有高低差不乱加', () => {
    expect(proportionGuardrailsFor('standing girl, kneeling man, bedroom')).toEqual([
      'giantess',
      'size difference',
      'miniature',
    ]);
    expect(proportionGuardrailsFor('two girls sitting on a couch')).toEqual([]);
  });

  it('高低差命中时,uc 里真的带上比例词', () => {
    const out = assembleImageCharacters(
      image('full body, standing, bedroom', [
        { name: '温岚', tag: 'standing, blush', nl: '', outfit: 'white shirt', uc: '' },
        { name: '李斌', tag: 'kneeling, hand on her waist', nl: '', outfit: '', uc: '' },
      ]),
      [entry('温岚'), entry('李斌', { sex: '1boy' })],
    );
    expect(out.characters[0].uc).toContain('size difference');
  });

  it('古风世界观把现代单品压进负面,但正文已经写上的汉服不压', () => {
    const out = assembleImageCharacters(
      image('full body, ancient room', [
        { name: '顾子衿', tag: 'blush', nl: '', outfit: 'white traditional hanfu, wide long sleeves', uc: '' },
      ]),
      [entry('顾子衿')],
      ancient,
    );
    // 正文没写的现代单品全压进负面（汉服已经在正向里，所以不会被压）
    expect(out.characters[0].uc).toContain('jeans');
    expect(out.characters[0].uc).toContain('modern building');
    expect(out.characters[0].uc).not.toContain('hanfu');
    expect(out.characters[0].tag).toContain('white traditional hanfu');
  });

  it('正文明确写了的牛仔裤不再被古风负面屏蔽', () => {
    const out = assembleImageCharacters(
      image('full body, alley', [
        { name: '温岚', tag: 'blush', nl: '', outfit: 'white t-shirt, jeans', uc: '' },
      ]),
      [entry('温岚')],
      ancient,
    );
    expect(out.characters[0].uc).not.toContain('jeans');
    expect(out.characters[0].uc).not.toContain('t-shirt');
  });
});

describe('带中文的标记词被清掉', () => {
  it('中文人名写进 source# 就丢,英文原样保留', () => {
    const out = assembleImageCharacters(
      image('cowboy shot', [
        { name: '温岚', tag: 'source#李斌抚摸 target#licking nipple, mutual#kissing', nl: '', outfit: 'white shirt', uc: '' },
      ]),
      [entry('温岚')],
    );
    expect(out.characters[0].tag).toContain('target#licking nipple');
    expect(out.characters[0].tag).toContain('mutual#kissing');
    expect(out.characters[0].tag).not.toContain('李斌');
  });
});
