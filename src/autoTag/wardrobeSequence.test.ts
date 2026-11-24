import { describe, expect, it } from 'vitest';
import { assembleImageCharacters } from '@/autoTag/assemblePrompt';
import { applyDueWardrobes, applyFrameWearState, wardrobesAfterFloor } from '@/autoTag/wardrobeSequence';
import type { ImageInsertion } from '@/autoTag/protocol';
import {
  applyWardrobeUpdate,
  deriveWardrobes,
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

function shot(position: string, wearState: ImageInsertion['characters'][number]['wearState']): ImageInsertion {
  return {
    position,
    sourceLine: 1,
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

describe('楼内穿脱时序', () => {
  it('第 1 张 on、第 2 张 off、第 3 张 on 按顺序编译，楼尾 off 不污染第 1 张', () => {
    const before = new Map<string, CharacterWardrobe>([['温岚', BASE]]);
    // 模型在这一楼末尾才让她脱光，并且顺手发了个 replace（同类更新）。
    const updates: WardrobeUpdate[] = [
      { name: '温岚', mode: 'patch', slots: { top: { ...BASE.top!, status: 'off' } } },
    ];
    // 这份更新没有 position：从楼首起生效——楼尾才是脱，靠每帧 wearState 推进。
    const wardrobes = new Map(before);

    const entries = [entry('温岚')];
    const compiled: string[] = [];
    const shots = [
      shot('P2', { top: { status: 'on' } }),
      shot('P6', { top: { status: 'off' } }),
      shot('P9', { top: { status: 'on' } }),
    ];
    for (const image of shots) {
      const out = assembleImageCharacters(image, entries, wardrobes);
      compiled.push(out.characters[0].tag);
      for (const character of image.characters) applyFrameWearState(wardrobes, character);
    }

    // 第 1 张：上衣在，正面写 shirt，负面不许出现上衣品类。
    expect(compiled[0]).toContain('white shirt');
    expect(compiled[0]).not.toContain('bare breasts');
    // 第 2 张：上衣压掉；内衣未建档所以不脑补裸露词，裙子仍在。
    expect(compiled[1]).not.toContain('white shirt');
    expect(compiled[1]).not.toContain('bare breasts');
    expect(compiled[1]).toContain('pleated skirt');
    // 第 3 张：穿回同一件（tag 未重写）。
    expect(compiled[2]).toContain('white shirt');
  });

  it('same_day 下模型发 replace 直接换装生效，不被暗中降级', () => {
    const before = new Map<string, CharacterWardrobe>([['温岚', BASE]]);
    const updates: WardrobeUpdate[] = [
      { name: '温岚', mode: 'replace', slots: { top: { tag: 'red dress', status: 'on' } } },
    ];
    const after = wardrobesAfterFloor(before, updates);
    // replace 语义：没提到的槽位被重置，裙子不会跟着红裙一起留着。
    expect(after.get('温岚')?.top?.tag).toBe('red dress');
    expect(after.get('温岚')?.bottom).toBeUndefined();
  });

  it('同楼中途换装按 P 位置生效：换装前的图保持旧衣，换装后立刻穿新装', () => {
    const before = new Map<string, CharacterWardrobe>([['温岚', BASE]]);
    const updates: WardrobeUpdate[] = [
      {
        name: '温岚',
        mode: 'replace',
        sourceLine: 10,
        position: 'P10',
        slots: {
          top: { tag: 'black maid dress, apron, white frills', status: 'on' },
          legs: { tag: 'white thighhighs, leather garter straps', status: 'on' },
          innerBottom: { tag: 'black panties', status: 'on' },
        },
      },
    ];
    const wardrobes = new Map<string, CharacterWardrobe>(before);
    const entries = [entry('温岚')];
    const shoot = (line: number): string => {
      const image = { ...shot(`P${line}`, undefined), sourceLine: line };
      const cursor = applyDueWardrobes(wardrobes, updates, 0, line);
      expect(cursor).toBe(line >= 10 ? 1 : 0);
      return assembleImageCharacters(image, entries, wardrobes).characters[0].tag;
    };

    const early = shoot(2);
    expect(early).toContain('white shirt');
    expect(early).not.toContain('maid');

    const late = shoot(12);
    expect(late).toContain('maid');
    expect(late).toContain('thighhighs');
    expect(late).not.toContain('white shirt');

    // 楼尾落盘的就是女仆装（下一楼继承它）。
    const final = wardrobesAfterFloor(before, updates);
    expect(final.get('温岚')?.top?.tag).toContain('maid');
    expect(final.get('温岚')?.bottom).toBeUndefined();
  });

  it('上一楼没有装备记录时不替模型断言她裸着', () => {
    const wardrobes = new Map<string, CharacterWardrobe>();
    const out = assembleImageCharacters(shot('P1', undefined), [entry('温岚')], wardrobes);
    expect(out.characters[0].tag).not.toContain('bare breasts');
    expect(out.characters[0].uc ?? '').not.toMatch(/\bbra\b/);
  });

  it('deriveWardrobes 回放同一楼的多张更新后仍是楼尾状态', () => {
    const chat = [
      {
        name: '温岚',
        is_user: false,
        is_system: false,
        mes: '正文',
        swipe_id: 0,
        swipes: ['正文'],
        extra: {
          bbiOutfitOps: {
            v: 3,
            swipe: 0,
            updates: [
              { name: '温岚', mode: 'replace', slots: { top: { tag: 'white shirt', status: 'on' } } },
              { name: '温岚', mode: 'patch', slots: { top: { tag: 'white shirt', status: 'off' } } },
            ],
          },
        },
      },
    ];
    const derived = deriveWardrobes(chat as never, chat.length);
    expect(derived.get('温岚')?.top?.status).toBe('off');
    // tag 仍留着：穿回时不必重写。
    expect(derived.get('温岚')?.top?.tag).toBe('white shirt');
  });

  it('applyWardrobeUpdate 的 replace 会重置未提及槽位', () => {
    const wardrobes = new Map<string, CharacterWardrobe>([['温岚', BASE]]);
    applyWardrobeUpdate(wardrobes, {
      name: '温岚',
      mode: 'replace',
      slots: { top: { tag: 'black blouse', status: 'on' } },
    });
    expect(wardrobes.get('温岚')?.bottom).toBeUndefined();
  });
});
