import type { CharFieldOrigins, CharTagEntry, CharTagField } from '@/state/charTags';

export const NAI_VISUAL_FIELDS = ['hair', 'eyes', 'skin', 'body', 'extra'] as const;
export type NaiVisualField = (typeof NAI_VISUAL_FIELDS)[number];
export type NaiVisualFields = Partial<Record<NaiVisualField, string>>;

const COLORS = 'black|brown|blond|blonde|red|orange|pink|purple|blue|green|white|silver|gray|grey|auburn|amber|hazel|violet|gold|golden';
const HAIR_COLOR = new RegExp(`\\b(?:${COLORS})(?= (?:\\w+ ){0,3}hair\\b)`, 'gi');
const EYE_COLOR = new RegExp(`\\b(?:${COLORS})(?= eyes?\\b)`, 'gi');
const HAIR_LENGTH = /\b(?:very long|long|medium(?: length)?|short)(?= (?:\w+ ){0,3}hair\b)/gi;
const SKIN_TONE = /\b(?:very dark|dark|brown|tan|tanned|olive|fair|pale|light)(?= skin\b)/gi;

export function naiTagParts(value: string): string[] {
  return value.split(',').map(part => part.trim()).filter(Boolean);
}

function key(part: string): string {
  return part.toLowerCase().replace(/[_-]/g, ' ').trim().split(/\s+/).sort().join(' ');
}

export function joinNaiTags(values: readonly string[]): string {
  const seen = new Set<string>();
  return values.flatMap(naiTagParts).filter(part => {
    const id = key(part);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }).join(', ');
}

export function parseNaiVisualOptions(raw: unknown): NaiVisualFields[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 3).flatMap(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const fields: NaiVisualFields = {};
    for (const field of NAI_VISUAL_FIELDS) {
      const value = (candidate as Record<string, unknown>)[field];
      if (typeof value !== 'string') continue;
      const parts = naiTagParts(value).slice(0, 4);
      if (parts.length && parts.every(part => /^[a-z][a-z0-9 _'-]{0,59}$/i.test(part))) {
        fields[field] = joinNaiTags(parts);
      }
    }
    return Object.keys(fields).length ? [fields] : [];
  });
}

function traits(text: string, pattern: RegExp): Set<string> {
  return new Set(Array.from(text.matchAll(pattern), match => key(match[0])));
}

function conflicts(fact: string, proposed: string, pattern: RegExp): boolean {
  const existing = traits(fact, pattern);
  return existing.size > 0 && [...traits(proposed, pattern)].some(value => !existing.has(value));
}

function mergeOption(
  facts: Record<CharTagField, string>,
  option: NaiVisualFields,
): { fields: Record<CharTagField, string>; origins: CharFieldOrigins } {
  const fields = { ...facts };
  const origins: CharFieldOrigins = {};
  for (const field of NAI_VISUAL_FIELDS) {
    const fact = facts[field];
    const patterns = field === 'hair' ? [HAIR_COLOR, HAIR_LENGTH]
      : field === 'eyes' ? [EYE_COLOR]
        : field === 'skin' ? [SKIN_TONE] : [];
    const proposed = naiTagParts(option[field] ?? '').filter(part =>
      !patterns.some(pattern => conflicts(fact, part, pattern)),
    );
    fields[field] = joinNaiTags([fact, ...proposed]);
    if (fields[field]) {
      origins[field] = !fact ? 'design' : fields[field] === joinNaiTags([fact]) ? 'story' : 'mixed';
    }
  }
  return { fields, origins };
}

function fingerprint(fields: Record<CharTagField, string>): Set<string> {
  const tags = new Set(NAI_VISUAL_FIELDS.flatMap(field => naiTagParts(fields[field])
    .map(part => `${field}:${key(part)}`)));
  for (const [prefix, value, pattern] of [
    ['hair-color', fields.hair, HAIR_COLOR],
    ['hair-length', fields.hair, HAIR_LENGTH],
    ['eye-color', fields.eyes, EYE_COLOR],
    ['skin-tone', fields.skin, SKIN_TONE],
  ] as const) {
    for (const match of traits(value, pattern)) tags.add(`${prefix}:${match}`);
  }
  return tags;
}

/** Give the nearest lookalike the most weight, including profiles added earlier in this response. */
export function chooseNaiAppearance(
  facts: Record<CharTagField, string>,
  options: readonly NaiVisualFields[],
  existing: readonly Pick<CharTagEntry, 'fields'>[],
): { fields: Record<CharTagField, string>; origins: CharFieldOrigins } {
  const others = existing.map(entry => fingerprint(entry.fields));
  let best = mergeOption(facts, {});
  let bestScore = Infinity;
  for (const option of options.length ? options : [{}]) {
    const candidate = mergeOption(facts, option);
    const tags = fingerprint(candidate.fields);
    const additions = NAI_VISUAL_FIELDS.filter(field => candidate.origins[field] === 'design' ||
      candidate.origins[field] === 'mixed').length;
    // Empty (e.g. all proposed tags contradict supplied facts) must not win over a usable option.
    const scores = others.map(other => {
      const shared = [...tags].filter(tag => other.has(tag)).length;
      return (2 * shared) / Math.max(1, tags.size + other.size);
    });
    const score = Math.max(0, ...scores) + 0.025 * scores.reduce((sum, value) => sum + value, 0)
      - Math.min(additions, 4) * 0.05 + (options.length && !additions ? 2 : 0);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}
