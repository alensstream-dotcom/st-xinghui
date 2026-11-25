import { describe, expect, it } from 'vitest';
import { assembleImageCharacters, compileWardrobeForFrame } from './assemblePrompt';
import { captureFrame, readFloorContinuity } from './frameContinuity';
import { parseUnifiedPlan } from './protocol';
import { compileWardrobeSequence } from './wardrobeSequence';
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
        { name: '甲', position: 'P2', step: 1, mode: 'patch', slots: { top: { status: 'half_top', tag: 'red dress', halfTag: 'open collar', reveal: 'layer' } } },
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

describe('从正文到跨楼服装记录', () => {
  const start: CharacterWardrobe = {
    name: '甲', outer: { tag: 'beige trench coat', status: 'on' }, top: { tag: 'white shirt', status: 'on' },
    innerTop: { tag: 'navy camisole', status: 'on' }, shoes: { tag: 'brown boots', status: 'on' },
  };
  const replayStory = (story: string, raw: object) => {
    const segments = prepareTargetText(story, []).segments;
    const plan = parseUnifiedPlan(JSON.stringify(raw), segments, 0, 8);
    return compileWardrobeSequence(new Map([['甲', start]]), plan.wardrobeUpdates, plan.images, (shot, state) => ({
      image: assembleImageCharacters(shot, [], state),
      snapshot: captureFrame(shot, [], state),
    }), { segments, timeJump: plan.timeJump, knownNames: plan.changes.map(c => c.name) });
  };
  const slot = (name: string, position: string, mode: string, slots: object) => ({ name, position, mode, slots });

  it('挡下移步换装、想象脱衣和认错角色，只回放后面的实际变化', () => {
    const result = replayStory('甲回到客厅。\n甲想脱下外套，暂时没动。\n乙脱下了外套。\n甲脱下外套。\n甲换上灰色衬衫。', {
      images: [image('P5'), image('P2'), image('P1'), image('P3'), image('P4')],
      wardrobeUpdates: [
        slot('甲', 'P1', 'replace', { top: { tag: 'red dress', status: 'on' } }),
        slot('甲', 'P2', 'patch', { outer: { status: 'off' } }),
        slot('甲', 'P3', 'patch', { outer: { status: 'off' } }),
        slot('甲', 'P4', 'patch', { outer: { status: 'off' }, top: { status: 'off' } }),
        slot('甲', 'P5', 'replace', { top: { tag: 'grey shirt', status: 'on' }, innerTop: { tag: 'red bra', status: 'on' } }),
      ],
      changes: [{ name: '乙', field: 'new', position: 'P3', fields: { hair: 'black hair' } }],
    });
    expect(result.frames.map(f => f.image.position)).toEqual(['P5', 'P2', 'P1', 'P3', 'P4']);
    expect(result.updates.map(u => u.position)).toEqual(['P4', 'P5']);
    expect(result.frames[0].snapshot.wardrobes[0]).toMatchObject({
      outer: { status: 'off' }, top: { tag: 'grey shirt', status: 'on' },
      shoes: start.shoes, innerTop: start.innerTop,
    });
    for (const frame of result.frames.slice(1, 4)) {
      expect(frame.snapshot.wardrobes[0]).toEqual(start);
    }
    expect(result.frames[4].image.characters[0].tag).toContain('white shirt');
  });

  it('卷袖和解一粒扣子不透出下一层，明写露出才显示，末图之后扣回继承到下一楼', () => {
    const result = replayStory('甲解开风衣。\n甲卷起衬衫袖口并松开衬衫第一颗扣子。\n甲把衬衫下摆提到胸上，露出贴身背心。\n甲把衬衫放下，重新扣好。', {
      images: [image('P1'), image('P2'), image('P3')],
      wardrobeUpdates: [
        slot('甲', 'P1', 'patch', { outer: { status: 'half', halfTag: 'open front', reveal: 'layer' } }),
        slot('甲', 'P2', 'patch', { top: { status: 'half', halfTag: 'rolled sleeves, collar ajar', reveal: 'none' } }),
        slot('甲', 'P3', 'patch', { top: { status: 'half', halfTag: 'shirt lifted above chest', reveal: 'layer' } }),
        slot('甲', 'P4', 'patch', { top: { status: 'on' } }),
      ],
    });
    expect(result.frames.map(f => f.image.characters[0].tag.includes('navy camisole'))).toEqual([false, false, true]);
    expect(result.frames[1].image.characters[0].tag).toContain('rolled sleeves');
    const log = [{ name: '甲', mode: 'replace' as const, slots: { ...start } }, ...result.updates];
    const chat = [{ mes: '', name: 'AI', is_system: false, is_user: false, extra: { bbiOutfitOps: makeWardrobeFloorDelta(log, 0) } }];
    expect(deriveWardrobes(chat).get('甲')).toMatchObject({ top: { tag: 'white shirt', status: 'on' }, outer: { status: 'half' } });
    expect(compileWardrobeForFrame(deriveWardrobes(chat).get('甲')).positive.join(', ')).not.toContain('navy camisole');
  });

  it('时间跳转只从明确的下一天位置起，明确穿昨日那套时仍继承', () => {
    const event = (position: string) => slot('甲', position, 'replace', { top: { tag: 'olive dress', status: 'on' } });
    const raw = { images: [image('P1'), image('P3')], timeJump: 'new_day', wardrobeUpdates: [event('P1'), event('P3')] };
    const a = replayStory('甲离开客厅。\n次日清晨。\n甲在庭院走来。', raw);
    expect(a.updates.map(u => u.position)).toEqual(['P3']);
    expect(a.frames[0].snapshot.wardrobes[0]).toEqual(start);
    expect(a.frames[1].snapshot.wardrobes[0].top?.tag).toBe('olive dress');
    const b = replayStory('甲离开客厅。\n次日清晨。\n甲依旧穿着昨日的那件衣服。', raw);
    expect(b.updates).toHaveLength(0);
  });

  it('补录导演遗漏的点名脱外套，并按旧楼层实际存放位置回放', () => {
    const state: CharacterWardrobe = { name: '甲', top: { tag: 'beige trench coat', status: 'on' } };
    const segments = prepareTargetText('甲脱下外套。\n甲端起杯子。\n甲穿回外套。', []).segments;
    const plan = parseUnifiedPlan(JSON.stringify({ images: [image('P2')] }), segments, 0, 2);
    const result = compileWardrobeSequence(new Map([['甲', state]]), plan.wardrobeUpdates, plan.images,
      (_shot, wardrobe) => wardrobe.get('甲')?.top, { segments, timeJump: 'same_day' });
    expect(result.frames[0]).toMatchObject({ tag: 'beige trench coat', status: 'off' });
    expect(deriveWardrobes([{ mes: '', is_user: false, is_system: false, name: 'AI', extra: { bbiOutfitOps: makeWardrobeFloorDelta(result.updates, 0) } }])
      .get('甲')?.top).toMatchObject({ tag: 'beige trench coat', status: 'on' });
  });

  it('持续损坏与穿法分开，放下领口保留损坏，修好才清除', () => {
    const raw = { images: [image('P1'), image('P2'), image('P3')], wardrobeUpdates: [
      slot('甲', 'P1', 'patch', { top: { status: 'on', condition: 'torn sleeve' } }),
      slot('甲', 'P2', 'patch', { top: { status: 'half_top', halfTag: 'collar ajar', reveal: 'none' } }),
      slot('甲', 'P3', 'patch', { top: { status: 'half_top', condition: '' } }),
    ] };
    const result = replayStory('甲扯破了衬衫。\n甲解开衬衫领口。\n甲缝好了衬衫。', raw);
    expect(result.frames.map(f => f.snapshot.wardrobes[0].top?.condition)).toEqual(['torn sleeve', 'torn sleeve', '']);
    expect(result.frames[2].snapshot.wardrobes[0].top).toMatchObject({ halfTag: 'collar ajar', reveal: 'none' });
  });
});
