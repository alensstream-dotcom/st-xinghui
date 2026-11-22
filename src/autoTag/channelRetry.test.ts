import { describe, expect, it, vi } from 'vitest';

import { runChannelWithRetries } from '@/autoTag/channelRetry';

function controller() {
  return new AbortController();
}

describe('分通道独立重试', () => {
  it('失败后重试到成功,并把第几次写进 source', async () => {
    const signal = controller().signal;
    const sources: string[] = [];
    let calls = 0;
    const result = await runChannelWithRetries(
      async ({ source }) => {
        sources.push(source);
        calls += 1;
        if (calls < 3) throw new Error('上游超时');
        return 'ok';
      },
      { retries: 2, signal, source: '镜头导演(第 3 楼)', onRetry: () => {} },
    );
    expect(result).toBe('ok');
    expect(sources).toEqual(['镜头导演(第 3 楼) · 第 1 次', '镜头导演(第 3 楼) · 第 2 次', '镜头导演(第 3 楼) · 第 3 次']);
  });

  it('重试次数用完就抛最后一次的错误', async () => {
    const signal = controller().signal;
    const dispatch = vi.fn(async () => {
      throw new Error('502 Bad Gateway');
    });
    await expect(
      runChannelWithRetries(dispatch, { retries: 1, signal, source: '服装状态表(第 1 楼)', onRetry: () => {} }),
    ).rejects.toThrow('502 Bad Gateway');
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('retries 为 0 时只发一次,source 不带次数后缀', async () => {
    const signal = controller().signal;
    const sources: string[] = [];
    const result = await runChannelWithRetries(
      async ({ source }) => {
        sources.push(source);
        return 'ok';
      },
      { retries: 0, signal, source: '镜头导演(第 1 楼)' },
    );
    expect(result).toBe('ok');
    expect(sources).toEqual(['镜头导演(第 1 楼)']);
  });

  it('已取消时立刻停,不再发请求', async () => {
    const ac = controller();
    ac.abort();
    const dispatch = vi.fn(async () => 'never');
    await expect(
      runChannelWithRetries(dispatch, { retries: 2, signal: ac.signal, source: '镜头导演(第 2 楼)', onRetry: () => {} }),
    ).rejects.toThrow('已取消');
    expect(dispatch).not.toHaveBeenCalled();
  });
});