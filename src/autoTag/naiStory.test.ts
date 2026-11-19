import { describe, expect, it } from 'vitest';

import { naiStoryProfiles } from '@/autoTag/naiStory';
import {
  createCharTagNewOp,
  createCharTagSetOp,
  emptyCharFields,
  type CharTagEntry,
} from '@/state/charTags';

describe('existing NovelAI story profiles', () => {
  it('preserves old male operations when reanalyzing the same swipe', () => {
    const known: CharTagEntry = {
      name: '陆砚', raw: '1boy, brown eyes', nl: '', fields: emptyCharFields(),
      source: 'manual', desc: '', history: [],
    };
    const archivedMale = createCharTagNewOp({
      name: '韩简', fields: { ...emptyCharFields(), sex: '1boy' }, raw: '', nl: '', source: 'ai', desc: '',
    }, 'previous archive')!;
    const archivedUpdate = createCharTagSetOp('陆砚', 'hair', 'short brown hair', 'previous change')!;
    const femaleUpdate = createCharTagSetOp('林汐', 'outfit', 'blue uniform', 'female change')!;
    const delta = { v: 1 as const, swipe: 2, ops: [archivedUpdate, femaleUpdate, archivedMale] };

    const active = naiStoryProfiles([known], delta, 2);
    expect([...active.maleNames]).toEqual(['陆砚', '韩简']);
    expect(active.previousMaleOps).toEqual([archivedUpdate, archivedMale]);
    expect(naiStoryProfiles([known], delta, 1).previousMaleOps).toEqual([]);
  });
});
