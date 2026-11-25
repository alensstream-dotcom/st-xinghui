import { compareStoryMoments, storyClauses } from './storyMoment';
import type { CharTagEntry } from '@/state/charTags';
import type { CharChange, ImageInsertion } from './protocol';

export const RELATION_TAG = /^(?:(?:older|younger|little|big|adult|eldest) )?(?:daughter|mother|sister|son|father|brother)s?$/i;
export const hasAgeCue = (text: string) => /成年|长大后|老年|年幼|童年|小时候|幼年|[岁歲]时|(?:十|[0-9]|[一二三四五六七八九])多?[岁歲]|\b(?:childhood|as a child|as an adult|grown up|long since grown|[0-9]+ years? old)\b/i.test(text);

export const FACE_IDENTITY = /\b(?:face shape|oval face|round face|angular face|heart-shaped face|square face|long face|cheekbones|jawline|eyebrows?|brows?)\b/i;

const tags = (text: string) => text.split(',').map(s => s.trim()).filter(Boolean);

export function ageBand(tag = ''): string {
  const numeric = tag.match(/^(\d{1,3})[ -](?:years?[ -]old|yo)(?: (?:girl|boy|woman|man|female|male))?$/i);
  if (numeric) return +numeric[1] < 13 ? 'child' : +numeric[1] < 18 ? 'teen' : 'adult';
  if (/^(?:child|little girl|little boy|female child|male child|young child|toddler|baby|preteen|loli|shota)$/i.test(tag)) return 'child';
  if (/^(?:teen|teenager|teenage (?:girl|boy)|adolescent)$/i.test(tag)) return 'teen';
  if (/^(?:(?:young |middle-aged |elderly )?adult(?: woman| man| female| male)?|(?:mature|middle-aged|elderly|old) (?:woman|man|female|male)|young (?:woman|man))$/i.test(tag)) return 'adult';
  return '';
}

export function frameAgeMatchesSource(value: string, text: string): boolean {
  if (!hasAgeCue(text)) return false;
  const digit = '零一二三四五六七八九';
  const ages = [...text.matchAll(/(\d{1,3}|[零一二三四五六七八九十两]{1,4})(?:岁|歲| years? old)/gi)].map(([, word]) => {
    if (/^\d+$/.test(word)) return Number(word);
    const [tens, units] = word.replace(/两/g, '二').split('十');
    return units === undefined ? digit.indexOf(tens) : 10 * (tens ? digit.indexOf(tens) : 1) + (units ? digit.indexOf(units) : 0);
  }).filter(age => age > 0);
  if (value === 'child') return ages.some(age => age < 13) || /年幼|童年|小时候|幼年|\b(?:childhood|as a child)\b/i.test(text);
  if (value === 'teenager') return ages.some(age => age >= 13 && age < 18) || /少年|青春期|未成年|\bteenage?r?\b/i.test(text);
  return !/童年|幼年|未成年|childhood|as a child/i.test(text) && (!ages.length || ages.some(age => age >= 18));
}

export function profileAge(entry: CharTagEntry | undefined): string {
  if (!entry) return '';
  const values = tags([entry.fields.body, entry.fields.extra, entry.fields.sex, entry.raw].filter(Boolean).join(', ')).filter(t => ageBand(t));
  return new Set(values.map(ageBand)).size === 1 ? values[0] : '';
}

function displayTrait(entry: CharTagEntry | undefined, others: CharTagEntry[]): string {
  if (!entry) return '';
  const useful = (e: CharTagEntry) => tags([e.fields.hair, e.fields.eyes, e.fields.extra].join(', ')).filter(t =>
    /\b(?:bun|braids?|ponytail|twintails|hair|eyes|eyebrows|cheekbones|face|glasses|eyewear)\b/i.test(t)
      && !/^(?:long|very long|short|medium|straight|wavy|curly) hair$/i.test(t));
  return useful(entry).find(t => others.every(other => other === entry || !useful(other).includes(t))) ?? '';
}

/** 只替换当前镜头内的指称。普通叙述仍是模型原写的英文，不拼动作模板。 */
export function resolveVisualSubjects(image: ImageInsertion, entries: CharTagEntry[]): ImageInsertion {
  if (!image.characters.length) return image;
  const onScreen = entries.filter(e => image.characters.some(c => c.name === e.name));
  const labels = new Map<string, string>();
  for (const c of image.characters) {
    const entry = onScreen.find(e => e.name === c.name);
    const band = ageBand(c.frameAge ?? profileAge(entry));
    const male = /(?:^|,\s*)(?:1?boy|male|faceless male)(?:,|$)/i.test(c.tag + ', ' + (entry?.fields.sex ?? ''));
    const noun = band === 'adult' ? (male ? 'man' : 'woman') : band === 'teen' ? 'teenager' : band === 'child' ? 'child' : 'person';
    const trait = displayTrait(entry, onScreen);
    const article = /\b(?:bun|braid|ponytail|face)$/i.test(trait) ? (/^[aeiou]/i.test(trait) ? 'an ' : 'a ') : '';
    labels.set(c.name, 'the ' + noun + (trait ? ' with ' + article + trait : ''));
  }
  const ordinals = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
  const base = new Map(labels);
  for (const [name, label] of base) {
    const same = [...base].filter(([, other]) => other === label).map(([n]) => n);
    if (same.length > 1) labels.set(name, label.replace(/^the /, 'the ' + (ordinals[same.indexOf(name)] ?? String(same.indexOf(name) + 1)) + ' '));
  }
  const token = /@\{([^{}\n]+)\}|@([\p{L}\p{N}_·]+)/gu;
  const relatives = new Map<string, string[]>();
  for (const c of image.characters) for (const label of tags(c.tag).filter(t => RELATION_TAG.test(t))) {
    const role = label.toLowerCase().split(' ').at(-1)!;
    relatives.set(role, [...(relatives.get(role) ?? []), c.name]);
  }
  const women = image.characters.filter(c => /(?:^|,\s*)(?:1?girl|woman|female)(?:,|$)/i.test(
    c.tag + ', ' + (onScreen.find(e => e.name === c.name)?.fields.sex ?? '')));
  const text = [image.nl, ...image.characters.map(c => c.nl)].join(' ');
  // 旧导演常只在英文里写 “her mother” 或 “beside her daughter”，角色标签中没有亲属字段。
  // 只有二人且能唯一判定指称时才用它定位，身份和年龄依然从各自档案读取。
  if (women.length === 2 && /\b(?:mother|daughter)\b/i.test(text)) {
    const motherBySpeech = women.filter(c => /\b(?:her daughter|the other woman's daughter)\b/i.test(c.nl));
    const daughterBySpeech = women.filter(c => /\b(?:her mother|the other woman's mother)\b/i.test(c.nl));
    const mother = motherBySpeech.length === 1 ? motherBySpeech[0] :
      daughterBySpeech.length === 1 ? women.find(c => c !== daughterBySpeech[0]) : undefined;
    if (mother) {
      if (!relatives.has('mother')) relatives.set('mother', [mother.name]);
      if (!relatives.has('daughter')) relatives.set('daughter', [women.find(c => c !== mother)!.name]);
    }
  }
  const daughters = [...new Set(relatives.get('daughter') ?? [])];
  const clearRelationalAge = daughters.length === 1;
  const daughter = image.characters.find(c => clearRelationalAge && daughters[0] === c.name);
  const daughterAge = ageBand(daughter?.frameAge ?? profileAge(onScreen.find(e => e.name === daughter?.name)));
  const resolve = (text: string) => text
    .replace(/\b(?:the|her|his|their) (?:adult |younger |older |little )?(daughter|mother|sister|brother|son|father)\b/gi, (original, role: string) => {
      const matches = relatives.get(role.toLowerCase());
      return matches?.length === 1 ? labels.get(matches[0]) ?? original : original;
    })
    .replace(/\bthe (?:little |young )?girl\b/gi, original =>
      daughter ? labels.get(daughter.name) ?? original : original)
    .replace(/\b(?:her|his|their) (?:little girl|young child)\b/gi, original =>
      daughter && daughterAge !== 'child' ? labels.get(daughter.name) ?? original : original)
    .replace(token, (_match, bracket, plain) => labels.get(bracket ?? plain) ?? 'the person');
  return { ...image, tag: resolve(tags(image.tag).filter(t => !RELATION_TAG.test(t)).join(', ')), nl: resolve(image.nl), characters: image.characters.map(c => {
    const known = ageBand(c.frameAge ?? profileAge(onScreen.find(e => e.name === c.name)));
    const own = tags(c.tag).filter(t => t !== '@' + c.name && t !== '@{' + c.name + '}' && !RELATION_TAG.test(t)
      && !((known || c.name === daughter?.name) && ageBand(t) && known !== ageBand(t)));
    if (c.frameAge && !own.includes(c.frameAge)) own.push(c.frameAge);
    return { ...c, tag: resolve(own.join(', ')), nl: resolve(c.nl) };
  }) };
}

/** 同一字段的局部变化不应抹掉独立且已确认的体征。只用于新生成的自动档案操作。 */
export function retainUnchangedTraits(changes: CharChange[], entries: CharTagEntry[], sourceByPosition: ReadonlyMap<string, string>): void {
  const known = new Map(entries.map(e => [e.name, {
    body: e.fields.body, hair: e.fields.hair, eyes: e.fields.eyes, skin: e.fields.skin, age: profileAge(e),
  }]));
  for (const c of [...changes].sort(compareStoryMoments)) {
    if (c.field === 'new' && c.value.startsWith('{') && !known.has(c.name)) {
      const f = JSON.parse(c.value);
      known.set(c.name, { body: f.body ?? '', hair: f.hair ?? '', eyes: f.eyes ?? '', skin: f.skin ?? '', age: '' });
    }
    const fields = known.get(c.name);
    if (!fields || (c.field !== 'hair' && c.field !== 'body' && c.field !== 'eyes' && c.field !== 'skin')) continue;
    const text = sourceByPosition.get(c.position) ?? '';
    const source = c.clause ? storyClauses(text)[c.clause - 1] ?? '' : text;
    const old = tags(fields[c.field]), next = tags(c.value);
    if (c.field === 'body') {
      const established = old.find(t => ageBand(t)) || fields.age;
      if (established && !hasAgeCue(source)) {
        const originalAge = next.filter(t => !ageBand(t));
        next.splice(0, next.length, ...originalAge, established);
      }
      const chest = /^(?:flat chest|(?:small|medium|large|huge|gigantic) breasts)$/i;
      if (old.some(t => chest.test(t)) && !/胸(?:围|型|部|口).{0,16}(?:变|长大|缩小|隆起)|(?:bust|chest).{0,20}(?:chang|grew|shr[au]nk)/i.test(source)) {
        for (let i = next.length - 1; i >= 0; i--) if (chest.test(next[i])) next.splice(i, 1);
      }
      for (const dimension of [(t: string) => Boolean(ageBand(t)), (t: string) => chest.test(t)]) {
        const prior = old.find(dimension);
        if (prior && !next.some(dimension)) next.push(prior);
      }
    } else if (c.field === 'hair' && next.length) {
      const hairColor = (t: string) => t.replace(/^(?:very long|long|medium|short) /i, '');
      const color = /^(?:(?:dark|light|platinum|ash) )?(?:black|brown|blue|red|blonde|silver|white|pink|green|purple|gr[ae]y|auburn) hair$/i;
      const dye = /染|挑染|鬓边.{0,5}(?:白|灰)|发色.{0,9}(?:变|成)|hair.{0,12}(?:dyed|turned|chang)/i.test(source);
      const originalColor = old.map(hairColor).find(t => color.test(t));
      if (originalColor && !dye) {
        for (let i = next.length - 1; i >= 0; i--) {
          if (!color.test(hairColor(next[i]))) continue;
          const length = next[i].match(/^(very long|long|medium|short) /i)?.[1];
          next.splice(i, 1, ...(length ? [length + ' hair'] : []));
        }
        next.unshift(originalColor);
      }
      const lengthWord = /^(?:very long|long|medium|short) (?:.+ )?hair$/i;
      if (!next.some(t => lengthWord.test(t))) {
        const length = old.find(t => lengthWord.test(t))?.match(/^(very long|long|medium|short)/i)?.[0];
        if (length) next.push(length + ' hair');
      }
    } else if (c.field === 'eyes' && old.length) {
      const color = /\b(?:black|brown|blue|red|pink|purple|violet|amber|gold|green|grey|gray|silver|orange|aqua|emerald|yellow) eyes$/i;
      const changeColor = /瞳色|眼睛.{0,12}(?:变成|变为)|美瞳|eyes?.{0,12}(?:turned|changed color)/i.test(source);
      if (!changeColor && old.some(t => color.test(t))) {
        const newShape = next.filter(t => !color.test(t));
        next.splice(0, next.length, ...old.filter(t => color.test(t)), ...newShape);
      }
      const shape = /^(?:tsurime|tareme|jitome|sanpaku|big eyes)$/i;
      if (!next.some(t => shape.test(t))) next.push(...old.filter(t => shape.test(t)));
    } else if (c.field === 'skin' && old.length
      && !/变黑|晒黑|肤色.{0,9}(?:变|转)|skin.{0,12}(?:turned|changed)|got a tan/i.test(source)) {
      next.splice(0, next.length, ...old);
    }
    c.value = [...new Set(next)].join(', ');
    fields[c.field] = c.value;
  }
}
