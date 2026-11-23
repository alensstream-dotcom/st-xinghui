import { describe, expect, it, vi } from 'vitest';

const getContextMock = vi.hoisted(() => vi.fn());

vi.mock('@/st/context', () => ({ getContext: getContextMock }));

import {
  BBI_OUTFIT_EXTRA_KEY,
  buildOutfitSnapshotText,
  deriveOutfitSnapshots,
  makeOutfitFloorDelta,
  outfitStatesBeforeFloor,
  readOutfitFloorDelta,
  type CharOutfitSnapshot,
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

function withDelta(snapshots: CharOutfitSnapshot[], swipe = 0, swipes = 1): STMessage {
  const delta = makeOutfitFloorDelta(snapshots, swipe);
  return message({ [BBI_OUTFIT_EXTRA_KEY]: delta }, swipe, swipes);
}

describe('结楼穿搭指纹读写', () => {
  it('写入后能原样读回,去掉重复类目并补上缺省字段', () => {
    const floor = withDelta([
      { name: '温岚', wearing: 'white shirt, jeans', removed: ['bra', 'BRA', ' panties '] },
      { name: '苏小雨', wearing: '' },
    ] as CharOutfitSnapshot[]);
    const delta = readOutfitFloorDelta(floor);
    expect(delta?.v).toBe(2);
    expect(delta?.snapshots[0]).toEqual({
      name: '温岚',
      wearing: 'white shirt, jeans',
      removed: ['bra', 'panties'],
    });
    expect(delta?.snapshots[1]).toEqual({ name: '苏小雨', wearing: '' });
  });

  it('旧版 v1 的五层记录安全忽略,绝不崩也不会被当成全裸', () => {
    const legacy = message({ [BBI_OUTFIT_EXTRA_KEY]: { v: 1, swipe: 0, ops: [{ sourceLine: 1, op: { kind: 'update_layer' } }] } });
    expect(readOutfitFloorDelta(legacy)).toBeNull();
    expect(readOutfitFloorDelta(message({}))).toBeNull();
    expect(readOutfitFloorDelta(undefined)).toBeNull();
  });

  it('没有任何快照时写出 undefined,让落盘侧删掉旧键', () => {
    expect(makeOutfitFloorDelta([], 0)).toBeUndefined();
    expect(makeOutfitFloorDelta([{ name: '  ', wearing: 'x' }], 0)).toBeUndefined();
  });
});

describe('逐楼回放与 swipe 隔离', () => {
  it('同一角色后楼覆盖前楼,不同角色各自保留', () => {
    const chat = [
      withDelta([{ name: '温岚', wearing: 'white shirt, jeans' }]),
      withDelta([
        { name: '温岚', wearing: 'white shirt, jeans', removed: ['bra'] },
        { name: '顾子衿', wearing: 'white silk taoist robe' },
      ]),
    ];
    const state = deriveOutfitSnapshots(chat);
    expect(state.get('温岚')).toEqual({ name: '温岚', wearing: 'white shirt, jeans', removed: ['bra'] });
    expect(state.get('顾子衿')?.wearing).toBe('white silk taoist robe');
  });

  it('另一条 swipe 的记录整楼跳过,不许把别人的「已脱」混进来', () => {
    // 第 1 楼当前停在 swipe 0，但身上挂的是 swipe 1 那次的「已脱上衣」——必须整楼跳过。
    const chat = [
      withDelta([{ name: '温岚', wearing: 'white shirt' }], 0, 2),
      message({ [BBI_OUTFIT_EXTRA_KEY]: makeOutfitFloorDelta([{ name: '温岚', wearing: '', removed: ['top'] }], 1) }, 0, 2),
    ];
    const state = deriveOutfitSnapshots(chat);
    expect(state.get('温岚')).toEqual({ name: '温岚', wearing: 'white shirt' });
  });

  it('回放到指定楼层为止,不含该楼自身', () => {
    const chat = [
      withDelta([{ name: '温岚', wearing: 'floor0' }]),
      withDelta([{ name: '温岚', wearing: 'floor1' }]),
    ];
    expect(deriveOutfitSnapshots(chat, 1).get('温岚')?.wearing).toBe('floor0');
    expect(deriveOutfitSnapshots(chat, 2).get('温岚')?.wearing).toBe('floor1');
  });

  it('读聊天上下文并只回放到目标楼之前', () => {
    getContextMock.mockReturnValue({
      chat: [
        withDelta([{ name: '温岚', wearing: 'white shirt' }]),
        withDelta([{ name: '温岚', wearing: 'naked-ish' }]),
      ],
    });
    expect(outfitStatesBeforeFloor(1).get('温岚')?.wearing).toBe('white shirt');
    getContextMock.mockReturnValue(null);
    expect(outfitStatesBeforeFloor(1).size).toBe(0);
  });
});

describe('喂给提示词的指纹文本', () => {
  it('按三人称列出穿着/已脱/状态三段', () => {
    const text = buildOutfitSnapshotText(
      new Map<string, CharOutfitSnapshot>([
        ['顾子衿', { name: '顾子衿', wearing: 'white silk taoist robe, ankle-length', removed: ['bra'], stateNote: 'robe open front' }],
        ['温岚', { name: '温岚', wearing: '' }],
      ]),
    );
    expect(text).toContain('- 顾子衿：穿着[white silk taoist robe, ankle-length]｜已脱[bra]｜状态[robe open front]');
    expect(text).toContain('- 温岚：穿着[全裸]');
  });

  it('没有任何记录时给一句可执行的兜底说明,而不是空串', () => {
    expect(buildOutfitSnapshotText(new Map())).toContain('上一楼无服装记录');
  });
});
