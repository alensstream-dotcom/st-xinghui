import type { CharTagEntry } from '@/state/charTags';
import type { CharChange, ImageInsertion } from './protocol';

export const RELATION_TAG = /^(?:(?:older|younger|little|big|adult|eldest) )?(?:daughter|mother|sister|son|father|brother)s?$/i;
export const hasAgeCue = (text: string) => /成年|长大后|老年|年幼|童年|小时候|幼年|[岁歲]时|(?:十|[0-9]|[一二三四五六七八九])多?[岁歲]|\b(?:childhood|as a child|as an adult|grown up|long since grown|[0-9]+ years? old)\b/i.test(text);

const tags = (text: string) => text.split(',').map(s => s.trim()).filter(Boolean);

export function ageBand(tag = ''): string {
  const numeric = tag.match(/^(\d{1,3})[ -](?:years?[ -]old|yo)(?: (?:girl|boy|woman|man|female|male))?$/i);
  if (numeric) return +numeric[1] < 13 ? 'child' : +numeric[1] < 18 ? 'teen' : 'adult';
  if (/^(?:child|little girl|little boy|female child|male child|young child|toddler|baby|preteen|loli|shota)$/i.test(tag)) return 'child';
  if (/^(?:teen|teenager|teenage (?:girl|boy)|adolescent)$/i.test(tag)) return 'teen';
  if (/^(?:(?:young |middle-aged |elderly )?adult(?: woman| man| female| male)?|(?:mature|middle-aged|elderly|old) (?:woman|man|female|male)|young (?:woman|man))$/i.test(tag)) return 'adult';
  return '';
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
  const childrenInView = image.characters.filter(c => ageBand(c.frameAge ?? profileAge(onScreen.find(e => e.name === c.name))) === 'child');
  const daughters = [...new Set(relatives.get('daughter') ?? [])];
  const clearRelationalAge = !childrenInView.length && daughters.length === 1;
  const resolve = (text: string) => text
    .replace(/\b(?:the|her|his|their) (?:little girl|young child)\b/gi, original =>
      clearRelationalAge ? labels.get(daughters[0]) ?? original : original)
    .replace(/\b(?:the|her|his|their) (?:adult |younger |older |little )?(daughter|mother|sister|brother|son|father)\b/gi, (original, role: string) => {
      const matches = relatives.get(role.toLowerCase());
      return matches?.length === 1 ? labels.get(matches[0]) ?? original : original;
    })
    .replace(token, (_match, bracket, plain) => labels.get(bracket ?? plain) ?? 'the person');
  return { ...image, tag: resolve(tags(image.tag).filter(t => !RELATION_TAG.test(t)).join(', ')), nl: resolve(image.nl), characters: image.characters.map(c => {
    const known = ageBand(c.frameAge ?? profileAge(onScreen.find(e => e.name === c.name)));
    const own = tags(c.tag).filter(t => t !== '@' + c.name && t !== '@{' + c.name + '}' && !RELATION_TAG.test(t)
      && !((known || clearRelationalAge && c.name === daughters[0]) && ageBand(t) && known !== ageBand(t)));
    if (c.frameAge && !own.includes(c.frameAge)) own.push(c.frameAge);
    return { ...c, tag: resolve(own.join(', ')), nl: resolve(c.nl) };
  }) };
}

/** 同一字段的局部变化不应抹掉独立且已确认的体征。只用于新生成的自动档案操作。 */
export function retainUnchangedTraits(changes: CharChange[], entries: CharTagEntry[], sourceByPosition: ReadonlyMap<string, string>): void {
  const known = new Map(entries.map(e => [e.name, { body: e.fields.body, hair: e.fields.hair }]));
  for (const c of [...changes].sort((a, b) => a.sourceLine - b.sourceLine)) {
    if (c.field === 'new' && c.value.startsWith('{') && !known.has(c.name)) {
      const f = JSON.parse(c.value);
      known.set(c.name, { body: f.body ?? '', hair: f.hair ?? '' });
    }
    const fields = known.get(c.name);
    if (!fields || (c.field !== 'hair' && c.field !== 'body')) continue;
    const old = tags(fields[c.field]), next = tags(c.value);
    if (c.field === 'body') {
      const established = old.find(t => ageBand(t));
      if (established && !hasAgeCue(sourceByPosition.get(c.position) ?? '')) {
        const originalAge = next.filter(t => !ageBand(t));
        next.splice(0, next.length, ...originalAge, established);
      }
      const chest = /^(?:flat chest|(?:small|medium|large|huge|gigantic) breasts)$/i;
      for (const dimension of [(t: string) => Boolean(ageBand(t)), (t: string) => chest.test(t)]) {
        const prior = old.find(dimension);
        if (prior && !next.some(dimension)) next.push(prior);
      }
    } else if (next.length && next.every(t => /\b(?:bangs|bun|ponytail|braids?|bob|twintails)\b|^(?:very long|long|medium|short|curly|straight|wavy) hair$/i.test(t))) {
      const color = old.map(t => t.replace(/^(?:very long|long|medium|short) /i, '')).find(t =>
        /^(?:(?:dark|light|platinum) )?(?:black|brown|blue|red|blonde|silver|white|pink|green|purple|gr[ae]y|auburn) hair$/i.test(t));
      if (color) next.unshift(color);
    }
    c.value = next.join(', ');
    fields[c.field] = c.value;
  }
}
