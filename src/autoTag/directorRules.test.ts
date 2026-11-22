import { describe, expect, it } from 'vitest';

import { buildDirectorSystemPrompt } from '@/autoTag/prompt';

/**
 * 四条硬规则是「出图违和」的历史修复总结：情绪戏画成呆看镜头、递枪被画成枪口对人、
 * 主被动写反、男方接触点留空。文字型提示词没法断言语义，只锁这些关键判据不被人删掉。
 */
describe('导演通道硬规则', () => {
  const text = buildDirectorSystemPrompt(true, 1, 3);

  it('强情绪必须落地物理表现，禁止盯镜头干坐', () => {
    expect(text).toContain('burying face in chest');
    expect(text).toContain('trembling');
    expect(text).toContain('不许面对镜头干坐');
  });

  it('递交物品要写安全握持', () => {
    expect(text).toContain('offering handgun on open palm');
    expect(text).toContain('holding gun by barrel');
    expect(text).toContain('严禁写 "pointing"');
  });

  it('source#/target# 只放短动作词，不许长句/人名/中文', () => {
    expect(text).toContain('谁做出这个动作谁就是 source');
    expect(text).toContain('1～3 个单词');
    expect(text).toContain('出现中文，都算错');
  });

  it('男角色块必须补齐手部位置与 nl', () => {
    expect(text).toContain('hand on her hip');
    expect(text).toContain('接触点必须完全闭合');
  });
});
