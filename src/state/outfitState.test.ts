import { describe, expect, it, vi } from 'vitest';

const getContextMock = vi.hoisted(() => vi.fn());

vi.mock('@/st/context', () => ({ getContext: getContextMock }));

import {
  BBI_OUTFIT_EXTRA_KEY,
  applyWardrobeUpdate,
  buildWardrobeText,
  deriveWardrobes,
  makeWardrobeFloorDelta,
  readWardrobeFloorDelta,
  wardrobesBeforeFloor,
  type WardrobeUpdate,
} from './outfitState';
import type { STMessage } from '@/st/context';

function message(extra: Record<string, unknown>, swipe = 0, swipes = 1): STMessage {
  return {
    name: 'AI',
    is_user: false,
    is_system: false,
    mes: '',
    swipes: Array.from({ length: swipes }, () => ''),
    swipe_id: swipe,
    extra,
  };
}

function withDelta(updates: WardrobeUpdate[], swipe = 0, swipes = 1): STMessage {
  const delta = makeWardrobeFloorDelta(updates, swipe);
  return message({ [BBI_OUTFIT_EXTRA_KEY]: delta }, swipe, swipes);
}

const robe: WardrobeUpdate = {
  name: '顾子衿',
  mode: 'replace',
  slots: {
    top: { tag: 'plain white silk taoist robe, ankle-length', status: 'on' },
    innerTop: { tag: 'white halterneck camisole, backless', status: 'on' },
    innerBottom: { tag: 'white silk shorts', status: 'on' },
  },
};

describe('装备表 v3 读写', () => {
  it('写入后能原样读回，脱掉的槽位也保留 tag', () => {
    const floor = withDelta([
      {
        name: '顾子衿',
        mode: 'patch',
        slots: { top: { tag: 'plain white silk taoist robe, ankle-length', status: 'off' } },
      },
    ]);
    const delta = readWardrobeFloorDelta(floor);
    expect(delta?.v).toBe(3);
    expect(delta?.updates[0]?.slots.top).toEqual({
      tag: 'plain white silk taoist robe, ankle-length',
      status: 'off',
    });
  });

  it('旧版本账本（v1/v2）安全忽略，返回 null 而不抛错', () => {
    const legacy = message({ [BBI_OUTFIT_EXTRA_KEY]: { v: 2, swipe: 0, snapshots: [] } });
    expect(readWardrobeFloorDelta(legacy)).toBeNull();
    const broken = message({ [BBI_OUTFIT_EXTRA_KEY]: { v: 3, swipe: 0, updates: 'nope' } });
    expect(readWardrobeFloorDelta(broken)).toBeNull();
  });

  it('patch 只给 status:on 且省略 tag 时，沿用旧指纹原样穿回', () => {
    const wardrobes = new Map();
    applyWardrobeUpdate(wardrobes, robe);
    applyWardrobeUpdate(wardrobes, {
      name: '顾子衿',
      mode: 'patch',
      slots: { top: { tag: 'plain white silk taoist robe, ankle-length', status: 'off' } },
    });
    applyWardrobeUpdate(wardrobes, {
      name: '顾子衿',
      mode: 'patch',
      slots: { top: { tag: 'plain white silk taoist robe, ankle-length', status: 'on' } },
    });
    expect(wardrobes.get('顾子衿')?.top).toEqual({
      tag: 'plain white silk taoist robe, ankle-length',
      status: 'on',
    });
  });

  it('replace 重置整套槽位（隔天换装）', () => {
    const wardrobes = new Map();
    applyWardrobeUpdate(wardrobes, robe);
    applyWardrobeUpdate(wardrobes, {
      name: '顾子衿',
      mode: 'replace',
      slots: { top: { tag: 'black long-sleeved dress, midi', status: 'on' } },
    });
    const current = wardrobes.get('顾子衿');
    expect(current?.top?.tag).toBe('black long-sleeved dress, midi');
    expect(current?.innerTop).toBeUndefined();
  });

  it('逐楼回放并跳过 swipe 不匹配的楼', () => {
    // 第 2 楼账本写的是 swipe 0 的脱衣记录，但当前看的是 swipe 1 → 整楼跳过。
    const stale = withDelta(
      [{ name: '顾子衿', mode: 'patch', slots: { top: { tag: 'plain white silk taoist robe, ankle-length', status: 'off' } } }],
      0,
      2,
    );
    stale.swipe_id = 1;
    getContextMock.mockReturnValue({ chat: [withDelta([robe]), stale] });
    const wardrobes = deriveWardrobes(getContextMock().chat, 2);
    expect(wardrobes.get('顾子衿')?.top?.status).toBe('on');

    const sameSwipe = withDelta(
      [{ name: '顾子衿', mode: 'patch', slots: { top: { tag: 'plain white silk taoist robe, ankle-length', status: 'off' } } }],
      1,
      2,
    );
    getContextMock.mockReturnValue({ chat: [withDelta([robe]), sameSwipe] });
    const applied = deriveWardrobes(getContextMock().chat, 2);
    expect(applied.get('顾子衿')?.top?.status).toBe('off');
  });

  it('wardrobesBeforeFloor 只回放到该楼之前', () => {
    getContextMock.mockReturnValue({
      chat: [withDelta([robe]), withDelta([{ ...robe, slots: { innerTop: { tag: 'x', status: 'off' } } }], 0, 1)],
    });
    const before = wardrobesBeforeFloor(1);
    expect(before.get('顾子衿')?.innerTop?.status).toBe('on');
    const after = wardrobesBeforeFloor(2);
    expect(after.get('顾子衿')?.innerTop?.status).toBe('off');
  });

  it('装备表文本带状态码与半脱形态，空表给提示语', () => {
    const wardrobes = new Map();
    applyWardrobeUpdate(wardrobes, robe);
    applyWardrobeUpdate(wardrobes, {
      name: '顾子衿',
      mode: 'patch',
      slots: { top: { tag: 'plain white silk taoist robe, ankle-length', status: 'half', halfTag: 'robe open front' } },
    });
    const text = buildWardrobeText(wardrobes);
    expect(text).toContain('外衣/上装[plain white silk taoist robe, ankle-length|半脱(robe open front)]');
    expect(text).toContain('上内衣[white halterneck camisole, backless|穿着]');
    expect(buildWardrobeText(new Map())).toContain('上一楼无装备记录');
  });
});