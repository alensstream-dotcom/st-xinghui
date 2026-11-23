import { describe, expect, it } from 'vitest';
import { assembleImageCharacters } from '@/autoTag/assemblePrompt';
import { applyFrameWearState, guardSameDayReplace, seedWardrobes } from '@/autoTag/wardrobeSequence';
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
    const seeded = seedWardrobes(before, updates);
    expect(seeded.get('温岚')?.top?.status).toBe('on');

    const entries = [entry('温岚')];
    const compiled: string[] = [];
    const shots = [
      shot('P2', { top: { status: 'on' } }),
      shot('P6', { top: { status: 'off' } }),
      shot('P9', { top: { status: 'on' } }),
    ];
    for (const image of shots) {
      const out = assembleImageCharacters(image, entries, seeded);
      compiled.push(out.characters[0].tag);
      for (const character of image.characters) applyFrameWearState(seeded, character);
    }

    // 第 1 张：上衣在，正面写 shirt，负面不许出现上衣品类。
    expect(compiled[0]).toContain('white shirt');
    expect(compiled[0]).not.toContain('bare breasts');
    // 第 2 张：上衣压掉并判露出；裙子仍在（off 只屏蔽上衣品类）。
    expect(compiled[1]).not.toContain('white shirt');
    expect(compiled[1]).toContain('bare breasts');
    expect(compiled[1]).toContain('pleated skirt');
    // 第 3 张：穿回同一件（tag 未重写）。
    expect(compiled[2]).toContain('white shirt');
  });

  it('same_day 下非显式换装的 replace 被降级为 patch，new_day 放行', () => {
    const before = new Map<string, CharacterWardrobe>([['温岚', BASE]]);
    const replace: WardrobeUpdate[] = [
      { name: '温岚', mode: 'replace', slots: { top: { tag: 'red dress', status: 'on' } } },
    ];
    const sameDay = guardSameDayReplace('same_day', replace, before);
    expect(sameDay[0].mode).toBe('patch');
    // patch 语义：未提及的槽位保留——裙子不会被这次“换装”冲掉。
    const patched = seedWardrobes(before, sameDay);
    expect(patched.get('温岚')?.bottom?.tag).toBe('pleated skirt, knee-length');

    const explicit = guardSameDayReplace(
      'same_day',
      [{ ...replace[0], explicitChange: true }],
      before,
    );
    expect(explicit[0].mode).toBe('replace');

    const newDay = guardSameDayReplace('new_day', replace, before);
    expect(newDay[0].mode).toBe('replace');
    expect(seedWardrobes(before, newDay).get('温岚')?.bottom).toBeUndefined();
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
