import { describe, expect, it } from 'vitest';

import { assembleImageCharacters, isHalfStatus, stripLeakedAppearance } from '@/autoTag/assemblePrompt';
import {
  applyDueWardrobes,
  applyFrameWearState,
  narrativeOrder,
  synthesiseTailUpdates,
  wardrobesAfterFloor,
} from '@/autoTag/wardrobeSequence';
import type { ImageInsertion } from '@/autoTag/protocol';
import { unifiedSystemPrompt } from '@/autoTag/prompt';
import { defaultWorldAnchor } from '@/state/worldAnchor';
import {
  applyWardrobeUpdate,
  normaliseWardrobeUpdate,
  type CharacterWardrobe,
  type WardrobeUpdate,
} from '@/state/outfitState';
import type { CharTagEntry } from '@/state/charTags';
import { emptyCharFields } from '@/state/charTags';

function entry(name: string): CharTagEntry {
  const fields = emptyCharFields();
  fields.sex = '1girl';
  fields.hair = 'long black hair, straight hair, hair down, parted bangs';
  fields.eyes = 'brown eyes, tareme';
  fields.skin = 'fair skin';
  fields.body = 'slender, medium breasts';
  return { name, fields, raw: '', nl: '', source: 'ai', desc: '', history: [] };
}

function shot(
  position: string,
  sourceLine: number,
  wearState?: ImageInsertion['characters'][number]['wearState'],
): ImageInsertion {
  return {
    position,
    sourceLine,
    tag: '1girl, bedroom, cowboy shot, from side',
    nl: '',
    negative: '',
    characters: [{ name: '温岚', tag: 'blush, looking away', nl: '', ...(wearState ? { wearState } : {}) }],
    size: 'portrait',
  };
}

const BASE: CharacterWardrobe = {
  name: '温岚',
  top: { tag: 'white shirt, long sleeves', status: 'on' },
  bottom: { tag: 'pleated skirt, knee-length', status: 'on' },
};

const ONE_PIECE: CharacterWardrobe = {
  name: '温岚',
  top: { tag: 'white silk taoist robe, ankle-length', status: 'on' },
};

describe('穿回原件与指纹清洁', () => {
  it('patch 允许只给 status，穿回时保留原指纹', () => {
    const update = normaliseWardrobeUpdate({
      name: '温岚',
      mode: 'patch',
      slots: { top: { status: 'on' } },
    });
    expect(update).not.toBeNull();
    expect(update?.slots.top?.tag).toBe('');

    const wardrobes = new Map<string, CharacterWardrobe>([
      [
        '温岚',
        {
          name: '温岚',
          top: { tag: 'white shirt, long sleeves', status: 'off' },
        },
      ],
    ]);
    applyWardrobeUpdate(wardrobes, update!);
    expect(wardrobes.get('温岚')?.top).toEqual({ tag: 'white shirt, long sleeves', status: 'on' });
  });

  it('replace 仍然要求指纹，缺 tag 视为无效', () => {
    expect(
      normaliseWardrobeUpdate({ name: '温岚', mode: 'replace', slots: { top: { status: 'on' } } }),
    ).toBeNull();
  });

  it('指纹里的临时穿法词被剥掉，款式复合词保留', () => {
    const update = normaliseWardrobeUpdate({
      name: '温岚',
      mode: 'replace',
      slots: {
        top: { tag: 'button-down shirt, unbuttoned, white, long sleeves', status: 'on' },
        bottom: { tag: 'zip-up skirt, zipped', status: 'on' },
      },
    });
    expect(update?.slots.top?.tag).toBe('button-down shirt, white, long sleeves');
    expect(update?.slots.bottom?.tag).toBe('zip-up skirt');
  });
});

describe('正文顺序与楼尾状态', () => {
  it('乱序图片 [P12, P2] 里 P2 仍穿旧衣、P12 穿新衣', () => {
    const before = new Map<string, CharacterWardrobe>([['温岚', BASE]]);
    const updates: WardrobeUpdate[] = [
      {
        name: '温岚',
        mode: 'replace',
        position: 'P10',
        sourceLine: 10,
        slots: { top: { tag: 'black maid dress, apron', status: 'on' } },
      },
    ];
    const images = [shot('P12', 12), shot('P2', 2)];
    const order = narrativeOrder(images);
    // 编译顺序按正文（P2 先、P12 后），返回顺序仍是模型给的原样。
    expect(order).toEqual([1, 0]);

    const wardrobes = new Map(before);
    const compiled: string[] = new Array(images.length);
    let cursor = 0;
    for (const index of order) {
      const image = images[index];
      cursor = applyDueWardrobes(wardrobes, updates, cursor, image.sourceLine);
      compiled[index] = assembleImageCharacters(image, [entry('温岚')], wardrobes).characters[0].tag;
      for (const character of image.characters) applyFrameWearState(wardrobes, character);
    }
    // 下标 1 = P2：旧衣服；下标 0 = P12：新衣服。
    expect(compiled[1]).toContain('white shirt');
    expect(compiled[1]).not.toContain('maid');
    expect(compiled[0]).toContain('maid');
  });

  it('楼尾落盘保留逐帧 wearState 的脱衣，最后一张图之后的穿回也生效', () => {
    const before = new Map<string, CharacterWardrobe>([['温岚', BASE]]);
    // 本楼没有任何 wardrobeUpdates，只有逐帧 wearState 把外套脱了。
    const frames = [shot('P2', 2, { top: { status: 'off' } })];
    const wardrobes = new Map(before);
    let cursor = 0;
    for (const image of frames) {
      cursor = applyDueWardrobes(wardrobes, [], cursor, image.sourceLine);
      for (const character of image.characters) applyFrameWearState(wardrobes, character);
    }
    const tail = synthesiseTailUpdates(before, [], wardrobes);
    expect(tail).toHaveLength(1);
    expect(tail[0].slots.top?.status).toBe('off');
    // 只重放 update 会退回穿着——所以必须靠这条补丁把 off 带下楼。
    expect(wardrobesAfterFloor(before, []).get('温岚')?.top?.status).toBe('on');
    expect(wardrobesAfterFloor(before, tail).get('温岚')?.top?.status).toBe('off');

    // 最后一张图之后正文又写把外套穿回：P20 的 update 必须落在楼尾。
    const late: WardrobeUpdate[] = [
      { name: '温岚', mode: 'patch', position: 'P20', sourceLine: 20, slots: { top: { status: 'on' } } },
    ];
    cursor = applyDueWardrobes(wardrobes, late, cursor, Number.POSITIVE_INFINITY);
    const afterTail = synthesiseTailUpdates(before, late, wardrobes);
    expect(wardrobesAfterFloor(before, [...late, ...afterTail]).get('温岚')?.top?.status).toBe('on');
    expect(wardrobes.get('温岚')?.top?.tag).toBe('white shirt, long sleeves');
  });
});

describe('连身衣上下半脱与未知内搭', () => {
  it('连身衣 half_top 只露内衣上装，不露下装', () => {
    const wardrobe: CharacterWardrobe = {
      ...ONE_PIECE,
      innerTop: { tag: 'white halterneck camisole', status: 'on' },
      innerBottom: { tag: 'white silk shorts', status: 'on' },
    };
    const out = compile(wardrobe, { top: { status: 'half_top', halfTag: 'collar unbuttoned' } });
    expect(out.positive).toContain('white halterneck camisole');
    expect(out.positive).not.toContain('white silk shorts');
  });

  it('连身衣 half_bottom 只露下装，不露上装', () => {
    const wardrobe: CharacterWardrobe = {
      ...ONE_PIECE,
      innerTop: { tag: 'white halterneck camisole', status: 'on' },
      innerBottom: { tag: 'white silk shorts', status: 'on' },
    };
    const out = compile(wardrobe, { top: { status: 'half_bottom', halfTag: 'skirt lift' } });
    expect(out.positive).toContain('white silk shorts');
    expect(out.positive).not.toContain('white halterneck camisole');
  });

  it('外衣脱掉但内搭未建档时不自动脑补裸露词', () => {
    const out = compile({ name: '温岚', top: { tag: 'white shirt', status: 'on' } }, {
      top: { status: 'off' },
    });
    expect(out.positive).not.toContain('bare breasts');
    expect(out.positive).not.toContain('nipples');
    expect(out.negatives).not.toContain('bra');
  });

  it('内搭明确 off 时才输出裸露词并压内衣品类', () => {
    const wardrobe: CharacterWardrobe = {
      name: '温岚',
      top: { tag: 'white shirt', status: 'on' },
      innerTop: { tag: 'pink bra', status: 'on' },
    };
    const out = compile(wardrobe, { top: { status: 'off' }, innerTop: { status: 'off' } });
    expect(out.positive).toContain('bare breasts');
    expect(out.negatives).toContain('bra');
  });
});

describe('眼部表情词与提示词示例', () => {
  it('closed eyes / half-closed eyes 不被当瞳色剥掉', () => {
    const kept = stripLeakedAppearance(
      ['closed eyes', 'half-closed eyes', 'blue eyes', 'long black hair', '1girl'],
      true,
    );
    expect(kept).toContain('closed eyes');
    expect(kept).toContain('half-closed eyes');
    expect(kept).not.toContain('blue eyes');
    expect(kept).not.toContain('long black hair');
    expect(kept).not.toContain('1girl');
  });

  it('半脱判据覆盖新状态码', () => {
    expect(isHalfStatus('half')).toBe(true);
    expect(isHalfStatus('half_top')).toBe(true);
    expect(isHalfStatus('half_bottom')).toBe(true);
    expect(isHalfStatus('on')).toBe(false);
  });

  it('系统提示词示例里施动方 source、承受方 target，且指纹不带临时穿法词', () => {
    const prompt = unifiedSystemPrompt(defaultWorldAnchor(), true, 0, 2);
    const start = prompt.indexOf('"images":[');
    const example = prompt.slice(start, start + 900);
    expect(example).toContain('target#pinning her wrists');
    expect(example).toContain('source#pinning her wrists');
    expect(example).not.toContain('buttoned, hip-length');
    expect(prompt).toContain('half_top');
    expect(prompt).toContain('half_bottom');
    expect(prompt).toContain('正文没交代内搭');
  });
});

function compile(
  wardrobe: CharacterWardrobe,
  wearState: ImageInsertion['characters'][number]['wearState'],
) {
  const image = shot('P1', 1, wearState);
  const wards = new Map<string, CharacterWardrobe>([[wardrobe.name, wardrobe]]);
  const character = assembleImageCharacters(image, [entry(wardrobe.name)], wards).characters[0];
  return {
    positive: character.tag.split(',').map(part => part.trim()).filter(Boolean),
    negatives: (character.uc ?? '').split(',').map(part => part.trim()).filter(Boolean),
  };
}