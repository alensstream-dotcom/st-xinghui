import { describe, expect, it } from 'vitest';
import { assembleImageCharacters } from './assemblePrompt';
import { rebaseImagePositions } from './rebase';
import { parseImagePlan } from './protocol';

const quote = '林月握住杯柄';
const later = '林月把杯子放回桌面';
const segments = [{ id: 'P1', sourceLine: 0, text: quote + '，' + later + '。' }];
const shot = {
  position: 'P1', clause: 1, anchor: quote, tag: '1girl, kitchen',
  nl: 'She has already put the cup back.',
  characters: [{ name: '林月', tag: 'girl, putting cup down', nl: 'She releases the cup.' }],
  staging: { action: [quote, 'Lin grips the cup handle'],
    event: { actor: '林月', verb: 'grips', target: 'cup handle', phase: 'contact' } },
};
const parse = (candidate: unknown) => parseImagePlan(JSON.stringify({ images: [candidate] }), segments, 1, 1, { pinSelection: true });

describe('pinned storyboard compilation', () => {
  it('keeps grounded action and strips conflicting free text', () => {
    const image = parse(shot).images[0];
    expect(image.anchor).toMatchObject({ exact: quote, start: 0, end: quote.length });
    expect(image.tag).toContain('Lin grips the cup handle');
    expect(image.nl).toBe('');
    expect(image.characters[0]).toMatchObject({ tag: 'girl', nl: '' });
  });

  it('preserves the selected action through prompt assembly and rejects a changed source', () => {
    const image = parse(shot).images[0];
    expect(assembleImageCharacters(image, [], new Map()).tag).toContain('Lin grips the cup handle');
    const moved = rebaseImagePositions('天色已经暗了。\n' + segments[0].text, segments, [image], []);
    expect(moved?.images[0].sourceLine).toBe(1);
    expect(rebaseImagePositions(later + '，' + quote + '。', segments, [image], [])).toBeNull();
  });

  it('keeps foreground POV hands without a separate male portrait', () => {
    const image = parse({ ...shot, tag: '1girl, 1boy, kitchen',
      characters: [...shot.characters, { name: '男方', tag: 'boy', nl: '' }],
      staging: { action: [quote, 'The viewer hand grips the cup handle'], camera: ['pov', ['hands']],
        event: { actor: 'viewer', verb: 'grips', target: 'cup handle', phase: 'contact' } },
    }).images[0];
    expect(image.tag).toContain('viewer hand');
    expect(image.tag).not.toContain('1boy');
    expect(image.characters.map(character => character.name)).toEqual(['林月']);
  });

  it('rejects missing evidence and a staging instruction from another moment', () => {
    expect(() => parse({ ...shot, anchor: '林月摔碎了杯子' })).toThrow('原句');
    expect(() => parse({ ...shot, staging: { ...shot.staging, action: [later, 'Lin puts down the cup'] } })).toThrow('不一致');
    expect(() => parse({ ...shot, staging: { ...shot.staging, action: [quote, 'Lin has already put the cup back'],
      event: { actor: '林月', verb: 'put', target: 'cup', phase: 'contact' } } })).toThrow('可验证');
    expect(() => parse({ ...shot, staging: { ...shot.staging, action: [quote, '@{另一人} grips the cup handle'] } })).toThrow('可验证');
  });
});
