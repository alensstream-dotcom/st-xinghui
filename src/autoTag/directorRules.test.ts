import { describe, expect, it } from 'vitest';

import { buildUsedTraitsSummary, unifiedSystemPrompt } from './prompt';
import { defaultWorldAnchor } from '@/state/worldAnchor';
import type { CharTagEntry } from '@/state/charTags';

const world = defaultWorldAnchor();
const prompt = unifiedSystemPrompt(world, true, 1, 3);

describe('单通道系统提示词', () => {
  it('一份 JSON 出全部：世界观、跨楼判定、建档、装备变化、图片', () => {
    expect(prompt).toContain('{"worldPreset":"modern","timeJump":"same_day","changes":[...],"wardrobeUpdates":[...]');
    expect(prompt).toContain('规则 4（装备表 wardrobeUpdates）');
    expect(prompt).toContain('规则 5（timeJump 跨楼判定）');
    expect(prompt).toContain('规则 8（选帧');
  });

  it('禁止 <thinking>，要求直接输出 JSON', () => {
    expect(prompt).toContain('不要写 <thinking>');
    expect(prompt).not.toContain('<thinking> 示例');
  });

  it('世界观块注入，且点名这个世界观的防穿帮单品', () => {
    expect(prompt).toContain('【本聊天世界观】');
    expect(prompt).toContain(world.label);
  });

  it('选帧保留 S/A/B/C 分级与一姿势一图红线', () => {
    expect(prompt).toContain('S 级');
    expect(prompt).toContain('峰值帧');
    expect(prompt).toContain('一姿势一图');
  });

  it('装备表三条确定性规则写清楚（穿回只回 on / half 必配 halfTag / 连身不补下装）', () => {
    expect(prompt).toContain('patch 里给 status:"on" 且省略 tag，就等于「穿回原来那件」');
    expect(prompt).toContain('half 必须配 halfTag');
    expect(prompt).toContain('连身服饰');
    expect(prompt).toContain('肚兜→"red halterneck camisole');
  });

  it('同日严禁 replace、隔天主动 replace', () => {
    expect(prompt).toContain('"same_day"');
    expect(prompt).toContain('严禁发 mode:"replace"');
    expect(prompt).toContain('"new_day"');
  });

  it('导演禁写清单包含人数、发色、瞳色、体型与服装词', () => {
    expect(prompt).toContain('characters[].tag 绝对禁止出现');
    expect(prompt).toContain('1girl / girl');
    expect(prompt).toContain('hair / bangs / ponytail');
    expect(prompt).toContain('eyes / tsurime / tareme');
  });

  it('标记规则：主宾写对、只接 1～3 词英文动作、成对绑定', () => {
    expect(prompt).toContain('source#<英文动作>');
    expect(prompt).toContain('1～3 词英文动作词');
  });

  it('五条防偏见规则齐全（握持 / 情绪物理化 / 双方闭合 / 标记 / 光线景别）', () => {
    expect(prompt).toContain('递交物品非攻击握持');
    expect(prompt).toContain('强情绪物理化');
    expect(prompt).toContain('双人互动双方闭合');
    expect(prompt).toContain('高低差互动');
  });

  it('景别与机位规则保留（pov 与第三人称互斥、轮换）', () => {
    expect(prompt).toContain('pov 优先');
    expect(prompt).toContain('连续两张或跨楼同体位必须轮换机位与景别');
  });

  it('omitFeatures 只管配饰，禁摘身份字段', () => {
    expect(prompt).toContain('omitFeatures 只用于本帧临时摘下或看不见的**配饰**');
    expect(prompt).toContain('严禁把 hair / eyes / skin / body 放进去');
  });

  it('nl 与装备一致，不另写衣物款式', () => {
    expect(prompt).toContain('除非正文这一格明确写了穿脱动作，否则不要另写衣服款式与颜色');
  });
});

describe('buildUsedTraitsSummary', () => {
  function entry(name: string, hair: string, eyes: string, extra = ''): CharTagEntry {
    return {
      name,
      fields: { sex: '1girl', hair, eyes, skin: 'fair skin', body: 'petite', extra, outfit: '', fandom: '' },
      raw: '',
    } as CharTagEntry;
  }

  it('≥2 次的发色/发型/瞳色/配饰列为高频占用', () => {
    const summary = buildUsedTraitsSummary([
      entry('甲', 'long black hair, straight hair, hair down', 'brown eyes, tareme', 'silver hairpin'),
      entry('乙', 'long black hair, twintails', 'brown eyes, tsurime', 'silver hairpin'),
    ]);
    expect(summary).toContain('black hair(2)');
    expect(summary).toContain('long hair(2)');
    expect(summary).toContain('brown eyes(2)');
    expect(summary).toContain('silver hairpin(2)');
  });

  it('只出现一次的不算高频，空库给提示语', () => {
    expect(buildUsedTraitsSummary([entry('甲', 'pink hair', 'blue eyes')])).toContain('暂无高频占用');
    expect(buildUsedTraitsSummary([])).toContain('暂无高频占用');
  });
});