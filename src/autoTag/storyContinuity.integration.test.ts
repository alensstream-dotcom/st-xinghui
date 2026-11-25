import { describe, expect, it } from 'vitest';

import { entriesAtPosition } from './charAnchors';
import { assembleImageCharacters } from './assemblePrompt';
import { prepareTargetText } from './clean';
import { captureFrame } from './frameContinuity';
import { injectImageTags, parseUnifiedPlan, type ImageInsertion } from './protocol';
import { compactGeneratedScene } from './sceneCompaction';
import { slotStoryPosition } from './slotPlan';
import { momentPromptText } from './storyMoment';
import { retainUnchangedTraits } from './visualIdentity';
import { compileWardrobeSequence } from './wardrobeSequence';
import { createCharTagSetOp, emptyCharFields, type CharTagEntry } from '@/state/charTags';
import { deriveWardrobes, makeWardrobeFloorDelta, type CharacterWardrobe } from '@/state/outfitState';
import { parseImageTagContent, parseImageTags } from '@/st/imageTagRegex';
import { WORLD_PRESETS } from '@/state/worldAnchor';

const name = '林婉';
const startsIn: CharacterWardrobe = {
  name,
  outer: { tag: 'beige trench coat', status: 'on' },
  top: { tag: 'white shirt', status: 'on' },
  innerTop: { tag: 'navy camisole', status: 'on' },
  bottom: { tag: 'black trousers', status: 'on' },
  legs: { tag: 'white socks', status: 'on' },
  shoes: { tag: 'brown boots', status: 'on' },
};
const profile = (person: string, fields: Partial<CharTagEntry['fields']>): CharTagEntry => ({
  name: person, raw: '', nl: '', desc: '', history: [], source: 'ai', fields: { ...emptyCharFields(), sex: '1girl', ...fields },
});

const frame = (position: string, clause?: number, extra: Partial<ImageInsertion> = {}) => ({
  position, clause, tag: '1girl, full body', characters: [{ name, tag: 'standing', nl: '' }], ...extra,
});
const event = (position: string, clause: number, slots: object, mode = 'patch', observed = false, owner = name) =>
  ({ name: owner, position, clause, mode, slots, observed });

function replay(text: string, images: object[], wardrobeUpdates: object[], timeJump = 'same_day') {
  const segments = prepareTargetText(text, []).segments;
  const input = { images, wardrobeUpdates, timeJump };
  const plan = parseUnifiedPlan(JSON.stringify(input), segments, 0, 8, { selectBeats: true, femaleScenesOnly: true });
  const before = new Map([[name, startsIn]]);
  return compileWardrobeSequence(before, plan.wardrobeUpdates, plan.images,
    (shot, state) => ({
      snapshot: captureFrame(shot, [], state),
      shot: assembleImageCharacters(shot, [], state),
    }), { segments, timeJump: plan.timeJump, knownNames: ['许悦'] });
}

describe('正文时点与服装的验收用例', () => {
  it('在同一 P 定格前、中、后，并保留最后一个无图事件供下一楼回放', () => {
    const text = '林婉回家，林婉敞开外套，林婉卷起衬衫袖口，林婉脱下外套，林婉穿回外套。';
    expect(momentPromptText(prepareTargetText(text, []).segments)).toContain('⟦4⟧林婉脱下外套');
    const result = replay(text, [frame('P1', 1, { characters: [{ name, tag: 'standing, nude, bare breasts', nl: '' }] }), frame('P1', 2), frame('P1', 3), frame('P1', 4)], [
      event('P1', 2, { outer: { status: 'half', halfTag: 'open front', reveal: 'layer' } }),
      event('P1', 3, { top: { status: 'half_top', halfTag: 'rolled sleeves', reveal: 'none' } }),
      event('P1', 4, { outer: { status: 'off' } }),
      event('P1', 5, { outer: { status: 'on' } }),
    ]);
    expect(result.frames.map(f => f.snapshot.wardrobes[0].outer?.status)).toEqual(['on', 'half', 'half', 'off']);
    expect(result.frames[0].shot.characters[0].tag).not.toMatch(/white shirt|nude|bare breasts/);
    expect(result.frames[1].shot.characters[0].tag).toContain('white shirt');
    expect(result.frames.every(f => !f.shot.characters[0].tag.includes('navy camisole'))).toBe(true);
    const delta = makeWardrobeFloorDelta([{ name, mode: 'replace', slots: startsIn }, ...result.updates], 0);
    const chat = [{ mes: text, name: 'story', is_system: false, is_user: false, extra: { bbiOutfitOps: delta } }];
    expect(deriveWardrobes(chat).get(name)?.outer).toMatchObject({ status: 'on', tag: 'beige trench coat' });
  });

  it('台词、他人衣物和只看见对方不会改本人；直接观察到的那件可以更新', () => {
    const text = '林婉说：“我要脱下风衣。”\n林婉看着许悦脱下风衣。\n林婉穿着绿色衬衫。';
    const result = replay(text, [frame('P1'), frame('P2'), frame('P3')], [
      event('P1', 1, { outer: { status: 'off' } }),
      event('P2', 1, { outer: { status: 'off' } }),
      event('P3', 1, { top: { tag: 'green shirt', status: 'on' }, shoes: { tag: 'green sandals', status: 'on' } }, 'swap', true),
    ]);
    expect(result.frames.map(f => f.snapshot.wardrobes[0].outer?.status)).toEqual(['on', 'on', 'on']);
    expect(result.updates).toHaveLength(1);
    expect(result.frames[2].snapshot.wardrobes[0]).toMatchObject({ top: { tag: 'green shirt' }, shoes: startsIn.shoes });
  });

  it('明确隔天只初始化一次，不能在当天第二张亮相再抽一套', () => {
    const text = '林婉回到家。\n第二天，林婉走进院子。\n林婉坐在院子里。';
    const result = replay(text, [frame('P1'), frame('P2', 2), frame('P3')], [
      event('P2', 2, { top: { tag: 'green silk robe', status: 'on' } }, 'replace'),
      event('P3', 1, { top: { tag: 'red dress', status: 'on' } }, 'replace'),
    ], 'new_day');
    expect(result.frames.map(f => f.snapshot.wardrobes[0].top?.tag)).toEqual(['white shirt', 'green silk robe', 'green silk robe']);
  });

  it('出场各部位仍然一起穿着，单只鞋离脚不会把袜子和另一只鞋去掉', () => {
    const result = replay('林婉脱下左脚那只靴子，林婉穿回靴子。', [frame('P1', 1), frame('P1', 2)], [
      event('P1', 1, { shoes: { status: 'half', offSide: 'right' } }),
      event('P1', 2, { shoes: { status: 'on' } }),
    ]);
    const [first, last] = result.frames.map(f => f.shot.characters[0].tag);
    expect(first).toMatch(/white socks.*brown boot on right foot.*left foot without a shoe/);
    expect(last).toMatch(/white socks.*brown boots/);
    expect(last).not.toMatch(/left foot without/);
  });

  it('旧楼层没有快照时同段重写定位到原插入位置，即使前面已有多个 tag', () => {
    const body = '林婉倒茶。\r\n\r\n林婉换上外套。\r\n林婉出门。';
    const prepared = prepareTargetText(body, []);
    const plan = parseUnifiedPlan(JSON.stringify({ images: [frame('P1'), frame('P1'), frame('P2')] }), prepared.segments, 0, 3);
    const tagged = injectImageTags(body, plan.images);
    expect(parseImageTags(tagged)).toHaveLength(3);
    expect(slotStoryPosition(tagged, 2, prepared.segments)?.id).toBe('P2');
    expect(slotStoryPosition(tagged, 1, prepared.segments)?.id).toBe('P1');
  });

  it('古风原件按档案，原文明确的现代配件只出现在拥有者的块中', () => {
    const wardrobe = new Map<string, CharacterWardrobe>([
      [name, { name, top: { tag: 'blue silk hanfu', status: 'on' } }],
      ['许悦', { name: '许悦', top: { tag: 'silk jacket', status: 'on' }, bottom: { tag: 'black jeans', status: 'on' } }],
    ]);
    const segments = prepareTargetText('两人在回廊相见。', []).segments;
    const plan = parseUnifiedPlan(JSON.stringify({ images: [frame('P1', 1, { tag: '2girls, full body, palace corridor',
      characters: [{ name, tag: 'holding fan', nl: '' }, { name: '许悦', tag: 'looking down', nl: '' }] })] }), segments, 0, 2);
    const output = assembleImageCharacters(plan.images[0], [], wardrobe, { ...WORLD_PRESETS.chinese_ancient, lockedByUser: true });
    expect(output.characters[0].tag).toContain('blue silk hanfu');
    expect(output.characters[0].tag).not.toContain('jeans');
    expect(output.characters[1].tag).toContain('black jeans');
    expect(output.characters[1].uc).not.toMatch(/\bjeans\b/);
  });
});

describe('选段、人物和角色提示词的验收用例', () => {
  it('同一事件优先切到接触成立，下一名额留给另一个事件，再按正文顺序插回', () => {
    const text = '她伸手。\n她握住递来的杯子。\n她放下杯子。\n她在花园接到书信。';
    const segments = prepareTargetText(text, []).segments;
    const raw = [
      { ...frame('P1'), beat: ['cup', 'A', 'lead-in'] },
      { ...frame('P3'), beat: ['cup', 'A', 'aftermath'] },
      { ...frame('P4'), beat: ['letter', 'S', 'peak'] },
      { ...frame('P2'), beat: ['cup', 'A', 'peak'] },
    ];
    const plan = parseUnifiedPlan(JSON.stringify({ images: raw }), segments, 0, 2, { selectBeats: true, femaleScenesOnly: true });
    expect(plan.images.map(shot => shot.position)).toEqual(['P4', 'P2']);
    const tagged = injectImageTags(text, plan.images.map(shot => ({ ...shot, nl: shot.position })));
    expect(parseImageTags(tagged).map(tag => parseImageTagContent(tag).nl)).toEqual(['P2', 'P4']);
  });

  it('发型变化没证据换发色，光线没证据换肤色/瞳色，体态调整保留原来的胸型与年龄', () => {
    const segments = prepareTargetText('林婉剪短头发。\n蓝光照亮她的脸。\n她挺直腰背。', []).segments;
    const entries = [profile(name, { hair: 'long black hair', eyes: 'amber eyes, tareme', skin: 'fair skin', body: 'adult, flat chest' })];
    const plan = parseUnifiedPlan(JSON.stringify({ images: [], changes: [
      { name, field: 'hair', value: 'short blue hair', position: 'P1' },
      { name, field: 'eyes', value: 'blue eyes', position: 'P2' },
      { name, field: 'skin', value: 'tan', position: 'P2' },
      { name, field: 'body', value: 'teenager, large breasts, toned', position: 'P3' },
    ] }), segments, 0, 2);
    retainUnchangedTraits(plan.changes, entries, new Map(segments.map(s => [s.id, s.text])));
    expect(plan.changes.map(change => change.value)).toEqual(['black hair, short hair', 'amber eyes, tareme', 'fair skin', 'toned, adult, flat chest']);
  });

  it('闭合两组同时的动作、保留开放英文，去除自己的负面冲突和重复画面', () => {
    const segments = prepareTargetText('林婉用帕子擦许悦的嘴角，许悦牵着任雪的手。', []).segments;
    const shot = { position: 'P1', tag: '3girls, from side, front view, medium shot, full body, split screen',
      nl: 'The first woman wipes the second woman’s mouth.',
      contact: [[name, '许悦', 'pressing a cloth to the corner of her mouth', 'the cloth touching the corner of her mouth', 'wipe mouth'],
        ['许悦', '任雪', 'holding Ren’s hand', 'her hand held by the other woman', 'holding hands']],
      characters: [
        { name, tag: 'wipe mouth, target#wipe mouth', nl: 'The first woman wipes the second woman’s mouth. Her elbow rests on the table.', uc: '[flat_chest], black hair' },
        { name: '许悦', tag: 'smile' },
        { name: '任雪', tag: 'standing' },
      ],
    };
    const plan = parseUnifiedPlan(JSON.stringify({ images: [shot] }), segments, 0, 3);
    const entries = [profile(name, { body: 'adult, flat chest', hair: 'long black hair' }),
      profile('许悦', { hair: 'brown hair, bun' }), profile('任雪', { hair: 'silver hair, ponytail' })];
    const result = compactGeneratedScene(assembleImageCharacters(plan.images[0], entries));
    expect(result.tag).toBe('3girls, from side, medium shot');
    expect(result.characters[0].tag).toMatch(/source#wipe mouth.*pressing a cloth/);
    expect(result.characters[0].tag).not.toMatch(/target#wipe mouth/);
    expect(result.characters[0].nl).toBe('Her elbow rests on the table.');
    expect(result.characters[0].uc).not.toMatch(/flat_chest|black hair/);
    expect(result.characters[1].tag).toMatch(/target#wipe mouth.*source#holding hands/);
    expect(result.characters[2].tag).toContain('target#holding hands');
  });

  it('长画师串已占用 V4 预算时只压可选词，每一位保留身份、衣物和实际动作', () => {
    const image = { ...frame('P1'), sourceLine: 0, size: 'landscape' as const, negative: '', nl: '',
      tag: '3girls, wide shot, best quality, intricate details, palace', characters: ['black', 'red', 'silver'].map(hue => ({
        name: hue, tag: `girl, ${hue} hair, ${hue} shirt, holding fan, long eyelashes`, nl: '',
      })) };
    const result = compactGeneratedScene(image, { fixed: 'artist:mine, best quality, ' + 'style '.repeat(360), sharedReference: 512 });
    expect(result.tag).toBe('3girls, wide shot, palace');
    expect(result.characters.map(c => c.tag)).toEqual(['black', 'red', 'silver'].map(hue => `girl, ${hue} hair, ${hue} shirt, holding fan`));
    expect(image.tag).toContain('best quality');
  });
});

it('中国古风未描写服装时修正现代默认衣物，直接写明现代衣服时保留其反差', () => {
  function firstOutfit(text: string) {
    const segments = prepareTargetText(text, []).segments;
    const plan = parseUnifiedPlan(JSON.stringify({ images: [frame('P1')], wardrobeUpdates: [
      event('P1', 1, { top: { tag: 'white t-shirt', status: 'on' }, bottom: { tag: 'black jeans', status: 'on' } }, 'replace'),
    ] }), segments, 0, 2);
    return compileWardrobeSequence(new Map(), plan.wardrobeUpdates, plan.images,
      (shot, state) => assembleImageCharacters(shot, [], state), { segments, timeJump: 'same_day', world: 'chinese_ancient' }).frames[0];
  }
  expect(firstOutfit('她走入古寺。').characters[0].tag).toContain('white cross-collar chinese top');
  expect(firstOutfit('她穿着白色T恤和黑色牛仔裤走入古寺。').characters[0].tag).toContain('white t-shirt, black jeans');
});

it('同一人先后脱左右靴，再穿回一只，左右鞋履状态独立且袜子一直在', () => {
  const text = '林婉脱下左脚那只靴子，林婉脱下右脚那只靴子，林婉穿上右脚那只靴子。';
  const result = replay(text, [frame('P1', 1), frame('P1', 2), frame('P1', 3)], [
    event('P1', 1, { shoes: { status: 'off' } }),
    event('P1', 2, { shoes: { status: 'off' } }),
    event('P1', 3, { shoes: { status: 'on' } }),
  ]);
  expect(result.frames.map(f => f.snapshot.wardrobes[0].shoes?.status)).toEqual(['half', 'off', 'half']);
  expect(result.frames[2].shot.characters[0].tag).toMatch(/white socks.*brown boot on right foot.*left foot without a shoe/);
});

it('脚踝特写只投影可见服饰，仍保留持物或触点相关的动作', () => {
  const [shot] = replay('她扶正了一只靴子。', [frame('P1', 1, {
    tag: '1girl, close-up, ankle focus, wide shot', extent: 'detail',
    characters: [{ name, tag: 'adjusting her boot by hand', nl: '' }],
  })], []).frames.map(f => f.shot);
  expect(shot.tag).toBe('1girl, close-up, ankle focus');
  expect(shot.characters[0].tag).toMatch(/white socks.*brown boots.*adjusting her boot by hand/);
  expect(shot.characters[0].tag).not.toMatch(/trench coat|trousers/);
});

it('同段永久染发的前后两格分别读旧档和新档，角色本人及其余特征不变', () => {
  const entries = [profile(name, { hair: 'black hair', eyes: 'amber eyes' })];
  const op = createCharTagSetOp(name, 'hair', 'brown hair', '染发');
  if (!op) throw new Error('测试的染发事件无效');
  const changes = [{ op, sourceLine: 0, clause: 2 }];
  expect(entriesAtPosition(entries, changes, 0, undefined, 1)[0].fields).toMatchObject({ hair: 'black hair', eyes: 'amber eyes' });
  expect(entriesAtPosition(entries, changes, 0, undefined, 2)[0].fields).toMatchObject({ hair: 'brown hair', eyes: 'amber eyes' });
});

describe('用户反馈的五组样本', () => {
  const heroine = '邱晓晓';
  const viewer = '秦开宇';
  const scores = { femaleScenesOnly: true, selectBeats: true };
  function planned(text: string, images: object[], min = 0) {
    const segments = prepareTargetText(text, []).segments;
    return parseUnifiedPlan(JSON.stringify({ images }), segments, min, 8, scores).images;
  }

  it('抱手臂换对象、机位和事件编号仍是同一姿势，只留动作变化后确有泪花的定格', () => {
    const text = '邱晓晓挽住高嘉豪的胳膊，皱起眉头。\n邱晓晓抱住秦开宇的胳膊，挤出笑容。\n她仍抱着他的胳膊，眼角沁出晶莹的泪花。';
    const image = (position: string, name: string, beat: string[], tag = 'three-quarter view') => ({
      position, beat, tag: '1girl, 1boy, medium close-up, school hallway, ' + tag,
      nl: 'The woman hugs the man’s arm while tears well up in her eyes.',
      characters: [{ name: heroine, tag: 'girl, standing, tears, source#arm hug, hugging his arm',
        nl: 'She keeps a forced smile while tears well up in her eyes.' }, { name, tag: '1boy, standing' }],
    });
    const first = image('P1', '高嘉豪', ['first-hold', 'A', 'peak']);
    const early = image('P2', viewer, ['second-hold', 'S', 'peak'], 'from side');
    const late = image('P3', viewer, ['later-hold', 'A', 'peak']);
    const [before] = planned(text, [early]);
    expect(JSON.stringify(before)).not.toMatch(/\btears\b/);
    const [after] = planned(text, [late]);
    expect(after.characters[0].tag).toContain('tears');
    const selected = planned(text, [first, early, late], 2);
    expect(selected).toHaveLength(1);
    const inserted = injectImageTags(text, selected);
    if (selected[0].position === 'P3') expect(inserted.indexOf('<bbi_image>')).toBeGreaterThan(inserted.indexOf('泪花'));
    else expect(inserted).not.toMatch(/\btears\b/);
  });

  it('一个 P 中用原文短语定位，后半句的表情不会灌进前半句', () => {
    const [shot] = planned('她举起手中的信，邱晓晓眼角沁出泪花。', [{
      position: 'P1', tag: '1girl, medium shot, indoors',
      focus: [heroine, '举起手中的信', 'raising a letter in one hand', 'hands'],
      characters: [{ name: heroine, tag: 'girl, tears, holding letter', nl: 'She holds the letter while tears well up.' }],
    }]);
    expect(shot.clause).toBe(1);
    expect(shot.tag).toContain('hands visible');
    expect(shot.characters[0].tag).toContain('raising a letter in one hand');
    expect(shot.characters[0].tag).not.toContain('tears');
    expect(shot.characters[0].nl).not.toContain('tears');
  });

  it('客厅双女角反应保留两名角色，果盘在茶几上，男性由视点表达', () => {
    const text = '谢冬萱眼睛红红的，坐在沙发边。\n陈素云将果盘放在茶几上。\n谢冬萱从沙发上站起来，指向秦开宇。';
    const images = [{
      position: 'P3', tag: '2girls, 1boy, from side, wide shot, living room, coffee table',
      nl: 'The younger woman stands up from the sofa pointing angrily at the man while the older woman stands by the coffee table with a fruit platter.',
      characters: [
        { name: '谢冬萱', tag: 'girl, tears, standing, pointing, looking at another', nl: 'She glares at the man with tear-filled eyes.' },
        { name: '陈素云', tag: 'girl, standing, holding fruit platter', nl: 'She looks between the two in confusion.' },
        { name: viewer, tag: '1boy, boy, scared, looking down, standing', nl: 'He keeps his head lowered nervously.' },
      ],
    }];
    const [image] = planned(text, images);
    expect(image.tag).toMatch(/2girls.*fruit platter on the coffee table.*pov.*eye-level/);
    expect(image.tag).not.toMatch(/1boy|wide shot/);
    expect(image.nl).toMatch(/pointing angrily at the viewer.*by the coffee table/);
    expect(image.characters.map(c => c.name)).toEqual(['谢冬萱', '陈素云']);
    expect(JSON.stringify(image)).not.toMatch(/tear|holding fruit platter|with a fruit platter/);
  });

  it('亲属称谓在两个角色块里不应覆盖成熟度，剧情确认的成人年龄变化保留原来特征', () => {
    const daughter = profile('谢冬萱', { hair: 'black hair, long hair, hair down, side-swept bangs', body: 'adult, slender' });
    const mother = profile('陈素云', { hair: 'black hair, long hair, low bun, parted bangs', body: 'mature female, curvy', extra: 'wooden hairpin, oval face, arched eyebrows' });
    const [entrance, mirror] = planned('谢冬萱换好鞋，一抬头便看到秦开宇。\n陈素云恢复了二十五岁时的样子。', [
      { position: 'P1', tag: '2girls, 1boy, three-quarter view, medium shot, entryway',
        nl: 'The girl at the entryway looks surprised as she sees the man while her mother stands beside her.',
        characters: [{ name: daughter.name, tag: 'girl, surprised', age: 'child' },
          { name: mother.name, tag: 'girl, worried', nl: 'She stands beside her daughter.' },
          { name: viewer, tag: '1boy, boy, smile, looking at another' }] },
      { position: 'P2', tag: '1girl, medium shot', characters: [{ name: mother.name, tag: 'girl, standing', age: 'young adult',
        omitFeatures: ['oval face', 'arched eyebrows'] }] },
    ]).map(shot => assembleImageCharacters(shot, [daughter, mother]));
    expect(entrance.nl).not.toMatch(/girl|mother|daughter/);
    expect(entrance.characters).toHaveLength(2);
    expect(entrance.characters[0].tag).toContain('adult, slender');
    expect(entrance.characters[1].nl).not.toMatch(/daughter/);
    expect(mirror.characters[0].tag).toMatch(/long hair gathered into a low bun.*oval face.*arched eyebrows.*young adult/);
    expect(mirror.characters[0].tag).not.toContain('mature female');
    expect(mirror.characters[0].tag).toContain('curvy');
  });

  it('二十五岁的形象不能因读到末尾五岁被标成儿童', () => {
    const text = '陈素云恢复了二十五岁时的样子。';
    const [shot] = planned(text, [{ position: 'P1', tag: '1girl, medium shot',
      characters: [{ name: '陈素云', tag: 'girl, standing', age: 'child' }] }]);
    expect(shot.characters[0].frameAge).toBeUndefined();
  });

  it('同场晚补服饰只补缺失衣件，真实换装不能倒灌', () => {
    const raw = (position: string) => ({ position, tag: '1girl, medium shot, indoors', characters: [{ name: heroine, tag: 'girl, sitting' }] });
    const update = {
      position: 'P2', describedSince: 'P1', observed: true, name: heroine, mode: 'swap',
      slots: { top: { tag: 'light blue dress', style: 'woven fabric, round neckline, short sleeves', status: 'on' } },
    };
    function tops(text: string, initial?: object) {
      const segments = prepareTargetText(text, []).segments;
      const plan = parseUnifiedPlan(JSON.stringify({ images: [raw('P1'), raw('P2')], wardrobeUpdates: initial ? [initial, update] : [update] }), segments, 0, 3, scores);
      return compileWardrobeSequence(new Map(), plan.wardrobeUpdates, plan.images,
        (_shot, wardrobe) => wardrobe.get(heroine)?.top, { segments, timeJump: 'same_day' }).frames;
    }
    expect(tops('邱晓晓坐在电影院后排。\n邱晓晓仍穿着那件浅蓝色连衣裙。')[0]).toMatchObject(update.slots.top);
    expect(tops('邱晓晓坐在电影院后排。\n邱晓晓换上浅蓝色连衣裙。')[0]).toBeUndefined();
    expect(tops('邱晓晓坐在电影院后排。\n邱晓晓仍穿着那件浅蓝色连衣裙。', {
      position: 'P1', name: heroine, mode: 'replace', slots: { top: { tag: 'white top', status: 'on' } },
    })[0]).toMatchObject(update.slots.top);
  });
});
