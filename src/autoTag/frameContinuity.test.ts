import { describe, expect, it } from 'vitest';
import { assembleImageCharacters, compileWardrobeForFrame } from './assemblePrompt';
import { captureFrame, readFloorContinuity } from './frameContinuity';
import { parseUnifiedPlan } from './protocol';
import { compileWardrobeSequence, completeGarmentColor } from './wardrobeSequence';
import { deriveWardrobes, makeWardrobeFloorDelta, type CharacterWardrobe } from '@/state/outfitState';
import { prepareTargetText } from './clean';
import { unifiedSystemPrompt } from './prompt';
import { defaultWorldAnchor } from '@/state/worldAnchor';

const segments = prepareTargetText('甲来访。\n她解开领口再扣好。\n她出门。', []).segments;
const before = new Map<string, CharacterWardrobe>([['甲', {
  name: '甲', top: { tag: 'blue dress', status: 'on' },
  innerTop: { tag: 'white camisole', status: 'on' }, innerBottom: { tag: 'black shorts', status: 'on' },
}]]);
const image = (position: string, step = 0) => ({
  position, step, tag: '1girl, full body', characters: [{ name: '甲', tag: 'looking down' }],
});
function replay(raw: object) {
  const plan = parseUnifiedPlan(JSON.stringify(raw), segments, 0, 8);
  return compileWardrobeSequence(before, plan.wardrobeUpdates, plan.images, (shot, state) => ({
    tag: assembleImageCharacters(shot, [], state).characters[0].tag,
    snapshot: captureFrame(shot, [], state),
  }));
}

describe('0.3.24 剧情连续性', () => {
  it('倒序返回镜头时，名额和原序不变；同 P 两个状态各归其位，状态更新不能重写原衣指纹', () => {
    const result = replay({
      images: [image('P3'), image('P2', 1), image('P1')],
      wardrobeUpdates: [
        { name: '甲', position: 'P2', step: 1, mode: 'patch', slots: { top: { status: 'half_top', tag: 'red dress', halfTag: 'open collar' } } },
        { name: '甲', position: 'P2', step: 2, mode: 'patch', slots: { top: { status: 'on' } } },
      ],
    });
    expect(result.frames.map(frame => frame.tag.includes('white camisole'))).toEqual([false, true, false]);
    expect(result.frames[1].tag).not.toMatch(/black shorts|red dress/);
    expect(result.frames[1].snapshot.wardrobes[0].top?.tag).toBe('blue dress');
    expect(result.updates).toHaveLength(2);
  });

  it('旧 wearState 跨楼落盘，最后一图后的无图事件同样生效', () => {
    const shot = { ...image('P2'), characters: [{ name: '甲', tag: 'smile', wearState: { top: { status: 'off' } } }] };
    for (const restore of [false, true]) {
      const result = replay({ images: [shot], wardrobeUpdates: restore
        ? [{ name: '甲', position: 'P3', mode: 'patch', slots: { top: { status: 'on' } } }] : [] });
      const log = [{ name: '甲', mode: 'replace' as const, slots: { top: before.get('甲')!.top } }, ...result.updates];
      const chat = [{ mes: '', name: 'AI', is_system: false, is_user: false, extra: { bbiOutfitOps: makeWardrobeFloorDelta(log, 0) } }];
      expect(deriveWardrobes(chat).get('甲')?.top?.status).toBe(restore ? 'on' : 'off');
    }
  });

  it('只换一件保留其余槽位，未知内搭和明确未穿分别处理', () => {
    const result = replay({ images: [image('P2')], wardrobeUpdates: [
      { name: '甲', position: 'P2', mode: 'swap', slots: { top: { tag: 'red blouse', status: 'on' } } },
    ] });
    expect(result.frames[0].snapshot.wardrobes[0]).toMatchObject({ top: { tag: 'red blouse' }, innerTop: { tag: 'white camisole' } });
    expect(compileWardrobeForFrame({ name: '甲', top: { tag: 'shirt', status: 'off' } }).positive).not.toContain('bare breasts');
    expect(compileWardrobeForFrame({ name: '甲', innerTop: { tag: '', status: 'off' } }).positive).toContain('bare breasts');
  });

  it('三层叠穿时开外套只露衬衫', () => {
    const state: CharacterWardrobe = { name: '甲', outer: { tag: 'blue jacket', status: 'half', halfTag: 'open front' },
      top: { tag: 'white shirt', status: 'on' }, innerTop: { tag: 'camisole', status: 'on' } };
    expect(compileWardrobeForFrame(state).positive).toEqual(['blue jacket', 'open front', 'white shirt']);
  });

  it('截断外层 JSON 不会误收内部完整图片', () => {
    expect(() => parseUnifiedPlan('{"images":[' + JSON.stringify(image('P2')) + '],"changes":[', segments, 0, 1)).toThrow();
  });

  it('快照只在同一 swipe、正文及前置状态生效', () => {
    const frame = replay({ images: [image('P1')] }).frames[0].snapshot;
    const raw = { swipe: 1, baselineHash: 'base', sourceHash: 'text', frames: [frame] };
    expect(readFloorContinuity(raw, 1, 'text', 'base')).toBe(raw);
    expect(readFloorContinuity(raw, 1, 'edited', 'base')).toBeUndefined();
    expect(readFloorContinuity(raw, 0, 'text', 'base')).toBeUndefined();
    expect(readFloorContinuity(raw, 1, 'text', 'other')).toBeUndefined();
  });

  it('真实导演示例按正确施受方向绑定；NL 开关及不同人的必要重复保留', () => {
    for (const nl of [false, true]) {
      const prompt = unifiedSystemPrompt(defaultWorldAnchor(), nl, 0, 2);
      const example = JSON.parse(prompt.split('\n').find(line => line.startsWith('{"images":'))!);
      const shot = example.images[0];
      expect(shot.characters[0].tag).toContain('target#wrist grab');
      expect(shot.characters[1].tag).toContain('source#wrist grab');
      expect(Boolean(shot.nl)).toBe(nl);
      expect(shot.characters[1].nl).toBe('');
    }
  });
});

describe('同件睡裙跨镜头的主色和断肩带', () => {
  it('只给原件补主色，保留细节，不从黑蕾丝内搭借色或重染', () => {
    expect(completeGarmentColor('nightgown, spaghetti straps', 'ivory nightgown')).toBe('ivory nightgown, spaghetti straps');
    for (const prior of ['white nightgown', 'nightgown, white', 'cobalt nightgown']) {
      expect(completeGarmentColor(prior, 'black ' + prior)).toBe(prior);
    }
    expect(completeGarmentColor('nightgown', 'black lace panties')).toBe('nightgown');
    expect(completeGarmentColor('nightgown', 'nightgown, black lace panties')).toBe('nightgown');
  });

  it('断肩带随衣物跨镜头和楼层；滑肩、掀裙、脱下、修复独立生效', () => {
    const initial = { name: '甲', mode: 'replace', slots: {
      top: { tag: 'nightgown, spaghetti straps', status: 'on' },
      innerBottom: { tag: 'black lace panties', status: 'on' },
    } };
    const changes = [
      { status: 'half_top', tag: 'ivory nightgown', halfTag: 'broken strap, slipping down' },
      { status: 'half_bottom', halfTag: 'skirt lift' }, { status: 'off' }, { status: 'on' },
      { status: 'on', condition: '' },
    ];
    const result = replay({ images: changes.map((_, i) => image('P2', i + 1)), wardrobeUpdates: [
      initial, ...changes.map((top, i) => ({ name: '甲', mode: 'patch', position: 'P2', step: i + 1, slots: { top } })),
    ] });
    const tags = result.frames.map(frame => frame.tag);
    expect(tags[0]).toMatch(/ivory nightgown.*broken strap.*slipping down/);
    expect(tags[1]).toMatch(/ivory nightgown.*broken strap.*skirt lift.*black lace panties/);
    expect(tags[1]).not.toContain('slipping down');
    expect(tags[2]).not.toMatch(/nightgown|broken strap/);
    expect(tags[3]).toContain('broken strap');
    expect(tags[4]).not.toContain('broken strap');
    const chat = [{ mes: '', name: 'AI', is_user: false, is_system: false,
      extra: { bbiOutfitOps: makeWardrobeFloorDelta(result.updates.slice(0, -1), 0) } }];
    expect(deriveWardrobes(chat).get('甲')?.top).toMatchObject({ tag: 'ivory nightgown, spaghetti straps', condition: 'broken strap', status: 'on' });
  });
});

it('同日无定位的外观复述保留已知槽；同日 P1 真换装、跨日新装均正常替换', () => {
  for (const [day, position, keep] of [
    ['same_day', undefined, true], ['same_day', 'P1', false], ['new_day', undefined, false],
  ] as const) {
    const plan = parseUnifiedPlan(JSON.stringify({ images: [{ ...image('P2'), extent: 'whole' }], timeJump: day,
      wardrobeUpdates: [{ name: '甲', mode: 'replace', position, slots: { top: { tag: 'black sweater', status: 'on' } } }],
    }), segments, 0, 1);
    const result = compileWardrobeSequence(before, plan.wardrobeUpdates, plan.images, (shot, state) => {
      expect(shot.extent).toBe('whole');
      return state.get('甲')!;
    }, plan.timeJump);
    expect(result.frames[0].top?.tag).toBe(keep ? 'blue dress' : 'black sweater');
    expect(Boolean(result.frames[0].innerBottom)).toBe(keep);
    expect(result.updates).toHaveLength(keep ? 0 : 1);
  }
});

it('跨人擦拭按原名绑定持物者与嘴角，不依赖角色排列；错配的名字不污染其他人的动作', () => {
  const characters = [{ name: '青年', tag: '1boy, faceless male, source#wiping mouth' },
    { name: '贵妇', tag: 'wiping mouth, target#wiping mouth, sitting' }, { name: '旁人', tag: 'watching' }];
  const contact = ['贵妇', '青年', 'pressing the handkerchief to his mouth', 'his cheek turned toward the cloth'];
  const run = (link: string[]) => parseUnifiedPlan(JSON.stringify({ images: [{ ...image('P1'), characters, contact: link }] }), segments, 0, 1).images[0];
  const result = assembleImageCharacters(run(contact), []).characters;
  expect(result[0].tag).toBe('1boy, target#wiping mouth, his cheek turned toward the cloth');
  expect(result[1].tag.split(', ')).toEqual(['source#wiping mouth', 'sitting', 'pressing the handkerchief to his mouth']);
  expect(result[2].tag).toBe('watching');
  expect(run(['错名', ...contact.slice(1)]).characters.map(c => c.tag)).toEqual(characters.map(c => c.tag));
});
