import type { CharTagEntry } from '@/state/charTags';
import type { CharacterWardrobe } from '@/state/outfitState';
import type { ImageInsertion } from './protocol';

export const FRAME_CONTINUITY_KEY = 'bbiFrameContinuity';

export interface FrameContinuity {
  entries: CharTagEntry[];
  wardrobes: CharacterWardrobe[];
  position: string;
  clause?: number;
  step?: number;
  cast?: string[];
  promptHash?: string;
  frameId?: string;
  anchor?: ImageInsertion['anchor'];
  ages?: Record<string, string>;
}

export interface FloorContinuity {
  swipe: number;
  sourceHash: string;
  baselineHash: string;
  frames: FrameContinuity[];
}

export function captureFrame(
  shot: ImageInsertion,
  entries: CharTagEntry[],
  wardrobes: Map<string, CharacterWardrobe>,
): FrameContinuity {
  const names = new Set(shot.characters.map(character => character.name));
  const ages = Object.fromEntries(shot.characters.filter(c => c.frameAge).map(c => [c.name.toLowerCase(), c.frameAge!]));
  return {
    ...(Object.keys(ages).length ? { ages } : {}),
    position: shot.position,
    ...(shot.anchor ? { anchor: shot.anchor } : {}),
    ...(shot.clause ? { clause: shot.clause } : {}),
    ...(shot.step ? { step: shot.step } : {}),
    cast: [...names],
    entries: entries.filter(entry => names.has(entry.name)).map(entry => ({ ...entry, history: [] })),
    wardrobes: [...names].flatMap(name => wardrobes.get(name) ?? []),
  };
}

export function readFloorContinuity(raw: unknown, swipe: number, sourceHash: string, baselineHash: string): FloorContinuity | undefined {
  if (!raw || typeof raw !== 'object') return;
  const record = raw as FloorContinuity;
  if (record.swipe !== swipe || record.sourceHash !== sourceHash || record.baselineHash !== baselineHash || !Array.isArray(record.frames)) return;
  if (!record.frames.every(frame => frame && typeof frame.position === 'string' && Array.isArray(frame.entries) && Array.isArray(frame.wardrobes))) return;
  return record;
}

export function frameTextHash(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
