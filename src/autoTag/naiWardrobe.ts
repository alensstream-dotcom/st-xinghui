import type { TargetSegment } from '@/autoTag/clean';
import type { STMessage } from '@/st/context';
import { IMAGE_TAG_FIND_REGEX, stripImageTags } from '@/st/imageTagRegex';

export const NAI_STORY_EXTRA_KEY = 'bbiNaiStory';

export interface OutfitPart {
  id: string;
  tag: string;
  state: string;
}

interface OutfitAdjustment {
  id: string;
  state: string;
}

interface OutfitChangeBase {
  name: string;
  sourceLine: number;
  reason: string;
}

export type OutfitChange = OutfitChangeBase & (
  | { kind: 'start' | 'change'; parts: OutfitPart[] }
  | { kind: 'adjust'; parts: OutfitAdjustment[] }
);

type SavedOutfitChange = Exclude<OutfitChange, { kind: 'adjust' }> | (OutfitChangeBase & {
  kind: 'adjust';
  parts: Array<OutfitAdjustment & { previous: OutfitPart }>;
});

export interface NaiStoryFloor {
  v: 1;
  swipe: number;
  source: string;
  outfits: SavedOutfitChange[];
}

export interface OutfitRecord {
  floor: number;
  sourceLine: number;
  reason: string;
  parts: OutfitPart[];
}

type Outfits = Map<string, OutfitPart[]>;

export function storyTextHash(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function plain(value: unknown, max: number): string {
  return typeof value === 'string' && !/[<>\r\n]/.test(value) ? value.trim().slice(0, max) : '';
}

function outfitTag(value: unknown): string {
  const tag = plain(value, 160);
  return /^[a-z0-9][a-z0-9 ,_'/-]*$/i.test(tag) ? tag : '';
}

function partId(value: unknown): string {
  const id = plain(value, 30).toLowerCase();
  return /^[a-z][a-z0-9_-]*$/.test(id) ? id : '';
}

function stateTag(value: unknown): string | null {
  if (value === undefined || value === '') return '';
  const tag = outfitTag(value);
  if (!tag) return null;
  return tag.toLowerCase() === 'worn' ? '' : tag.toLowerCase() === 'removed' ? 'removed' : tag;
}

export function parseOutfitPartIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 16) return undefined;
  const ids = value.map(partId);
  return ids.every(Boolean) ? [...new Set(ids)] : undefined;
}

function parsedParts<T extends { id: string }>(raw: unknown, parse: (value: unknown) => T | null): T[] {
  if (!Array.isArray(raw) || raw.length > 16) return [];
  const parts: T[] = [];
  for (const input of raw) {
    const part = parse(input);
    // A corrupt full outfit must never silently drop garments and become the new baseline.
    if (!part || parts.some(existing => existing.id === part.id)) return [];
    parts.push(part);
  }
  return parts;
}

function parseAdjustment(raw: unknown): OutfitAdjustment | null {
  const part = object(raw);
  const id = partId(part.id);
  const state = stateTag(part.state);
  return id && typeof part.state === 'string' && state !== null ? { id, state } : null;
}

function parsePart(raw: unknown): OutfitPart | null {
  const part = object(raw);
  const id = partId(part.id);
  const tag = outfitTag(part.tag);
  const state = stateTag(part.state);
  return id && tag && state !== null ? { id, tag, state } : null;
}

export function parseOutfitChanges(raw: unknown, segments: readonly TargetSegment[]): OutfitChange[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const positions = new Map(segments.map(segment => [segment.id, segment.sourceLine]));
  return raw.slice(0, 64).flatMap((value): OutfitChange[] => {
    const item = object(value);
    const name = plain(item.name, 160);
    const sourceLine = positions.get(plain(item.position, 20).toUpperCase());
    if (!name || sourceLine === undefined) return [];
    const base = { name, sourceLine, reason: plain(item.reason, 200) };
    if (item.kind === 'adjust') {
      const parts = parsedParts(item.parts, parseAdjustment);
      return parts.length ? [{ ...base, kind: item.kind, parts }] : [];
    }
    if (item.kind !== 'start' && item.kind !== 'change') return [];
    const parts = parsedParts(item.parts, parsePart);
    return parts.length ? [{ ...base, kind: item.kind, parts }] : [];
  }).sort((left, right) => left.sourceLine - right.sourceLine);
}

function samePart(left: OutfitPart, right: OutfitPart): boolean {
  return left.id === right.id && left.tag === right.tag && left.state === right.state;
}

function applyOutfit(outfits: Outfits, change: SavedOutfitChange): OutfitPart[] | undefined {
  const previous = outfits.get(change.name);
  let next: OutfitPart[];
  if (change.kind === 'adjust') {
    if (!previous || !change.parts.every(update => previous.some(part => samePart(part, update.previous)))) {
      return undefined;
    }
    next = previous.map(part => {
      const update = change.parts.find(candidate => candidate.id === part.id);
      return update ? { ...part, state: update.state } : part;
    });
  } else {
    if (change.kind === 'start' && previous) return undefined;
    next = change.parts;
  }
  if (previous?.length === next.length && next.every(part => previous.some(old => samePart(old, part)))) {
    return undefined;
  }
  outfits.set(change.name, next);
  return next;
}

/** Make relative wear-state edits safe to replay after an earlier swipe or floor changes. */
export function prepareOutfitChanges(before: Outfits, changes: OutfitChange[], eligible: ReadonlySet<string>): SavedOutfitChange[] {
  const outfits = new Map(before);
  const saved: SavedOutfitChange[] = [];
  for (const change of changes) {
    if (!eligible.has(change.name)) continue;
    if (change.kind !== 'adjust') {
      if (applyOutfit(outfits, change)) saved.push(change);
      continue;
    }
    const previousParts = outfits.get(change.name);
    const parts = change.parts.flatMap(part => {
      const previous = previousParts?.find(candidate => candidate.id === part.id);
      return previous ? [{ ...part, previous }] : [];
    });
    if (!parts.length || parts.length !== change.parts.length) continue;
    const adjusted = { ...change, parts };
    if (applyOutfit(outfits, adjusted)) saved.push(adjusted);
  }
  return saved;
}

/** Read only the active swipe and the text from which the state was obtained. */
export function readNaiStoryFloor(message: STMessage | undefined): NaiStoryFloor | undefined {
  if (!message) return undefined;
  const swipe = message.swipe_id ?? 0;
  const active = object(message.extra?.[NAI_STORY_EXTRA_KEY]);
  const raw = active.swipe === swipe ? active : object(message.swipe_info?.[swipe]?.extra?.[NAI_STORY_EXTRA_KEY]);
  if (raw.v !== 1 || raw.swipe !== swipe || !Array.isArray(raw.outfits)) return undefined;
  if (raw.source !== storyTextHash(stripImageTags(message.mes))) return undefined;
  const outfits = raw.outfits.slice(0, 64).flatMap((value): SavedOutfitChange[] => {
    const item = object(value);
    const name = plain(item.name, 160);
    if (!name || typeof item.sourceLine !== 'number' || !Number.isInteger(item.sourceLine) || item.sourceLine < 0) return [];
    const base = { name, sourceLine: item.sourceLine, reason: plain(item.reason, 200) };
    if (item.kind === 'adjust') {
      const parts = parsedParts(item.parts, rawPart => {
        const adjustment = parseAdjustment(rawPart);
        const previous = parsePart(object(rawPart).previous);
        return adjustment && previous?.id === adjustment.id ? { ...adjustment, previous } : null;
      });
      return parts.length ? [{ ...base, kind: item.kind, parts }] : [];
    }
    if (item.kind !== 'start' && item.kind !== 'change') return [];
    const parts = parsedParts(item.parts, parsePart);
    return parts.length ? [{ ...base, kind: item.kind, parts }] : [];
  }).sort((left, right) => left.sourceLine - right.sourceLine);
  return { v: 1, swipe, source: raw.source, outfits };
}

export function outfitsAtPosition(before: Outfits, changes: readonly SavedOutfitChange[], line: number): Outfits {
  const outfits = new Map(before);
  for (const change of changes) {
    if (change.sourceLine > line) break;
    applyOutfit(outfits, change);
  }
  return outfits;
}

export function replayNaiOutfits(chat: readonly STMessage[], before: number, forName?: string) {
  const outfits: Outfits = new Map();
  const history: OutfitRecord[] = [];
  for (let floor = 0; floor < Math.min(chat.length, before); floor += 1) {
    for (const change of readNaiStoryFloor(chat[floor])?.outfits ?? []) {
      if (forName !== undefined && change.name !== forName) continue;
      const parts = applyOutfit(outfits, change);
      if (parts && change.name === forName) {
        history.push({ floor, sourceLine: change.sourceLine, reason: change.reason, parts });
        if (history.length > 8) history.shift();
      }
    }
  }
  return { outfits, history };
}

export function formatNaiOutfits(outfits: Outfits): string {
  if (!outfits.size) return '';
  return `【本聊天已定的临时服装（只读）】\n${JSON.stringify([...outfits].map(([name, parts]) => ({ name, parts })))}`;
}

/** Match the original insertion point even when a floor contains several images or repeated tags. */
export function naiSlotSourceLine(text: string, seq: number): number | undefined {
  const tag = [...text.matchAll(IMAGE_TAG_FIND_REGEX)][seq];
  if (!tag || tag.index === undefined) return undefined;
  const preceding = stripImageTags(text.slice(0, tag.index)).replace(/(?:\r\n|\n|\r)$/, '');
  return (preceding.match(/\r\n|\n|\r/g) ?? []).length;
}
