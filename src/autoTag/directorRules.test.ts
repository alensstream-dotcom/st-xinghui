import { describe, expect, it } from 'vitest';

import {
  buildDirectorSystemPrompt,
  buildStateSyncMessages,
  buildUsedTraitsSummary,
  directorReferenceBlocks,
  stateSyncSystemPrompt,
} from '@/autoTag/prompt';
import type { PreparedTargetText } from '@/autoTag/clean';
import type { STContext } from '@/st/context';
import type { AutoTagSettings } from '@/state/settings';
import { WORLD_PRESETS, defaultWorldAnchor } from '@/state/worldAnchor';
import { emptyCharFields, type CharTagEntry } from '@/state/charTags';

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
describe('世界观示例不能倒灌现代单品', () => {
  const ancient = {
    ...defaultWorldAnchor(),
    ...WORLD_PRESETS.chinese_ancient,
    presetId: 'chinese_ancient' as const,
    lockedByUser: true,
  };

  it('chinese_ancient 的状态表提示词里不出现丝袜与百褶短裙示例', () => {
    const text = stateSyncSystemPrompt(ancient);
    expect(text).not.toContain('pantyhose');
    expect(text).not.toContain('pleated miniskirt');
    expect(text).not.toContain('pleated skirt');
    expect(text).toContain('taoist robe');
  });

  it('modern 的状态表提示词仍然给出现代示例（保持原有可用性）', () => {
    const text = stateSyncSystemPrompt({ ...defaultWorldAnchor(), presetId: 'modern', lockedByUser: true });
    expect(text).toContain('20 denier sheer black pantyhose');
  });

  it('状态表规则明确：连身长袍不得凭空补下装，正文写的优先于世界观', () => {
    const text = stateSyncSystemPrompt(ancient);
    expect(text).toContain('连身服饰不得凭空补下装');
    expect(text).toContain('正文写的优先于世界观默认');
    expect(text).toContain('bottom 与 hosiery 的 tag 必须留空字符串');
  });
});

describe('导演通道：omitFeatures 与 pov 口径', () => {
  const text = buildDirectorSystemPrompt(true, 1, 3);

  it('omitFeatures 只许摘配饰，严禁摘 hair/eyes/skin/body', () => {
    expect(text).toContain('只用于本帧临时摘下或看不见的**配饰**');
    expect(text).toContain('严禁把 hair / eyes / skin / body 放进去');
    expect(text).not.toContain('只拍下半身就写 ["hair","eyes","skin","body"]');
  });

  it('pov 与男主入镜互斥', () => {
    expect(text).toContain('pov 与男主入镜互斥');
    expect(text).toContain('严禁写 pov');
  });

  it('S 级把挑逗/支配与显式动作并列', () => {
    expect(text).toContain('高张力暧昧挑逗与支配 / 服从、强肢体拉扯');
    expect(text).toContain('这两类不许互相让位');
  });

  it('一姿势一图红线与节拍均衡', () => {
    expect(text).toContain('一姿势一图红线');
    expect(text).toContain('节拍均衡');
  });
});

function charEntry(name: string, fields: Partial<Record<string, string>>): CharTagEntry {
  return { name, fields: { ...emptyCharFields(), ...fields }, raw: '', nl: '', source: 'manual', desc: '', history: [] };
}

describe('防撞脸：高频占用统计', () => {
  it('统计出 ≥2 次的发色 / 发型 / 配饰，并忽略男性条目', () => {
    const summary = buildUsedTraitsSummary([
      charEntry('甲', { sex: '1girl', hair: 'long black hair, hair down, blunt bangs', eyes: 'brown eyes, tareme', extra: 'forehead mark, earrings' }),
      charEntry('乙', { sex: '1girl', hair: 'long black hair, hair down, parted bangs', eyes: 'brown eyes, tsurime', extra: 'forehead mark, choker' }),
      charEntry('丙', { sex: '1girl', hair: 'silver hair, twin braids', eyes: 'blue eyes, tareme', extra: 'earrings' }),
      charEntry('男主', { sex: '1boy', hair: 'black hair, short hair', eyes: 'brown eyes', extra: 'glasses' }),
    ]);
    // 发色按颜色归一：'long black hair' 与 'black hair' 都要归到 black hair，否则重复被拆成两个 key 漏报
    expect(summary).toContain('black hair×2');
    expect(summary).toContain('long hair×2');
    expect(summary).toContain('hair down×2');
    expect(summary).toContain('brown eyes×2');
    expect(summary).toContain('earrings×2');
    expect(summary).toContain('forehead mark×2');
    expect(summary).not.toContain('black hair×3');
  });

  it('没有重复时不瞎编，给出明确的空状态', () => {
    const summary = buildUsedTraitsSummary([charEntry('甲', { sex: '1girl', hair: 'long black hair', eyes: 'brown eyes, tareme', extra: 'mole under eye' })]);
    expect(summary).toContain('暂无高频占用');
  });
});

describe('导演只读参考块', () => {
  it('把服装快照以只读块附进去，并声明不许重写衣服', () => {
    const block = directorReferenceBlocks('温岚｜outer: white silk taoist robe, worn', '入画角色：温岚｜Base：1girl, bedroom');
    expect(block).toContain('【当前角色服装只读参考');
    expect(block).toContain('绝不要在 tag 里重写衣服');
    expect(block).toContain('white silk taoist robe');
    expect(block).toContain('【上一张图】');
  });

  it('没有快照也没有上一张图时返回空串（不产生空标题）', () => {
    expect(directorReferenceBlocks('  ', '')).toBe('');
  });
});

describe('导演通道：外貌/服装禁写与比例防畸变', () => {
  const text = buildDirectorSystemPrompt(true, 1, 3);

  it('明写已建档女角色禁止写人数词/发色/瞳色/体型/服装', () => {
    expect(text).toContain('绝对禁止出现');
    expect(text).toContain('性别人数词');
    expect(text).toContain('任何服装词');
    expect(text).toContain('写了也会被程序整条剥掉');
  });

  it('高低差互动禁仰拍', () => {
    expect(text).toContain('高低差禁仰拍');
    expect(text).toContain('严禁用 from below / low angle 仰拍');
  });

  it('状态表提示词要求 body 只写 2～3 个精准核心词', () => {
    const sync = stateSyncSystemPrompt({ ...defaultWorldAnchor(), presetId: 'modern', lockedByUser: true });
    expect(sync).toContain('body 只写 2～3 个精准核心词');
    expect(sync).toContain('不要默认加 "tall female" 与 "long legs"');
    expect(sync).toContain('已高频占用的特征');
  });
});

describe('双通道上下文承接', () => {
  it('状态表与导演的 user 消息都带上上一楼原文（否则只看本楼，穿脱与体位接不上）', async () => {
    const context = {
      chat: [
        { name: '用户', is_user: true, is_system: false, mes: '开场。' },
        { name: '温岚', is_user: false, is_system: false, mes: '上一楼：她解开衬衫扣子，坐到他腿上。' },
        { name: '用户', is_user: true, is_system: false, mes: '本楼提问。' },
        { name: '温岚', is_user: false, is_system: false, mes: '本楼正文。' },
      ],
      chatMetadata: {},
      name1: '用户',
      name2: '温岚',
      getCurrentChatId: () => 'chat-1',
      getRequestHeaders: () => ({}),
      saveMetadataDebounced: () => {},
      saveChat: async () => {},
    } as unknown as STContext;
    const messages = await buildStateSyncMessages({
      context,
      targetFloor: 3,
      options: { contextMessages: 4 } as unknown as AutoTagSettings,
      preparedTarget: { promptText: '本楼正文。', segments: [] } as unknown as PreparedTargetText,
      memoryText: '',
      libraryBlock: '',
      outfitSnapshot: '',
      nlOn: true,
      minImages: 1,
      maxImages: 2,
      world: defaultWorldAnchor(),
    });
    const user = String(messages[messages.length - 1].content);
    expect(user).toContain('上一楼及之前的上下文');
    expect(user).toContain('她解开衬衫扣子');
    expect(user).toContain('本楼正文');
    // 上一楼在前、目标正文在后：模型是从上往下读的
    expect(user.indexOf('她解开衬衫扣子')).toBeLessThan(user.indexOf('目标正文'));
  });
});
