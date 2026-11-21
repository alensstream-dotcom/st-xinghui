import { describe, expect, it } from 'vitest';

import {
  BBI_OUTFIT_EXTRA_KEY,
  applyOutfitOps,
  buildOutfitSnapshotText,
  deriveOutfitStates,
  emptyOutfitLayers,
  makeOutfitFloorDelta,
  outfitAtPosition,
  type OutfitFloorDelta,
  type RawOutfitOp,
  type StoredOutfitOp,
} from '@/state/outfitState';
import type { STMessage } from '@/st/context';

function floorMessage(op: RawOutfitOp, sourceLine: number, swipe = 0, storedSwipe = swipe): STMessage {
  const delta: OutfitFloorDelta = {
    v: 1,
    swipe: storedSwipe,
    ops: [{ sourceLine, op }],
  };
  return {
    name: 'Char',
    is_user: false,
    is_system: false,
    mes: '正文',
    swipe_id: swipe,
    extra: { [BBI_OUTFIT_EXTRA_KEY]: delta },
  };
}

const schoolUniform: RawOutfitOp = {
  op: 'set_outfit',
  name: '温岚',
  sceneHint: 'school morning',
  layers: {
    outer: { tag: 'white shirt', status: 'worn' },
    bra: { tag: 'pink bra', status: 'worn' },
    bottom: { tag: 'blue pleated skirt', status: 'worn' },
    panties: { tag: 'white panties', status: 'worn' },
    hosiery: { tag: 'kneehighs', status: 'worn' },
  },
};

describe('五层服装状态机', () => {
  it('逐楼回放:先穿校服,再被拉下胸罩,胸罩是 disheveled 其余不变', () => {
    const chat = [
      floorMessage(schoolUniform, 1),
      floorMessage(
        { op: 'update_layer', name: '温岚', layer: 'bra', status: 'disheveled', stateTag: 'pulled down' },
        3,
      ),
    ];
    const state = deriveOutfitStates(chat).get('温岚');
    expect(state?.layers.bra.status).toBe('disheveled');
    expect(state?.layers.bra.stateTag).toBe('pulled down');
    // 没被点到的层必须原样留在身上,否则「只脱一件」会变成全裸
    expect(state?.layers.bottom.status).toBe('worn');
    expect(state?.layers.outer.tag).toBe('white shirt');
  });

  it('swipe 不同就整楼跳过:切回另一条分支不会被另一条分支的「已脱」污染', () => {
    const chat = [
      floorMessage(schoolUniform, 1, 0),
      // 这一楼的正文是 swipe 0,但增量标记来自 swipe 1(用户切走过又切回来)
      floorMessage(
        { op: 'update_layer', name: '温岚', layer: 'bottom', status: 'removed' },
        2,
        0,
        1,
      ),
    ];
    const state = deriveOutfitStates(chat).get('温岚');
    // 第 1 楼当前是 swipe 0,它的增量标记的是 swipe 1 → 不生效
    expect(state?.layers.bottom.status).toBe('worn');
  });

  it('换装是整体替换:set_outfit 之后上一身的内裤不会留在身上', () => {
    const before = applyOutfitOps(new Map(), [schoolUniform]);
    const after = applyOutfitOps(before, [
      {
        op: 'set_outfit',
        name: '温岚',
        sceneHint: 'bath',
        layers: {
          outer: { tag: 'towel', status: 'worn' },
          hosiery: { tag: 'slippers', status: 'worn' },
        },
      },
    ]);
    const layers = after.get('温岚')?.layers;
    expect(layers?.outer.tag).toBe('towel');
    expect(layers?.panties.status).toBe('removed');
    expect(layers?.panties.tag).toBe('');
  });

  it('同一楼多个 P 节点按行号切片:前半楼穿着,后半楼才被脱掉', () => {
    const base = applyOutfitOps(new Map(), [schoolUniform]);
    const floorOps: StoredOutfitOp[] = [
      {
        sourceLine: 40,
        op: { op: 'update_layer', name: '温岚', layer: 'outer', status: 'disheveled', stateTag: 'unbuttoned' },
      },
      {
        sourceLine: 80,
        op: { op: 'update_layer', name: '温岚', layer: 'bottom', status: 'removed' },
      },
    ];
    const early = outfitAtPosition(base, floorOps, 35).get('温岚');
    const middle = outfitAtPosition(base, floorOps, 60).get('温岚');
    const late = outfitAtPosition(base, floorOps, 90).get('温岚');
    expect(early?.layers.outer.status).toBe('worn');
    expect(middle?.layers.outer.stateTag).toBe('unbuttoned');
    expect(middle?.layers.bottom.status).toBe('worn');
    expect(late?.layers.bottom.status).toBe('removed');
  });

  it('快照文本把三态写清楚,读的人不用猜', () => {
    const state = applyOutfitOps(new Map(), [
      schoolUniform,
      { op: 'update_layer', name: '温岚', layer: 'bra', status: 'disheveled', stateTag: 'pulled down' },
      { op: 'update_layer', name: '温岚', layer: 'panties', status: 'removed' },
    ]);
    const text = buildOutfitSnapshotText(state);
    expect(text).toContain('bra=pink bra:disheveled(pulled down)');
    expect(text).toContain('panties=white panties:removed(已脱)');
    expect(text).toContain('outer=white shirt:worn(穿着)');
  });

  it('空状态时说清楚「本楼首次出场请 set_outfit」,而不是留一个空行', () => {
    expect(buildOutfitSnapshotText(new Map())).toContain('set_outfit');
    expect(emptyOutfitLayers().bra.status).toBe('removed');
  });

  it('落盘格式能原样读回', () => {
    const delta = makeOutfitFloorDelta([{ sourceLine: 12, op: schoolUniform }], 2);
    expect(delta).toBeDefined();
    const message = { name: 'Char', is_user: false, is_system: false, mes: '', swipe_id: 2, extra: { [BBI_OUTFIT_EXTRA_KEY]: delta } } as STMessage;
    expect(deriveOutfitStates([message]).get('温岚')?.layers.outer.tag).toBe('white shirt');
    expect(makeOutfitFloorDelta([], 0)).toBeUndefined();
  });
});