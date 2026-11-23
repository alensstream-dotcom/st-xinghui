import { describe, expect, it } from 'vitest';

import { parseUnifiedPlan } from './protocol';
import { runChannelWithRetries } from './channelRetry';
import type { TargetSegment } from './clean';

function segments(text: string): TargetSegment[] {
  return text
    .split(/\n+/)
    .filter(Boolean)
    .map((line, index) => ({ id: `P${index + 1}`, sourceLine: index } as TargetSegment));
}

const TEXT = ['她推开道观的门。', '他伸手把她按在门框上，低头吻她。', '她的道袍被撩到腰际。'].join('\n');
const SEGS = segments(TEXT);

describe('parseUnifiedPlan（单通道一次输出）', () => {
  it('解析世界观、跨楼判定、建档、装备变化与逐帧 wearState', () => {
    const raw = JSON.stringify({
      worldPreset: 'chinese_ancient',
      timeJump: 'new_day',
      changes: [
        {
          name: '顾子衿',
          field: 'new',
          reason: '首次出场',
          position: 'P1',
          fields: { sex: '1girl', hair: 'long black hair', eyes: 'amber eyes', skin: 'fair skin', body: 'petite', extra: 'jade pendant' },
        },
      ],
      wardrobeUpdates: [
        {
          name: '顾子衿',
          mode: 'replace',
          slots: {
            top: { tag: 'plain white silk taoist robe, ankle-length', status: 'on' },
            innerTop: { tag: 'white halterneck camisole, backless', status: 'on' },
          },
        },
      ],
      images: [
        {
          position: 'P2',
          tag: '1girl, 1boy, temple gate, pov, cowboy shot',
          nl: 'He presses her against the door frame.',
          characters: [
            {
              name: '顾子衿',
              omitFeatures: ['jade pendant'],
              wearState: { top: { status: 'half', halfTag: 'robe open front' } },
              tag: 'blush, looking up',
              nl: 'She leans back.',
            },
          ],
        },
      ],
    });

    const plan = parseUnifiedPlan(raw, SEGS, 1, 2);
    expect(plan.worldPreset).toBe('chinese_ancient');
    expect(plan.timeJump).toBe('new_day');
    expect(plan.changes).toHaveLength(1);
    expect(plan.wardrobeUpdates[0]?.mode).toBe('replace');
    expect(plan.wardrobeUpdates[0]?.slots.top?.status).toBe('on');
    expect(plan.images[0]?.characters[0]?.wearState?.top).toEqual({ status: 'half', halfTag: 'robe open front' });
    expect(plan.images[0]?.characters[0]?.omitFeatures).toEqual(['jade pendant']);
  });

  it('timeJump 缺省按 same_day', () => {
    const raw = JSON.stringify({ images: [{ position: 'P1', tag: '1girl, room, cowboy shot' }] });
    expect(parseUnifiedPlan(raw, SEGS, 0, 2).timeJump).toBe('same_day');
  });

  it('缺 images 时抛出可重试的错误', () => {
    expect(() => parseUnifiedPlan(JSON.stringify({ changes: [] }), SEGS, 0, 2)).toThrow(/缺少 images 数组/);
  });

  it('容错 shots 容器与前置空对象', () => {
    const raw = '{"debug":1}\n' + JSON.stringify({ shots: [{ position: 'P3', tag: '1girl, room, upper body' }] });
    const plan = parseUnifiedPlan(raw, SEGS, 0, 2);
    expect(plan.images[0]?.position).toBe('P3');
  });

  it('兼容 outfits 键与非法状态码', () => {
    const raw = JSON.stringify({
      outfits: [{ name: '顾子衿', mode: 'patch', slots: { top: { tag: 'robe', status: 'naked' } } }],
      images: [{ position: 'P1', tag: '1girl, room, cowboy shot' }],
    });
    const plan = parseUnifiedPlan(raw, SEGS, 0, 2);
    expect(plan.wardrobeUpdates[0]?.slots.top).toBeUndefined();
  });
});

describe('单通道解析失败会触发重试（截断诊断）', () => {
  it('第一次缺 images、第二次成功', async () => {
    const responses = ['{"changes":[]}', JSON.stringify({ images: [{ position: 'P1', tag: '1girl, room, cowboy shot' }] })];
    let calls = 0;
    const plan = await runChannelWithRetries(
      async () => {
        const raw = responses[Math.min(calls, responses.length - 1)];
        calls += 1;
        return parseUnifiedPlan(raw, SEGS, 0, 2);
      },
      { retries: 1, signal: new AbortController().signal, source: '出图计划(测试)' },
    );
    expect(calls).toBe(2);
    expect(plan.images[0]?.position).toBe('P1');
  });

  it('重试耗尽把错误抛回调用方', async () => {
    await expect(
      runChannelWithRetries(
        async () => parseUnifiedPlan('{"changes":[]}', SEGS, 0, 2),
        { retries: 0, signal: new AbortController().signal, source: '出图计划(测试)' },
      ),
    ).rejects.toThrow(/缺少 images 数组/);
  });
});