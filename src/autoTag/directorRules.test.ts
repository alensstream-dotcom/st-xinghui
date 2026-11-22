import { describe, expect, it } from 'vitest';

import { buildDirectorSystemPrompt } from '@/autoTag/prompt';
import { WORLD_PRESETS } from '@/state/worldAnchor';

/**
 * 五条防偏见硬规则是「出图违和」的历史修复总结：情绪戏画成呆看镜头、递枪被画成枪口对人、
 * 主被动写反、男方接触点留空、白天画成霓虹夜。文字型提示词没法断言语义，只锁关键判据。
 */
describe('导演通道硬规则', () => {
  const text = buildDirectorSystemPrompt(true, 1, 3);

  it('强情绪必须落地物理表现，禁止看镜头摆拍', () => {
    expect(text).toContain('burying face in chest');
    expect(text).toContain('trembling');
    expect(text).toContain('反「看镜头摆拍」');
    expect(text).toContain('严禁写 "looking at viewer"');
  });

  it('递交物品要写安全握持', () => {
    expect(text).toContain('offering handgun on open palm');
    expect(text).toContain('holding gun by barrel');
    expect(text).toContain('严禁写 "pointing"');
  });

  it('source#/target# 只放短动作词，不许长句/人名/中文', () => {
    expect(text).toContain('谁施动写 source');
    expect(text).toContain('1～3 词简短英文标准动词');
    expect(text).toContain('严禁塞长句、人名或中文');
  });

  it('男角色块必须补齐手部位置与 nl', () => {
    expect(text).toContain('hand on her hip');
    expect(text).toContain('与女方动作完全闭合');
    expect(text).toContain('source#holding her wrists');
  });

  it('光线与景别必须对齐正文，不许白天画成霓虹夜', () => {
    expect(text).toContain('光线、时间与景别严格对齐正文');
    expect(text).toContain('严禁把白天画成霓虹夜景');
  });

  it('注入世界观时带上角色边界与防穿帮负面', () => {
    const world = { ...WORLD_PRESETS.chinese_ancient, lockedByUser: true };
    const withWorld = buildDirectorSystemPrompt(true, 1, 3, world);
    expect(withWorld).toContain('【本聊天世界观】');
    expect(withWorld).toContain('中式古风');
    expect(withWorld).toContain('jeans, sneakers');
    expect(withWorld).toContain('绝不能出现的单品');
  });

  it('不注入世界观时不留空的占位段', () => {
    expect(text).not.toContain('【本聊天世界观】');
  });
});