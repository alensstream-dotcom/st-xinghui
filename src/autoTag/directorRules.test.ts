import { describe, expect, it } from 'vitest';

import { buildUsedTraitsSummary, unifiedSystemPrompt } from './prompt';
import { defaultWorldAnchor } from '@/state/worldAnchor';
import type { CharTagEntry } from '@/state/charTags';

const world = defaultWorldAnchor();
const prompt = unifiedSystemPrompt(world, true, 1, 3);

describe('单通道系统提示词', () => {
  it('四区块结构：建档世界观 / 装备跨楼 / 选帧构图 / 纯 JSON 输出', () => {
    expect(prompt).toContain('① 建档与世界观');
    expect(prompt).toContain('② 装备表与跨楼规则');
    expect(prompt).toContain('③ 选帧与构图防线');
    expect(prompt).toContain('④ 严格纯 JSON 输出');
    // 只保留四个区块标题，旧的「规则 1/4/8/12」分头编号不再出现。
    expect(prompt).not.toContain('规则 1（建档范围与匿名角色衔接）');
    expect(prompt).not.toContain('规则 8（选帧：先分级');
  });

  it('一份 JSON 出全部：世界观、跨楼判定、建档、装备变化、图片', () => {
    expect(prompt).toContain('"worldPreset":"modern"');
    expect(prompt).toContain('"timeJump":"same_day"');
    expect(prompt).toContain('"wardrobeUpdates":[{');
    expect(prompt).toContain('"changes":[{');
    expect(prompt).toContain('"images":[{');
  });

  it('禁止 <thinking>，要求直接输出 JSON', () => {
    expect(prompt).toContain('禁止 <thinking>');
    expect(prompt).toContain('直接输出一个合法 JSON 对象');
  });

  it('世界观块注入，且点名这个世界观的防穿帮单品', () => {
    expect(prompt).toContain('【本聊天世界观】');
    expect(prompt).toContain(world.label);
  });

  it('选帧保留 S/A/B/C 分级、峰值帧与一姿势一图红线', () => {
    expect(prompt).toContain('S 级');
    expect(prompt).toContain('A 级');
    expect(prompt).toContain('C 级跳过');
    expect(prompt).toContain('峰值帧');
    expect(prompt).toContain('一姿势一图');
    // 挑逗与显式 NSFW 必须平级，不许互相让位。
    expect(prompt).toContain('平级互不让位');
  });

  it('装备表三条确定性规则写清楚（穿回只回 on / half 必配 halfTag / 连身不补下装）', () => {
    expect(prompt).toContain('穿回原来那件');
    expect(prompt).toContain('half 必须配 halfTag');
    expect(prompt).toContain('连身服饰');
    expect(prompt).toContain('肚兜→"red halterneck camisole');
    expect(prompt).toContain('永不改写');
  });

  it('同日可在正文明确换装时 replace、隔天主动 replace，且不再要求任何附加开关', () => {
    expect(prompt).toContain('same_day');
    expect(prompt).toContain('正文明确换装');
    expect(prompt).toContain('new_day');
    // 二级开关陷阱已删：模型只要发了 replace 就照做。
    expect(prompt).not.toContain('explicitChange');
    expect(prompt).toContain('同楼中途换装');
    expect(prompt).toContain('position:"P10"');
  });

  it('导演禁写清单包含人数、发色、瞳色、体型与服装词', () => {
    expect(prompt).toContain('characters[].tag **禁写**');
    expect(prompt).toContain('性别人数词');
    expect(prompt).toContain('发色发型刘海词');
    expect(prompt).toContain('瞳色眼型肤色词');
    expect(prompt).toContain('任何服装词');
  });

  it('标记规则：主宾写对、只接 1～3 词英文动作、成对绑定', () => {
    expect(prompt).toContain('mutual#<1～3 词英文动作>');
    expect(prompt).toContain('绝不写反');
    expect(prompt).toContain('两侧逐字相同');
  });

  it('五条防偏见规则齐全（握持 / 情绪物理化 / 双方闭合 / 标记 / 光线景别）', () => {
    expect(prompt).toContain('五条防偏见');
    expect(prompt).toContain('递交/收示枪刀');
    expect(prompt).toContain('强情绪物理化');
    expect(prompt).toContain('双人互动双方闭合');
    expect(prompt).toContain('高低差互动');
    expect(prompt).toContain('禁默认夜间霓虹');
  });

  it('景别与机位规则保留（pov 与第三人称互斥、轮换）', () => {
    expect(prompt).toContain('pov（女主默认 looking at viewer）');
    expect(prompt).toContain('连续两张或跨楼同体位必须换机位与景别');
    expect(prompt).toContain('男主整个人或上半身入镜一律第三人称禁 pov');
  });

  it('omitFeatures 只管配饰，禁摘身份字段', () => {
    expect(prompt).toContain('omitFeatures 只放本帧看不见的**配饰**');
    expect(prompt).toContain('禁放 hair/eyes/skin/body');
  });

  it('nl 与装备一致，不另写衣物款式', () => {
    expect(prompt).toContain('除非正文这格明确写了穿脱，否则不写衣服款式颜色');
  });

  it('精简后不再出现旧的重复口径（双并发遗留）', () => {
    expect(prompt).not.toContain('规则 12（输出纪律）');
    expect(prompt).not.toContain('规则 11（五条防偏见硬规则');
  });
});

describe('高频占用统计', () => {
  const makeEntry = (name: string, hair: string, eyes: string, extra: string): CharTagEntry =>
    ({
      name,
      fields: {
        fandom: '', sex: '1girl', hair, eyes, skin: 'fair skin', body: 'slender', extra, outfit: '', new: '', raw: '', nl: '',
      },
      raw: '',
      nl: '',
      source: 'ai',
      desc: '',
      history: [],
    }) as CharTagEntry;

  it('发色按颜色归一统计，≥2 次才列出来', () => {
    const summary = buildUsedTraitsSummary([
      makeEntry('甲', 'long black hair, straight hair, hair down', 'brown eyes, tareme', 'round eyewear'),
      makeEntry('乙', 'short black hair, wavy hair', 'red eyes, tsurime', 'hairclip'),
    ]);
    expect(summary).toContain('black hair(2)');
  });

  it('没有高频占用时给出「仍须主动错开」的提示', () => {
    const summary = buildUsedTraitsSummary([makeEntry('甲', 'long black hair', 'brown eyes, tareme', '')]);
    expect(summary).toContain('仍须按规则 3 主动错开');
  });
});
