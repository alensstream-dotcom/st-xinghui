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

describe('状态表通道的解析', () => {
  it('读懂 set_outfit 与 update_layer,并记下各自生效的物理行', () => {
    const plan = parseStateSyncPlan(
      JSON.stringify({
        changes: [],
        outfitOps: [
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
    expect(plan.outfitOps).toHaveLength(2);
    expect(plan.outfitOps[0].sourceLine).toBe(0);
    expect(plan.outfitOps[1].sourceLine).toBe(2);
    expect(plan.outfitOps[1].op).toMatchObject({ op: 'update_layer', layer: 'bottom', status: 'removed' });
  });

  it('一条坏 op 只丢自己,不影响同批其它 op', () => {
    const plan = parseStateSyncPlan(
      JSON.stringify({
        outfitOps: [
          { op: 'set_outfit', name: '温岚', position: 'P1', layers: { outer: { tag: 'shirt', status: 'worn' } } },
          { op: 'update_layer', name: '温岚', layer: 'hat', status: 'removed' },
          { op: 'update_layer', name: '', layer: 'bottom', status: 'removed' },
          { op: 'update_layer', name: '温岚', layer: 'bra', status: 'floating' },
        ],
      }),
      segments,
    );
    expect(plan.outfitOps).toHaveLength(1);
    expect(plan.outfitOps[0].op.op).toBe('set_outfit');
  });

  it('位置对不回正文的操作一律丢弃(宁可不写,也不许挪到别的行)', () => {
    const plan = parseStateSyncPlan(
      JSON.stringify({
        outfitOps: [
          { op: 'set_outfit', name: '温岚', position: 'P99', layers: { outer: { tag: 'towel', status: 'worn' } } },
          { op: 'update_layer', name: '温岚', position: 'P99', layer: 'bra', status: 'removed' },
        ],
      }),
      segments,
    );
    expect(plan.outfitOps).toHaveLength(0);
  });

  it('没有任何服装变化时返回空 outfitOps,而不是报错', () => {
    expect(parseStateSyncPlan('{"changes":[],"outfitOps":[]}', segments).outfitOps).toEqual([]);
    expect(parseStateSyncPlan('{"v":1}', segments).outfitOps).toEqual([]);
    expect(parseStateSyncPlan('不是 JSON', segments)).toEqual({ changes: [], outfitOps: [] });
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