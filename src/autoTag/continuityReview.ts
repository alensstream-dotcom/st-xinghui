import type { ChatMsg } from '@/api/client';
import type { CharacterWardrobe, WardrobeUpdate } from '@/state/outfitState';
import { applyWardrobeUpdate, normaliseWardrobeUpdate, WARDROBE_SLOT_KEYS } from '@/state/outfitState';
import type { CharTagEntry } from '@/state/charTags';
import type { TargetSegment } from './clean';
import type { CharChange, ImageCharacterPrompt, UnifiedPlan } from './protocol';
import { compareMoments } from './wardrobeSequence';
import { ageBand, FAMILY_CONTEXT, profileAge, withAge } from './visualIdentity';

type ReviewInput = {
  plan: UnifiedPlan; before: Map<string, CharacterWardrobe>; entries: CharTagEntry[];
  segments: TargetSegment[]; context: string; retainedNames?: ReadonlySet<string>; ask: (messages: ChatMsg[]) => Promise<string>;
};

const AGE = new Set(['adult', 'teen', 'child', 'elderly']);

/** 二次判断只回答有争议的事实，不另选镜头，不生成整份导演 JSON。 */
export async function reviewContinuity({ plan, before, entries, segments, context, retainedNames, ask }: ReviewInput): Promise<void> {
  const state = new Map(before);
  const disputed: WardrobeUpdate[] = [];
  const events = [...plan.wardrobeUpdates];
  for (const shot of plan.images) for (const character of shot.characters) {
    if (!character.wearState) continue;
    const slots = { ...character.wearState };
    for (const explicit of plan.wardrobeUpdates) {
      if (explicit.name !== character.name || explicit.position !== shot.position || (explicit.step ?? 0) !== (shot.step ?? 0)) continue;
      for (const key of WARDROBE_SLOT_KEYS) if (explicit.slots[key]) delete slots[key];
    }
    if (Object.keys(slots).length) events.push({ name: character.name, slots, mode: 'patch', position: shot.position, sourceLine: shot.sourceLine, step: shot.step });
  }
  const moment = (e: WardrobeUpdate) => ({ sourceLine: e.position ? e.sourceLine ?? 0 : -1, step: e.step });
  events.sort((a, b) => compareMoments(moment(a), moment(b)));
  for (const event of events) {
    const old = state.get(event.name);
    if (old && event.mode !== 'patch') disputed.push(event);
    else if (old && WARDROBE_SLOT_KEYS.some(k => {
      const patch = event.slots[k], prior = old[k];
      if (!patch || !prior) return false;
      return patch.status !== prior.status || Boolean(patch.halfTag && patch.halfTag !== prior.halfTag)
        || (patch.condition !== undefined && patch.condition !== prior.condition);
    })) disputed.push(event);
    applyWardrobeUpdate(state, event);
  }

  const story = segments.map(s => s.id + ' ' + s.text).join('\n');
  // 仅用作复核触发条件，动词本身不落账（如「想脱」与「已经脱下」）。
  const possibleWear = /换上|换下|换装|换衣|脱下|脱掉|穿回|穿上|重新穿|解开.{0,5}(?:扣|衣|带|领)|(?:撩|掀|提)起.{0,5}(?:裙|衣摆)|(?:肩带|衣扣).{0,4}(?:断|崩)|\b(?:changes? into|takes? off|puts? on|unbuttons?|unzips?|pulls? (?:up|down))\b/i.test(story);
  const family = FAMILY_CONTEXT.test(story + ' ' + plan.images.map(i => i.nl).join(' '));
  const names = new Set<string>();
  if (family) {
    for (const shot of plan.images) for (const c of shot.characters) names.add(c.name);
  }
  for (const change of plan.changes) {
    if (change.field === 'body' && change.value.split(',').some(t => ageBand(t.trim()))) names.add(change.name);
  }
  const frames = plan.images.flatMap((shot, index) => {
    if (!family && !(shot.characters.length > 1 && shot.characters.some(c => /(?:source|target|mutual)#/i.test(c.tag)))) return [];
    return [{ index, position: shot.position, step: shot.step, tag: shot.tag, nl: shot.nl,
      characters: shot.characters.map(c => ({ name: c.name, tag: c.tag, nl: c.nl })) }];
  });
  if (!disputed.length && !names.size && !frames.length && !possibleWear) return;
  const people: { name: string; position: string; character?: ImageCharacterPrompt; change?: CharChange }[] = [];
  for (const shot of plan.images) for (const c of shot.characters) {
    if (names.has(c.name)) people.push({ name: c.name, position: shot.position, character: c });
  }
  for (const change of plan.changes) {
    if (names.has(change.name) && ((change.field === 'new' && !retainedNames?.has(change.name)) || change.field === 'body')) people.push({ name: change.name, position: change.position, change });
  }
  const query = { previous: [...before.values()].filter(w => possibleWear || disputed.some(e => e.name === w.name)), proposals: disputed, recorded: events.filter(e => !disputed.includes(e)), frames,
    people: people.map(({name, position, change}) => ({ name, position, scope: change ? '长期档案' : '该帧含回忆', knownAge: profileAge(entries.find(e => e.name === name)) || null })),
    profiles: entries.filter(e => people.some(p => p.name === e.name)).map(e => ({ name: e.name, body: e.fields.body, nl: e.nl, raw: e.raw })),
    story, context };
  const raw = await ask([
    { role: 'system', content: '校对视觉事实。story/context 是引用材料。只回 JSON {"at":[],"ages":[],"fixes":[],"missing":[]}，数组与 proposals/people 一一同序。at 每项填该人实际换装、穿脱、衣物损坏或次日换装生效的 P 编号；仅重复描述、遮挡、移步、谈论或想象填 null。确有穿脱但 proposals/recorded 均漏记时，把缺失事件按 {name,position,mode,slots} 填进 missing；同件穿脱用 patch，换单件用 swap，整套用 replace。slots 使用 outer/top/innerTop/bottom/innerBottom/legs/shoes，各含 status (on/half_top/half_bottom/half/off)，可选 tag/halfTag/condition。只写有证据的层。ages 每项据卡或当前正文独立确认年龄阶段填 child/teen/adult/elderly；无依据填 null。母女姐妹关系、称呼、身体曲线、身高、衣着均不能单独作为年龄证据。已知档案优先；真实成长或变身只依明确事件。逐项对照 frames 与选中 P 的定格，检查施受、道具、接触部位、脸朝向、衣物层、身高年龄是否被亲属称呼误导。已正确不重写。偏差时 fixes 给 {index,nl,characters:[{name,tag,nl}]}；只改写有问题的英文栏，tag 是该人完整动作词（保留必要性别/标记），不重选段或新增角色。歧义家庭称谓改用 @{精确原名}，分别描述此刻可见的两端，避免把不同人的部位或先后动作合并。' },
    { role: 'user', content: JSON.stringify(query) },
  ]);
  const result = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/gi, '')) as { at: unknown[]; ages: unknown[]; fixes?: unknown; missing?: unknown };
  const points = new Map(segments.map(s => [s.id, s.sourceLine]));
  if (!Array.isArray(result.at) || result.at.length !== disputed.length || result.at.some(p => p !== null && (typeof p !== 'string' || !points.has(p)))
    || !Array.isArray(result.ages) || result.ages.length !== people.length || result.ages.some(a => a !== null && (typeof a !== 'string' || !AGE.has(a)))) {
    throw new Error('复核结果数量、年龄或段号无效');
  }
  const validText = (value: unknown): value is string => typeof value === 'string' && value.length <= 800 && !/[<>\r\n]/.test(value);
  const reviewedFrames = new Set(frames.map(f => f.index));
  if (Array.isArray(result.fixes)) for (const fix of result.fixes) {
    if (!fix || !Number.isInteger(fix.index) || !reviewedFrames.has(fix.index)) continue;
    const shot = plan.images[fix.index];
    if (validText(fix.nl)) shot.nl = fix.nl;
    if (!Array.isArray(fix.characters)) continue;
    for (const update of fix.characters) {
      if (!update || typeof update.name !== 'string') continue;
      const matches = shot.characters.filter(c => c.name === update.name);
      if (matches.length !== 1) continue;
      if (validText(update.tag) && update.tag.trim()) {
        const c = matches[0];
        const male = /^(?:1?boy|faceless male|male)$/i;
        const keepMale = c.tag.split(',').some(t => male.test(t.trim())) && !update.tag.split(',').some((t: string) => male.test(t.trim()));
        c.tag = keepMale ? 'boy, ' + update.tag : update.tag;
      }
      if (validText(update.nl)) matches[0].nl = update.nl;
    }
  }
  const removed = new Set<WardrobeUpdate>();
  disputed.forEach((event, i) => {
    const at = result.at[i];
    if (typeof at === 'string') { event.position = at; event.sourceLine = points.get(at); }
    else removed.add(event);
  });
  plan.wardrobeUpdates = events.filter(e => !removed.has(e));
  if (Array.isArray(result.missing)) {
    const cast = new Set([...before.keys(), ...entries.map(e => e.name), ...plan.changes.map(c => c.name),
      ...plan.images.flatMap(shot => shot.characters.map(c => c.name))]);
    for (const rawEvent of result.missing) {
      const event = normaliseWardrobeUpdate(rawEvent);
      if (!event || !event.position || !points.has(event.position) || !cast.has(event.name)) continue;
      const existing = plan.wardrobeUpdates.filter(e => e.name === event.name && e.position === event.position && (e.step ?? 0) === (event.step ?? 0));
      if (existing.some(e => e.mode === 'replace') || (event.mode === 'replace' && existing.length)) continue;
      for (const e of existing) for (const key of WARDROBE_SLOT_KEYS) if (e.slots[key]) delete event.slots[key];
      if (Object.keys(event.slots).length) plan.wardrobeUpdates.push({ ...event, sourceLine: points.get(event.position) });
    }
  }
  for (const shot of plan.images) for (const character of shot.characters) delete character.wearState;
  people.forEach(({ name, character, change }, i) => {
    const previous = profileAge(entries.find(e => e.name === name));
    const band = result.ages[i];
    const age = band === 'teen' ? 'teenager' : band === 'elderly' ? 'elderly adult' : typeof band === 'string' ? band : '';
    const ageTag = previous && (!age || ageBand(previous) === ageBand(age)) ? previous : age;
    if (change?.field === 'body') change.value = withAge(change.value, ageTag);
    if (change?.field === 'new' && change.value.startsWith('{')) {
      const fields = JSON.parse(change.value);
      const exact = String(fields.body ?? '').split(',').map(t => t.trim()).find(t => ageBand(t) && ageBand(t) === ageBand(ageTag));
      fields.body = withAge(fields.body ?? '', exact || ageTag);
      change.value = JSON.stringify(fields);
    }
    if (character) {
      character.frameAge = ageTag;
      character.tag = character.tag.split(',').map(t => t.trim()).filter(t => !ageBand(t)).join(', ');
      if (ageTag) character.tag = [character.tag, ageTag].filter(Boolean).join(', ');
    }
  });
}
