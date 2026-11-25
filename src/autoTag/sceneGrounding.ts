import type { TargetSegment } from './clean';
import type { ImageCharacterPrompt, ImageInsertion } from './protocol';
import { affirmedCue, groundFrameAnchor } from './frameAnchor';
import { readContactLayers } from './wardrobeProjection';
import { storyClauses } from './storyMoment';

const tags = (text: string) => text.split(',').map(tag => tag.trim()).filter(Boolean);
const TEARS = /流泪|落泪|泪[花水珠痕]|眼泪|热泪|含泪|哭(?:了|起来|出|着)|\b(?:tears?|crying|weeps?|tearful)\b/i;
const RED_EYES = /眼睛.{0,5}红|眼眶.{0,5}红|红[着了]眼|红了眼眶|\bred eyes\b/i;
const ARM_HOLD = /\b(?:arm hold|arm hug|(?:hugs?|holds?|grips?|clings? to|links?|holding|hugging|grabbing|gripping|clinging to) (?:[\w'’]+ ){0,5}arms?)\b/i;
const ACTION = /\b(?:kicks?|kicking|points?|pointing|reaches?|reaching|grabs?|grabbing|holds?|holding|walks?|walking|opens?|opening|wipes?|wiping|hands? over|placing|lifting|dancing|falling|running)\b/i;
const NON_ACTION = /^(?:[“「『"]|如果|假如|要是|想象|她想起|他想起|听说|if |would )|没(?:有)?(?:哭|踢|抬脚)|\b(?:didn.t|not yet)\b/i;
const LOCATION_BREAK = /场景切换|第二天|次日|翌日|数小时后|几天后|\b(?:the next day|hours? later|meanwhile elsewhere)\b/i;
const PLACE = /\b(?:hallway|living room|entryway|bedroom|cinema|theat(?:er|re)|classroom|kitchen|dining room|garden|office|street|station|balcony)\b/i;
const MALE = /^(?:1?boy|man|male|faceless male)$/i;
const FEMALE = /^(?:1?girl|woman|female)$/i;
const PASSIVE_TAG = /^(?:1?boy|boy|man|male|faceless male|standing|sitting|smil\w*|looking (?:down|away|at another|at viewer)|expressionless|serious|surprised|scared|worried|nervous|angry|shocked|open mouth|blush(?:ing)?|silent)$/i;
const PASSIVE_ACTION = /^(?:(?:he|the (?:man|boy))\s+)?(?:is |keeps |looks? |stands? |sits? |smiles? |stares? |watches? |observes? |remains? |lowers? |has |appears? |seems? )?(?:(?:his (?:head|gaze|eyes) )?(?:lowered|down)|down|at (?:her|them|another)|quietly|silently|nervously|still|nearby|by the door|in the living room|shocked|surprised|scared|silent|smiling|pale)(?:[ .]|$)/i;

function readFocus(value: unknown, image: ImageInsertion, at: string) {
  if (!Array.isArray(value) || value.length !== 4 || value.some(part => typeof part !== 'string')) return;
  const [name, evidence, visible, coverage] = value.map(part => part.trim());
  if (!image.characters.some(c => c.name === name) || evidence.length < 2 || !affirmedCue(at, evidence)
    || !/^[a-zA-Z][^<>#\r\n\u3400-\u9fff]{4,125}$/.test(visible)
    || !['feet', 'hands', 'faces', 'whole'].includes(coverage)) return;
  return { name, evidence, visible, coverage };
}

function withoutTears(value: string): string {
  return value
    .replace(/\s+(?:while|as|and)\s+(?:she |he )?(?:tears?\b|cries\b|weeps\b)[^.!?]*/gi, '')
    .replace(/\s+with\s+(?:tear-filled eyes|tears?\b[^.!?]*)/gi, '')
    .replace(/\b(?:tearful|teary|tear-filled|tear-streaked)\b\s*/gi, '')
    .trim();
}

function enforceVisibleState(image: ImageInsertion, prefix: string, future: string): void {
  if (!TEARS.test(prefix) && (TEARS.test(future) || RED_EYES.test(prefix))) {
    image.nl = withoutTears(image.nl);
    image.tag = tags(image.tag).filter(tag => !/^(?:tears?|tears in eyes|crying|crying with eyes open|tearful)$/i.test(tag)).join(', ');
    for (const character of image.characters) {
      character.tag = tags(character.tag).filter(tag => !/\b(?:tears?|crying|tearful|teary|tear-filled|tear-streaked)\b/i.test(tag)).join(', ');
      character.nl = withoutTears(character.nl);
    }
  }
  const platterEvents = [...prefix.matchAll(/(?:把|将)?果盘放(?:下|在茶几上|到茶几上)|放下果盘|(?:端起|拿起|捧起)果盘|\b(?:sets?|puts?|places?) the fruit platter (?:down|on the (?:coffee )?table)|\bpicks? up the fruit platter/gi)];
  if (/放|^(?:set|put|place)/i.test(platterEvents.at(-1)?.[0] ?? '') &&
      /\bfruit platter\b/i.test([image.nl, image.tag, ...image.characters.map(c => c.tag)].join(' '))) {
    for (const character of image.characters) {
      character.tag = tags(character.tag).filter(tag => !/\b(?:holding|carrying) (?:a |the )?fruit platter\b/i.test(tag)).join(', ');
      character.nl = character.nl.replace(/\b(?:holding|carrying|with) (?:a |the )?fruit platter\b/gi, 'beside the table');
    }
    const platter = /\s+(?:(?:holding|carrying|with) (?:a |the )?fruit platter)\b/gi;
    image.nl = image.nl.replace(platter, '');
    image.tag = [...tags(image.tag).filter(tag => !/\bfruit platter\b/i.test(tag)), 'fruit platter on the coffee table'].join(', ');
  }
}

function isPassive(character: ImageCharacterPrompt): boolean {
  return tags(character.tag).every(tag => PASSIVE_TAG.test(tag)) && (!character.nl || PASSIVE_ACTION.test(character.nl));
}

function applyViewpoint(image: ImageInsertion, raw: unknown, at: string): void {
  const men = image.characters.filter(c => tags(c.tag).some(tag => MALE.test(tag)));
  const women = image.characters.filter(c => !men.includes(c));
  if (men.length !== 1 || !women.length || !isPassive(men[0])) return;
  const viewer = men[0];
  const requested = Array.isArray(raw) && raw.length === 2 && raw[0] === 'pov' && raw[1] === viewer.name;
  const looksAtViewer = at.includes(viewer.name)
    && (/指向|看见|看到|望向|瞪着|盯着/.test(at) || /\b(?:points? at|sees?|looks? at|glares? at)\b/i.test(at));
  if (!requested && !looksAtViewer) return;
  const linked = image.characters.some(c => tags(c.tag).some(tag => /^(?:source|target|mutual)#/.test(tag))
    || /\b(?:holds?|holding|grabs?|grabbing|touches?|touching|hugs?|hugging|kicks?|kicking|pushes?|pushing|catches|catches hold of)\b.{0,30}\b(?:the man|the boy|his|him)\b/i.test(c.nl));
  if (linked || /\b(?:holds?|holding|grabs?|grabbing|touches?|touching|hugs?|hugging|kicks?|kicking|pushes?|pushing)\b.{0,30}\b(?:the man|the boy|his|him)\b/i.test(image.nl)) return;
  const replaceViewer = (value: string) => value.replace(/\b(?:the man|the boy)\b|\b(?:his|him)\b|@\{([^{}]+)\}/gi, (match, name) =>
    name ? name === viewer.name ? 'the viewer' : match : match.toLowerCase() === 'his' ? "the viewer's" : 'the viewer');
  image.characters = image.characters.filter(c => c !== viewer).map(c => ({
    ...c, nl: replaceViewer(c.nl), tag: tags(c.tag).map(tag => /^looking at another$/i.test(tag) && /\bpointing\b/i.test(c.tag) ? 'looking at viewer' : replaceViewer(tag)).join(', '),
  }));
  const base = tags(image.tag).filter(tag => !/^(?:1?boy|man|male|from side|profile view|three-quarter view|from behind|from front|pov|first-person view)$/i.test(tag)
    && !(women.length === 2 && /^(?:wide shot|long shot)$/i.test(tag)));
  if (women.length === 2 && !base.some(tag => /^(?:full body|full shot|medium shot|upper body|close-up|medium close-up)$/i.test(tag))) base.push('medium shot');
  image.tag = [...base, 'pov', ...(women.length === 2 ? ['eye-level', 'both women clearly visible at similar depth'] : [])].join(', ');
  image.nl = replaceViewer(image.nl);
}

/** 旧导演也能用正文校验。新导演可提供准确的触发短句和镜头必须容纳的部位。 */
export function groundStoryImage(image: ImageInsertion, raw: Record<string, unknown>, segments: TargetSegment[]): ImageInsertion {
  if (image.singleFrame === false) return image;
  groundFrameAnchor(image, raw, segments);
  const index = segments.findIndex(segment => segment.id === image.position);
  const clauses = storyClauses(segments[index]?.text ?? '');
  const matched = clauses.flatMap((part, i) => !NON_ACTION.test(part) && readFocus(raw.focus, image, part) ? [i + 1] : []);
  if (!image.clause && matched.length === 1) image.clause = matched[0];
  const until = image.clause ?? clauses.length;
  const at = clauses.slice(0, until).filter(part => !NON_ACTION.test(part)).join(' ');
  const prior = segments.slice(0, index).map(segment => segment.text);
  const sceneStart = prior.findLastIndex(text => LOCATION_BREAK.test(text)) + 1;
  const prefix = [...prior.slice(Math.max(sceneStart, index - 6)).flatMap(storyClauses).filter(part => !NON_ACTION.test(part)), at].join(' ');
  const future = [clauses.slice(until).join(' '), ...segments.slice(index + 1, index + 7).map(segment => segment.text)].join(' ');
  enforceVisibleState(image, prefix, future);
  image.clearLayers = readContactLayers(raw.clearLayers, image, clauses.slice(0, until));
  applyViewpoint(image, raw.view, at);

  const point = image.clause ? clauses[image.clause - 1] : at;
  const focus = image.clause && !NON_ACTION.test(point) ? readFocus(raw.focus, image, point) : undefined;
  if (focus) {
    image.characters = image.characters.map(c => c.name === focus.name ? {
      ...c, tag: [focus.visible, ...tags(c.tag).filter(tag => tag.toLowerCase() !== focus.visible.toLowerCase())].join(', '),
    } : c);
    if (focus.coverage === 'whole' || focus.coverage === 'feet') image.extent = 'whole';
    if (focus.coverage === 'hands' || focus.coverage === 'faces') {
      image.tag += focus.coverage === 'hands' ? ', hands visible' : ', faces clearly visible';
    }
    image.sourceCue = focus.evidence;
    image.visualPose = focus.visible.toLowerCase();
  }

  const shotText = [image.tag, image.nl, ...image.characters.flatMap(c => [c.tag, c.nl])].join(' ');
  if (/(?:手机|smartphone|phone)/i.test(at) && /(?:踢|kick)/i.test(at) && /\b(?:kicks?|kicking)\b/i.test(shotText)) {
    const phoneActor = image.characters.find(c => /\bkicking\b/i.test(c.tag)) ??
      image.characters.find(c => /\bkicks?\b/i.test(c.nl));
    if (phoneActor) {
      const cracked = /碎裂|裂.{0,5}屏|cracked|broken/i.test(prefix);
      const phone = cracked ? 'cracked smartphone' : 'smartphone';
      const cue = 'shoe touching the ' + phone + ' on the floor';
      phoneActor.tag = [cue, ...tags(phoneActor.tag).filter(tag => !/\b(?:kicking|(?:holding|carrying) (?:a |the )?(?:cracked )?(?:phone|smartphone))\b/i.test(tag))].join(', ');
      phoneActor.nl = phoneActor.nl.replace(/[^.!?]*\b(?:kick|phone|smartphone)\w*\b[^.!?]*[.!?]?/gi, '').trim();
      if (image.nl) image.nl = 'The ' + cue.replace(' touching', ' touches') + '. '
        + image.nl.replace(/\s+while kicking\b.*$/i, '.').replace(/\s+(?:toward|at) (?:the other (?:man|boy)'s|his) feet\b/gi, ' across the floor');
      image.tag = [...tags(image.tag).filter(tag => !/\b(?:smartphone|phone)\b/i.test(tag)), phone + ' on the floor', 'shoe and phone both in frame'].join(', ');
      image.extent = 'whole';
      image.visualPose = 'foot contacts phone';
    }
  }

  const committedContact = /(?:踹|踢)在.{0,16}(?:腹部|肚子)|\b(?:foot|kick) (?:lands?|makes contact)\b/i.test(point);
  if (committedContact && /\b(?:kicking|kick|kicks)\b/i.test(shotText)) {
    const actor = image.characters.find(c => /\b(?:kicking|kicks?|leg lifted)\b/i.test(c.tag));
    const target = image.characters.find(c => c !== actor && /\b(?:falling backwards?|clutching stomach|stumbles?)\b/i.test(c.tag));
    if (actor && target) {
      const actorCue = 'extended foot in contact with @{' + target.name + '}';
      const targetCue = 'recoiling at the instant of contact with @{' + actor.name + '}';
      actor.tag = [actorCue, ...tags(actor.tag).filter(tag => !/^(?:standing|leg lifted|kicking)$/i.test(tag))].join(', ');
      target.tag = [targetCue, ...tags(target.tag).filter(tag => !/^(?:falling backwards?|clutching stomach|standing)$/i.test(tag))].join(', ');
      if (image.nl) {
        const reaction = image.nl.split(/\bwhile\s+/i, 2)[1];
        image.nl = "@{" + actor.name + "}'s foot is in contact with @{" + target.name + "}."
          + (reaction ? ' ' + reaction[0].toUpperCase() + reaction.slice(1) : '');
      }
      actor.nl = '';
      target.nl = target.nl.replace(/[^.!?]*\b(?:stumbles?|falls?|clutches?)\b[^.!?]*[.!?]?/gi, '').trim();
      image.tag = [...tags(image.tag), 'both participants and point of contact visible'].join(', ');
      image.extent = 'whole';
      image.visualPose = 'contact at full extension';
    }
  }
  const lastClothingGrip = [...prefix.matchAll(/(?:抓|拽|揪|攥|扯)[紧住着]?(?:[\p{L}]{1,10}的)?(衣角|袖子|衣袖)|\b(?:grips?|grabs?) .{0,16}(shirt hem|sleeve)/giu)].at(-1);
  if (/衣角|hem/i.test(lastClothingGrip?.[0] ?? '')) {
    const toHem = (text: string) => text.replace(/\bsleeve\b/gi, 'shirt hem');
    image.nl = toHem(image.nl);
    for (const character of image.characters) {
      character.tag = tags(character.tag).map(tag => /\b(?:hold|holding|grip|gripping|grab|grabbing)\b/i.test(tag) ? toHem(tag) : tag).join(', ');
      character.nl = toHem(character.nl);
    }
  }
  const pose = typeof raw.pose === 'string' && /^[\p{L}\p{N} -]{2,64}$/u.test(raw.pose.trim()) ? raw.pose.trim().toLowerCase() : '';
  if (pose && (!image.visualPose || focus)) image.visualPose = ARM_HOLD.test(pose) ? 'arm hold' : pose;
  if (!image.visualPose && !/\b(?:kicks?|kicking|runs?|running|falls?|falling|kneels?|kneeling)\b/i.test(shotText)) {
    const actor = image.characters.find(c => ARM_HOLD.test(c.tag) || ARM_HOLD.test(c.nl))
      ?? image.characters.find(c => tags(c.tag).some(tag => FEMALE.test(tag)));
    if (actor && ARM_HOLD.test(shotText)) image.visualPose = 'arm hold';
  }
  const actor = image.characters.find(c => ARM_HOLD.test(c.tag) || /^(?:shoe touching)/i.test(c.tag))
    ?? image.characters.find(c => tags(c.tag).some(tag => FEMALE.test(tag)));
  const place = tags(image.tag).find(tag => PLACE.test(tag))?.match(PLACE)?.[0].toLowerCase();
  if (image.visualPose && actor) image.visualPose = [sceneStart, place ?? '', focus?.name ?? actor.name, image.visualPose].join('|');
  else if (!focus && (!actor || !place || !ACTION.test(shotText) && !ARM_HOLD.test(shotText))) delete image.visualPose;
  return image;
}
