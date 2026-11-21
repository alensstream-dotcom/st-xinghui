import { describe, expect, it } from 'vitest';

import type { TargetSegment } from '@/autoTag/clean';
import { parseDirectorPlan, parseStateSyncPlan } from '@/autoTag/protocol';

const segments: TargetSegment[] = [
  { id: 'P1', sourceLine: 0, text: '她走进教室，把书放在桌上。' },
  { id: 'P2', sourceLine: 2, text: '他把她按在门后，掀起了她的裙子。' },
];

describe('状态表通道的解析', () => {
  it('读懂 set_outfit 与 update_layer,并记下各自生效的物理行', () => {
    const plan = parseStateSyncPlan(
      JSON.stringify({
        v: 1,
        outfit: [
          {
            op: 'set_outfit',
            name: '温岚',
            position: 'P1',
            sceneHint: 'school morning',
            layers: {
              outer: { tag: 'white shirt', status: 'worn' },
              bottom: { tag: 'blue pleated skirt', status: 'worn' },
            },
          },
          { op: 'update_layer', name: '温岚', position: 'P2', layer: 'bottom', status: 'removed' },
        ],
      }),
      segments,
    );
    expect(plan.ops).toHaveLength(2);
    expect(plan.ops[0].sourceLine).toBe(0);
    expect(plan.ops[1].sourceLine).toBe(2);
    expect(plan.ops[1].op).toMatchObject({ op: 'update_layer', layer: 'bottom', status: 'removed' });
  });

  it('一条坏 op 只丢自己,不影响同批其它 op', () => {
    const plan = parseStateSyncPlan(
      JSON.stringify({
        outfit: [
          { op: 'set_outfit', name: '温岚', position: 'P1', layers: { outer: { tag: 'shirt', status: 'worn' } } },
          { op: 'update_layer', name: '温岚', layer: 'hat', status: 'removed' },
          { op: 'update_layer', name: '', layer: 'bottom', status: 'removed' },
          { op: 'update_layer', name: '温岚', layer: 'bra', status: 'floating' },
        ],
      }),
      segments,
    );
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops[0].op.op).toBe('set_outfit');
  });

  it('位置对不上时 set_outfit 落在首行、update_layer 丢弃(不乱猜行号)', () => {
    const plan = parseStateSyncPlan(
      JSON.stringify({
        outfit: [
          { op: 'set_outfit', name: '温岚', position: 'P99', layers: { outer: { tag: 'towel', status: 'worn' } } },
          { op: 'update_layer', name: '温岚', position: 'P99', layer: 'bra', status: 'removed' },
        ],
      }),
      segments,
    );
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops[0].sourceLine).toBe(0);
  });

  it('没有任何服装变化时返回空 ops,而不是报错', () => {
    expect(parseStateSyncPlan('{"v":1,"outfit":[]}', segments).ops).toEqual([]);
    expect(parseStateSyncPlan('{"v":1}', segments).ops).toEqual([]);
  });
});

describe('导演通道的解析', () => {
  it('按 position 定位,保留景别/场所/角色动作,超出上限截断', () => {
    const plan = parseDirectorPlan(
      JSON.stringify({
        v: 1,
        shots: [
          {
            position: 'P2',
            scale: 'cowboy shot',
            place: 'classroom door',
            characters: [
              { name: '温岚', expression: 'blush', action: '是 bent over the desk', omitFeatures: ['hair'] },
              { name: '李斌', action: 'holds her waist' },
            ],
          },
          { position: 'P1', scale: 'close-up', characters: [{ name: '温岚' }] },
          { position: 'P77', scale: 'full body', characters: [{ name: '温岚' }] },
        ],
      }),
      segments,
      1,
    );
    expect(plan.shots).toHaveLength(1);
    const [shot] = plan.shots;
    expect(shot.position).toBe('P2');
    expect(shot.sourceLine).toBe(2);
    expect(shot.scale).toBe('cowboy shot');
    expect(shot.place).toBe('classroom door');
    expect(shot.characters[0]).toMatchObject({ name: '温岚', expression: 'blush', omitFeatures: ['hair'] });
    expect(shot.characters[1].action).toBe('holds her waist');
  });

  it('景别不在四选一里就退回 cowboy shot,位置不在正文里就跳过该格', () => {
    const plan = parseDirectorPlan(
      JSON.stringify({ shots: [{ position: 'P1', scale: 'extreme macro', characters: [{ name: '温岚' }] }] }),
      segments,
      3,
    );
    expect(plan.shots[0].scale).toBe('cowboy shot');
    expect(parseDirectorPlan('{"shots":[]}', segments, 3).shots).toEqual([]);
  });

  it('没写名字的角色被丢掉,不会生成无名角色块', () => {
    const plan = parseDirectorPlan(
      JSON.stringify({ shots: [{ position: 'P1', characters: [{ name: '  ' }, { name: '温岚' }] }] }),
      segments,
      2,
    );
    expect(plan.shots[0].characters.map(item => item.name)).toEqual(['温岚']);
  });
});