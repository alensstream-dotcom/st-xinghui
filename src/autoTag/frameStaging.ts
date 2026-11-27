import type { TargetSegment } from './clean';
import { affirmedCue, isFrameSceneBoundary } from './frameAnchor';
import type { ImageInsertion } from './protocol';
import { storyClauses } from './storyMoment';

const CAMERA = /^(?:from side|profile view|three-quarter view|from behind|back view|from front|front view|from above|from below|pov)$/i;
const SCALE = /^(?:wide shot|long shot|full shot|full body|medium shot|medium close-up|upper body|cowboy shot|close[- ]?up|portrait|face focus)$/i;
const TIGHT = /^(?:close[- ]?up|portrait|face focus|medium close-up|upper body)$/i;
const CROP = new Set(['hands', 'faces', 'knees', 'feet', 'support', 'contact']);
const POSTURES: Readonly<Record<string, RegExp>> = {
  kneeling: /跪|\bkneel/i, standing: /站|\bstand/i, sitting: /坐|\b(?:sit|seated)/i,
  crouching: /蹲|\bcrouch/i, lying: /躺|卧|平躺|\b(?:lying|lies)\b/i,
  'on all fours': /四肢|四脚|(?:手|掌).{0,12}撑.{0,12}(?:地|地板)|\bon all fours\b/i,
};
const ROLE_MOTION = /^(?:(?:source|target|mutual)#|(?:standing|sitting|seated|kneeling|crouching|lying|on all fours|prone|supine|arched back|upright|leaning|bending|bowing|reaching|bracing|resting|holding|gripping|grabbing|hugging|embracing|pressing|pressed down|pushing|pulling|touching|biting|pointing|hands (?:on|at|against)|both palms|arms (?:raised|extended)|back against|facing)\b)/i;
const SHARED_MOTION = /^(?:hug|embrace|hugging|embracing|standing|sitting|kneeling|lying|on all fours|arched back|leaning forward|leaning back|hands on floor)$/i;
const CAMERA_PLACE = /^(?:school hallway|hallway|living room|entryway|bedroom|cinema|movie theater|classroom|kitchen|dining room|garden|office|city street|street|station|balcony|workshop|restaurant)$/i;
const PLACE_CUES: ReadonlyArray<[RegExp, string]> = [
  [/阳台|\bbalcony\b/i, 'balcony'], [/办公室|\boffice\b/i, 'office'],
  [/工作间|工坊|\bworkshop\b/i, 'workshop'], [/餐厅|\brestaurant\b/i, 'restaurant'],
  [/客厅|\bliving room\b/i, 'living room'], [/厨房|\bkitchen\b/i, 'kitchen'],
];
const SET_PROP = /贴|夹|挂|扣|戴|系|绑|固定|安[装上]|握|拿[起着]|端[起着]|放[在到]|\b(?:clipp?\w*|fasten\w*|attach\w*|hang\w*|holds?|held|picks? up|puts? on|sets? on|ties?|tied|wear\w*)\b/i;
const REMOVE_PROP = /取[下走出]|摘|拿[下走开]|解[开下]|松开|收起|放下|掉[下来落]|移[开走]|丢|\b(?:remove\w*|unclip\w*|unfasten\w*|took off|takes? off|puts? down|drops?|falls? off)\b/i;

const split = (text: string) => text.split(',').map(part => part.trim()).filter(Boolean);

export function stagingActionQuote(value: unknown): unknown {
  const staging = value as { action?: unknown } | null | undefined;
  return Array.isArray(staging?.action) && english(staging.action[1], 165) ? staging.action[0] : undefined;
}

function english(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  const text = value.trim().replace(/[.!?]+$/, '');
  return text.length <= limit && /[a-z]/i.test(text) && !/[<>,#\r\n\u3400-\u9fff]/.test(text.replace(/@\{[^{}\r\n]+\}/g, '')) ? text : '';
}

interface ScenePoint {
  segment: TargetSegment;
  clause: number;
  text: string;
  scene: number;
}

function scenePoints(segments: TargetSegment[]): ScenePoint[] {
  let scene = 0;
  return segments.flatMap(segment => storyClauses(segment.text).map((text, index) => {
    if (isFrameSceneBoundary(text)) scene++;
    return { segment, clause: index + 1, text, scene };
  }));
}

function comparePoints(a: ScenePoint, b: ScenePoint): number {
  return a.segment.sourceLine - b.segment.sourceLine || a.clause - b.clause;
}

function atFrame(point: ScenePoint, image: ImageInsertion): boolean {
  return point.segment.id === image.position && (!image.clause || point.clause === image.clause);
}

/** 将同一帧的演员调度与机位一起编译。正文没对上时沿用原镜头。 */
export function applyFrameStaging(image: ImageInsertion, raw: unknown, segments: TargetSegment[], pinned = false): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || image.singleFrame === false) return false;
  const staging = raw as Record<string, unknown>;
  const action = Array.isArray(staging.action) ? staging.action : [];
  const main = english(action[1], 165);
  const quote = action[0];
  if (!main || typeof quote !== 'string' || quote.length < 4 || quote.length > 160) return false;
  const points = scenePoints(segments);
  const moment = points.find(point => atFrame(point, image) && affirmedCue(point.text, quote));
  if (!moment) return false;
  if (pinned) {
    const event = staging.event as Record<string, unknown> | undefined;
    if (!event || typeof event.actor !== 'string' || !event.actor.trim()
      || typeof event.verb !== 'string' || !english(event.verb, 48)
      || typeof event.target !== 'string' || !english(event.target, 80)
      || !['approach', 'contact', 'result', 'state'].includes(String(event.phase))) return false;
    const words = (text: string) => ' ' + text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
    if (!words(main).includes(words(event.verb)) || !words(main).includes(words(event.target))) return false;
    const subject = /^@\{([^{}]+)\}/.exec(main)?.[1];
    if (subject && subject !== event.actor) return false;
    if (event.actor !== 'viewer' && !image.characters.some(c => c.name === event.actor)
      && !moment.text.includes(event.actor)) return false;
    const expected = /(?:正要|刚要|伸向|即将|\babout to\b)/i.test(quote) ? 'approach'
      : /(?:已经|放回|松开|放下|穿好|关上|\balready\b)/i.test(quote) ? 'result'
      : /(?:握住|碰到|接住|抓住|贴住|\bgrasp(?:s|ed)?\b)/i.test(quote) ? 'contact' : undefined;
    if (expected && event.phase !== expected) return false;
    const depicted = /\b(?:already|has finished|puts? .+ back|has put|sets? .+ down|releases?|lets? go)\b/i.test(main) ? 'result'
      : /\b(?:about to|reaches? toward|starts? to)\b/i.test(main) ? 'approach' : undefined;
    if (depicted && depicted !== event.phase) return false;
    if (event.actor === 'viewer' && (!/\bpov\b/i.test(String((staging.camera as unknown[] | undefined)?.[0]))
      || !/\b(?:viewer|pov|foreground)\b/i.test(main))) return false;
    if (event.actor === 'viewer') {
      image.characters = image.characters.filter(c => !split(c.tag).some(tag => /^(?:1?boy|male|man|faceless male)$/i.test(tag)));
      image.tag = split(image.tag).filter(tag => !/^\d+boys?$/i.test(tag)).join(', ');
    }
  }

  const actors = new Map<string, { posture: string; detail: string }>();
  for (const row of Array.isArray(staging.actors) ? staging.actors.slice(0, 8) : []) {
    if (!Array.isArray(row) || row.length !== 4) continue;
    const [name, posture, detail, evidence]: unknown[] = row;
    if (typeof name !== 'string' || typeof posture !== 'string' || !image.characters.some(c => c.name === name)) continue;
    const physical = english(detail, 125);
    const cues: unknown[] = Array.isArray(evidence) ? evidence : [evidence];
    if (!physical || !cues.length || cues.length > 3) continue;
    const facts: Array<{ point: ScenePoint; cue: string }> = [];
    for (const cue of cues) {
      if (typeof cue !== 'string' || cue.length < 3 || cue.length > 160) continue;
      const point: ScenePoint | undefined = points.findLast(candidate => candidate.scene === moment.scene
        && comparePoints(candidate, moment) <= 0 && affirmedCue(candidate.text, cue));
      if (point) facts.push({ point, cue });
    }
    if (facts.length !== cues.length) continue;
    const fact: ScenePoint | undefined = posture === 'keep' ? facts[0].point
      : Object.hasOwn(POSTURES, posture) ? facts.find(match => POSTURES[posture].test(match.cue))?.point : undefined;
    if (!fact) continue;
    const interveningPose = posture !== 'keep' && fact !== moment && points.some(point =>
      point.scene === moment.scene && point.text.includes(name) && !image.characters.some(c => c.name !== name && point.text.includes(c.name))
      && comparePoints(point, fact) > 0
      && comparePoints(point, moment) <= 0
      && !POSTURES[posture].test(point.text) && Object.values(POSTURES).some(pattern => pattern.test(point.text))
      && affirmedCue(point.text, point.text));
    if (!interveningPose) actors.set(name, { posture, detail: physical });
  }

  const camera = Array.isArray(staging.camera) ? staging.camera : [];
  const angle = typeof camera[0] === 'string' && CAMERA.test(camera[0]) ? camera[0].toLowerCase() : '';
  const showing = new Set<string>(Array.isArray(camera[1]) ? camera[1].filter((part: unknown) => typeof part === 'string' && CROP.has(part)) : []);
  const broad = showing.has('knees') || showing.has('feet');
  const base = split(image.tag).filter(tag => (!pinned || !/\b(?:grip\w*|hold\w*|put\w*|releas\w*|reach\w*|touch\w*)\b/i.test(tag)) && !SHARED_MOTION.test(tag) && !(angle && CAMERA.test(tag))
    && !(showing.has('faces') && /^hand focus$/i.test(tag)));
  const showHandsAndFaces = showing.has('faces') && showing.has('hands');
  if (broad) {
    image.extent = 'whole';
  } else if ((showHandsAndFaces || showing.has('support') && showing.has('contact')) && image.extent !== 'detail') {
    for (let i = 0; i < base.length; i++) if (TIGHT.test(base[i])) base[i] = 'medium shot';
  }
  const framing = base.filter(tag => SCALE.test(tag) || CAMERA.test(tag));
  const environment = base.filter(tag => !framing.includes(tag));
  const counts = environment.filter(tag => /^(?:[1-9]\d*\+?(?:girls?|boys?|others?)|solo)$/i.test(tag));
  image.tag = [...new Set([...counts, main, ...(angle ? [angle] : []), ...framing, ...environment])].join(', ');
  image.nl = '';
  image.clause = moment.clause;
  image.sourceCue = quote;

  const pair = Array.isArray(staging.link) ? staging.link : [];
  const key = typeof pair[2] === 'string' && /^[a-z]+(?:[ -][a-z]+){0,2}$/i.test(pair[2]) && pair[0] !== pair[1]
    && image.characters.some(c => c.name === pair[0]) && image.characters.some(c => c.name === pair[1]) ? pair[2].toLowerCase() : '';
  image.characters = image.characters.map(character => {
    const grounded = actors.get(character.name);
    const marker = key && character.name === pair[0] ? 'source#' + key : key && character.name === pair[1] ? 'target#' + key : '';
    if (pinned) return { ...character, tag: [...split(character.tag).filter(tag => /^(?:1?girl|1?boy|woman|man|smile|blush|frown|surprised|looking at viewer|closed eyes)$/i.test(tag)), grounded?.posture === 'keep' ? '' : grounded?.posture, grounded?.detail, marker].filter(Boolean).join(', '), nl: '' };
    if (!grounded && !marker) return character;
    const kept = split(character.tag).filter(tag => grounded ? !ROLE_MOTION.test(tag)
      || grounded.posture === 'keep' && Object.hasOwn(POSTURES, tag.toLowerCase()) : !/^(?:source|target|mutual)#/i.test(tag));
    const pose = grounded?.posture !== 'keep' ? grounded?.posture : '';
    return { ...character, tag: [...new Set([pose, grounded?.detail, marker, ...kept].filter(Boolean))].join(', '),
      nl: grounded ? '' : character.nl };
  });
  const poseKey = typeof staging.pose === 'string' && /^[\p{L}\p{N} -]{2,64}$/u.test(staging.pose) ? staging.pose : main;
  image.visualPose = [moment.scene, ...actors.keys(), poseKey.toLowerCase()].join('|');
  return true;
}

/** 旧方案没给演员调度时，保住正文已确认的栏杆支撑。 */
export function keepGroundedSupport(image: ImageInsertion, segments: TargetSegment[]): void {
  if (image.singleFrame === false || image.extent === 'detail') return;
  const candidates = image.characters.filter(c => split(c.tag).some(tag => /^(?:kneeling|on all fours)$/i.test(tag)));
  if (candidates.length !== 1) return;
  const actor = candidates[0];
  const points = scenePoints(segments);
  const moment = points.findLast(point => atFrame(point, image));
  if (!moment) return;
  const prior = points.filter(point => point.scene === moment.scene && comparePoints(point, moment) <= 0
    && !image.characters.some(c => c.name !== actor.name && point.text.includes(c.name))
    && affirmedCue(point.text, point.text));
  const rail = /栏杆|护栏|防盗网|\b(?:rail(?:ing)?|metal bars)\b/i;
  const support = /(?:手|掌|腕).{0,10}(?:撑|扶|抓|握|靠).{0,10}(?:栏杆|护栏|防盗网)|\bhands? (?:braced|resting|gripping) (?:on |the )?(?:rail(?:ing)?|metal bars)\b/i;
  const attachment = /(?:绑|系|固定)在.{0,10}(?:栏杆|护栏|防盗网)|\b(?:tied|fixed) to (?:the )?(?:rail(?:ing)?|metal bars)\b/i;
  const later = prior.findLast(point => support.test(point.text) || attachment.test(point.text)
    || /松开|放开|解开|解绑|站起|离开|lets? go|steps? away|stands? up/i.test(point.text));
  if (!later || !rail.test(later.text)) return;
  const detail = support.test(later.text) ? 'hands braced on the railing'
    : attachment.test(later.text) ? 'fixed against the metal railing' : '';
  if (!detail) return;
  actor.tag = [...new Set([detail, ...split(actor.tag).filter(tag =>
    !/^hands? (?:on|against) (?:the )?(?:ground|floor)$/i.test(tag)
    && !(support.test(later.text) && /^on all fours$/i.test(tag)))])].join(', ');
  image.extent = 'whole';
}

interface PropState {
  owner: string;
  detail: string;
  region: string;
  site?: string;
}

function clipAlreadyDescribed(image: ImageInsertion): boolean {
  return /\b(?:clamps?|clips?)\b/i.test(image.tag) && /\b(?:clips?|clamps?|pinches?|holds?|fastens?)\b/i.test(image.nl);
}

function scenePlace(image: ImageInsertion): string | undefined {
  return split(image.tag).find(tag => CAMERA_PLACE.test(tag))?.toLowerCase();
}

interface PropEvent {
  point: ScenePoint;
  id: string;
  prop?: PropState;
}

/** 旧提示词已声明某个固定件时，用原文的实际装上与撤下补一条道具轨迹。 */
function legacyAttachments(points: ScenePoint[], images: ImageInsertion[], events: PropEvent[]): PropEvent[] {
  const found: PropEvent[] = [];
  const used = new Set<string>();
  const clip = /夹子|夹具|夹钳|\b(?:clamps?|clips?)\b/i;
  for (const image of images) {
    if (image.characters.length !== 1 || !image.sourceCue || !clip.test(image.sourceCue)
      || !split(image.tag).some(tag => /\b(?:clamps?|clips?)\b/i.test(tag))
      || !/\b(?:clips?|clamps?|pinches?|holds?|fastens?) (?:directly )?(?:to |against )?her\b/i.test(image.nl)) continue;
    const point = points.find(p => atFrame(p, image) && affirmedCue(p.text, image.sourceCue!));
    const owner = image.characters[0].name;
    if (!point || events.some(e => e.point.scene === point.scene && e.prop?.owner === owner && clip.test(e.prop.detail))) continue;
    const id = 'attached-clips:' + point.scene + ':' + owner;
    if (used.has(id)) continue;
    used.add(id);
    const linked = split(image.tag).some(tag => /^chain$/i.test(tag));
    found.push({ point, id, prop: { owner, region: 'upper', site: scenePlace(image),
      detail: linked ? 'clips still attached and linked by a thin chain' : 'clips still attached' } });
    const release = points.find(p => p.scene === point.scene && comparePoints(p, point) > 0
      && clip.test(p.text) && REMOVE_PROP.test(p.text) && affirmedCue(p.text, p.text));
    if (release) found.push({ point: release, id });
  }
  return found;
}

/** 回放道具入场、归属及撤下。无图的段落也能更新。只投影到主人在画面里的镜头。 */
export function carryFrameProps(raw: unknown, images: ImageInsertion[], segments: TargetSegment[]): void {
  const points = scenePoints(segments);
  const cast = new Set(images.flatMap(image => image.characters.map(c => c.name)));
  const events: PropEvent[] = (Array.isArray(raw) ? raw.slice(0, 32) : []).flatMap(event => {
    if (!Array.isArray(event) || event.length < 4) return [];
    const [position, cue, id, op, owner, detail, region]: unknown[] = event;
    if (typeof position !== 'string' || typeof cue !== 'string' || cue.length < 4 || cue.length > 160
      || typeof id !== 'string' || !/^[a-z0-9_-]{1,24}$/i.test(id) || (op !== 'set' && op !== 'clear')
      || !(op === 'set' ? SET_PROP : REMOVE_PROP).test(cue)) return [];
    const matches = points.filter(point => point.segment.id === position.toUpperCase() && affirmedCue(point.text, cue));
    if (matches.length !== 1) return [];
    const value = english(detail, 100);
    if (op === 'set' && (typeof owner !== 'string' || !cast.has(owner) || !value)) return [];
    return [{ point: matches[0], id: id.toLowerCase(), prop: op === 'set' ? {
      owner: owner as string, detail: value, region: region === 'low' ? 'low' : 'upper',
      site: PLACE_CUES.find(([pattern]) => pattern.test(matches[0].segment.text))?.[1],
    } : undefined }];
  });
  events.push(...legacyAttachments(points, images, events));
  events.sort((a, b) => comparePoints(a.point, b.point));
  if (!events.length) return;
  const descriptions = new Map<string, Set<string>>();
  for (const event of events) if (event.prop) {
    const details = descriptions.get(event.prop.owner) ?? new Set();
    details.add(event.prop.detail.toLowerCase());
    descriptions.set(event.prop.owner, details);
  }
  let cursor = 0;
  let scene = -1;
  const active = new Map<string, PropState>();
  const ordered = [...images].sort((a, b) => a.sourceLine - b.sourceLine || (a.clause ?? Infinity) - (b.clause ?? Infinity));
  for (const image of ordered) {
    const point = points.findLast(point => atFrame(point, image));
    if (!point) continue;
    if (point.scene !== scene) {
      active.clear();
      scene = point.scene;
    }
    const site = scenePlace(image);
    while (cursor < events.length) {
      const event = events[cursor];
      if (comparePoints(event.point, point) > 0) break;
      cursor++;
      if (event.point.scene !== scene) continue;
      if (event.prop) active.set(event.id, { ...event.prop, site: event.prop.site ?? site });
      else active.delete(event.id);
    }
    if (image.singleFrame === false) continue;
    for (const character of image.characters) {
      const managed = descriptions.get(character.name);
      if (managed) character.tag = split(character.tag).filter(tag => !managed.has(tag.toLowerCase())).join(', ');
    }
    for (const prop of active.values()) {
      if (site && prop.site && site !== prop.site) continue;
      if (prop.region === 'low' && image.extent !== 'whole' && /\b(?:close-up|upper body|face focus)\b/i.test(image.tag)
        && !/\b(?:full body|wide shot|lower body|foot focus)\b/i.test(image.tag)) continue;
      const holder = image.characters.find(c => c.name === prop.owner);
      if (holder && !(prop.detail.startsWith('clips still attached') && clipAlreadyDescribed(image))) holder.tag = [...new Set([...split(holder.tag), prop.detail])].join(', ');
    }
  }
}
