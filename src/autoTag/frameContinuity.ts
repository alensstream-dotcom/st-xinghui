import type { CharTagEntry } from '@/state/charTags';
import type { CharacterWardrobe } from '@/state/outfitState';
import type { ImageInsertion } from './protocol';

export const FRAME_CONTINUITY_KEY = 'bbiFrameContinuity';

export interface FrameContinuity {
  entries: CharTagEntry[];
  wardrobes: CharacterWardrobe[];
  position: string;
  promptHash?: string;
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
  return {
    position: shot.position,
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
