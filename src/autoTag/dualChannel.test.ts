import { describe, expect, it } from 'vitest';

import type { TargetSegment } from '@/autoTag/clean';
import { parseImagePlan, parseStateSyncPlan } from '@/autoTag/protocol';
import { buildNaiParameters, type NaiGenerateValues } from '@/backends/nai';
import type { NaiRunConfig } from '@/state/settings';
import { parseImageTagContent, serializeImageTag } from '@/st/imageTagRegex';

const segments: TargetSegment[] = [
  { id: 'P1', sourceLine: 0, text: '她走进教室，把书放在桌上。' },
  { id: 'P2', sourceLine: 2, text: '他把她按在门后，掀起了她的裙子。' },
];

function nai(overrides: Partial<NaiRunConfig> = {}): NaiRunConfig {
  return {
    endpointId: 'nep_official',
    url: 'https://image.novelai.net',
    key: 'nai-test',
    model: 'nai-diffusion-4-5-full',
    artist: null,
    qualityTags: '',
    undesiredContent: '',
    sampler: 'k_euler',
    steps: 28,
    scale: 5,
    cfgRescale: 0,
    noiseSchedule: 'karras',
    seed: 0,
    varietyBoost: true,
    normalizeRefStrength: true,
    vibes: [],
    portraitSize: '832×1216',
    landscapeSize: '1216×832',
    ...overrides,
  };
}

describe('状态表通道的解析(结楼指纹 v2)', () => {
  it('读出每楼结束时的穿搭快照:穿着/已脱/状态', () => {
    const plan = parseStateSyncPlan(
      JSON.stringify({
        changes: [],
        finalOutfits: [
          { name: '温岚', wearing: 'white shirt, jeans', removed: ['bra'], stateNote: 'shirt lifted above chest' },
          { name: '顾子衿', wearing: '' },
        ],
      }),
      segments,
      {},
    );
    expect(plan.finalOutfits).toHaveLength(2);
    expect(plan.finalOutfits[0]).toEqual({
      name: '温岚',
      wearing: 'white shirt, jeans',
      removed: ['bra'],
      stateNote: 'shirt lifted above chest',
    });
    expect(plan.finalOutfits[1]).toEqual({ name: '顾子衿', wearing: '' });
  });

  it('坏条目只丢自己:缺名跳过,removed 归一成小写去重,wearing 压成一行', () => {
    const plan = parseStateSyncPlan(
      JSON.stringify({
        changes: [],
        finalOutfits: [
          { name: '  ', wearing: 'ghost dress' },
          { name: '温岚', wearing: 'white shirt,\n  jeans', removed: ['Bra', 'BRA', ' panties '] },
          { name: '顾子衿', wearing: 42, removed: 'bra' },
        ],
      }),
      segments,
      {},
    );
    expect(plan.finalOutfits).toHaveLength(2);
    expect(plan.finalOutfits[0]).toEqual({
      name: '温岚',
      wearing: 'white shirt, jeans',
      removed: ['bra', 'panties'],
    });
    expect(plan.finalOutfits[1]).toEqual({ name: '顾子衿', wearing: '' });
  });

  it('没有女角或没有变化时输出空数组,而不是报错', () => {
    expect(parseStateSyncPlan('{"changes":[],"finalOutfits":[]}', segments, {}).finalOutfits).toEqual([]);
    expect(parseStateSyncPlan('{"v":1}', segments, {}).finalOutfits).toEqual([]);
    expect(parseStateSyncPlan('不是 JSON', segments, {})).toEqual({ changes: [], finalOutfits: [] });
  });

  it('兼容 outfits 键名(模型偶尔漏写 final)', () => {
    const plan = parseStateSyncPlan(
      '{"changes":[],"outfits":[{"name":"温岚","wearing":"white shirt"}]}',
      segments,
      {},
    );
    expect(plan.finalOutfits).toEqual([{ name: '温岚', wearing: 'white shirt' }]);
  });

  it('建档 changes 与快照可以同时出现,互不吞掉', () => {
    const plan = parseStateSyncPlan(
      JSON.stringify({
        changes: [
          { name: '温岚', field: 'new', fields: { sex: '1girl', hair: 'black hair, long hair', eyes: 'brown eyes' }, position: 'P1', reason: '首次登场' },
        ],
        finalOutfits: [{ name: '温岚', wearing: 'white shirt' }],
      }),
      segments,
      {},
    );
    expect(plan.changes).toHaveLength(1);
    expect(plan.finalOutfits).toHaveLength(1);
  });
});

describe('状态表通道的世界观识别', () => {
  it('首楼带 worldPreset 时原样透出,没带时字段不出现', () => {
    const withPreset = parseStateSyncPlan(
      '{"worldPreset":"chinese_ancient","changes":[],"finalOutfits":[]}',
      segments,
      {},
    );
    expect(withPreset.worldPreset).toBe('chinese_ancient');
    expect(withPreset.changes).toEqual([]);
    expect(withPreset.finalOutfits).toEqual([]);

    const without = parseStateSyncPlan('{"changes":[],"finalOutfits":[]}', segments, {});
    expect('worldPreset' in without).toBe(false);
  });

  it('后面的楼层不再重复输出,也不会把已有值清成空串', () => {
    const blank = parseStateSyncPlan('{"worldPreset":"   ","changes":[],"finalOutfits":[]}', segments, {});
    expect('worldPreset' in blank).toBe(false);
  });
});

describe('导演通道的输出(走 parseImagePlan)', () => {
  it('保留完整 Base.tag/nl 与角色 tag/nl,位置不在正文里就跳过', () => {
    const plan = parseImagePlan(
      JSON.stringify({
        images: [
          {
            position: 'P2',
            tag: '1girl, 1boy, from front, cowboy shot, classroom, dim lighting, vaginal sex',
            nl: 'He presses her against the door and pushes into her.',
            characters: [
              {
                name: '温岚',
                omitFeatures: ['hair'],
                tag: 'parted lips, source#李斌, target#温岚, mutual#vaginal sex',
                nl: 'She braces her hands on the door.',
              },
            ],
            size: 'portrait',
          },
        ],
      }),
      segments,
      0,
      2,
    );
    expect(plan.images).toHaveLength(1);
    const [insertion] = plan.images;
    expect(insertion.position).toBe('P2');
    expect(insertion.tag).toContain('cowboy shot');
    expect(insertion.tag).toContain('vaginal sex');
    expect(insertion.nl).toContain('pushes into her');
    expect(insertion.characters[0]).toMatchObject({
      name: '温岚',
      omitFeatures: ['hair'],
      tag: 'parted lips, source#李斌, target#温岚, mutual#vaginal sex',
      nl: 'She braces her hands on the door.',
    });

    expect(() =>
      parseImagePlan(
        JSON.stringify({
          images: [
            {
              position: 'P77',
              tag: '1girl, full body',
              nl: '',
              characters: [{ name: '温岚', tag: 'standing', nl: '' }],
              size: 'portrait',
            },
          ],
        }),
        segments,
        0,
        2,
      ),
    ).toThrow(/不在目标正文可选位置/);
  });
});

describe('角色级 uc 的全链路透传', () => {
  it('serialize → parse 往返保留 uc,空 uc 不写进 JSON', () => {
    const raw = serializeImageTag({
      tag: '1girl, upper body',
      nl: 'She looks up.',
      negative: '',
      characters: [
        { name: '温岚', tag: 'parted lips', nl: '', uc: 'bra, underwear' },
        { name: '顾遥', tag: 'smile', nl: '' },
      ],
      size: 'portrait',
    });
    const parsed = parseImageTagContent(raw);
    expect(parsed.characters[0].uc).toBe('bra, underwear');
    expect(parsed.characters[1].uc).toBeUndefined();
  });

  it('buildNaiParameters 把 uc 写进对应角色的 char_caption 负面', () => {
    const values: NaiGenerateValues = {
      prompt: '1girl, upper body',
      characters: [
        { name: '温岚', tag: '1girl, parted lips', nl: '', uc: 'bra, underwear' },
        { name: '顾遥', tag: '1girl, smile', nl: '' },
      ],
    };
    const params = buildNaiParameters(nai(), values) as Record<string, any>;
    const captions = params.v4_negative_prompt.caption.char_captions;
    expect(captions[0].char_caption).toBe('bra, underwear');
    expect(captions[1].char_caption).toBe('');
  });
});
describe('导演输出 JSON 的容错(不改判据,只换容器)', () => {
  it('shots 键名也能读成图片数组', () => {
    const plan = parseImagePlan(
      '{"shots":[{"position":"P2","tag":"bedroom, full body","nl":"She stands.","characters":[{"name":"温岚","outfit":"white shirt","tag":"blush","nl":"她站着。"}]}]}',
      segments,
      1,
      3,
    );
    expect(plan.images).toHaveLength(1);
    expect(plan.images[0].position).toBe('P2');
    expect(plan.images[0].characters[0].outfit).toBe('white shirt');
  });

  it('只给单张图对象时包成一张,不再整份丢弃', () => {
    const plan = parseImagePlan(
      '{"position":"P1","tag":"bedroom, upper body","nl":"She sits."}',
      segments,
      1,
      3,
    );
    expect(plan.images).toHaveLength(1);
    expect(plan.images[0].tag).toBe('bedroom, upper body');
  });

  it('前面多一层空对象仍能找到 images', () => {
    const plan = parseImagePlan(
      '{"meta":{"model":"x"},"images":[{"position":"P1","tag":"bedroom, upper body","nl":"She sits."}]}',
      segments,
      1,
      3,
    );
    expect(plan.images).toHaveLength(1);
  });

  it('真的没有图片数组才抛错,让上层的重试去救', () => {
    expect(() => parseImagePlan('{"foo":1}', segments, 1, 3)).toThrow(/缺少 images/);
    expect(() => parseImagePlan('不是 JSON', segments, 1, 3)).toThrow();
  });
});
