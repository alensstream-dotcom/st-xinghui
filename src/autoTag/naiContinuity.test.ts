import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestViaMainApi } from '@/api/client';
import { NAI_STORY_EXTRA_KEY, readNaiStoryFloor, replayNaiOutfits } from '@/autoTag/naiWardrobe';
import { requestFloorTags, requestSlotTag } from '@/autoTag/runner';
import {
  BBI_CHAR_EXTRA_KEY, charTagsBeforeFloor, emptyCharFields, hydrateCharTags,
  setGlobalCharTagSource, upsertCharTag,
} from '@/state/charTags';
import { activeNaiPlan, settings } from '@/state/settings';
import type { STMessage } from '@/st/context';
import { parseImageTagContent, parseImageTags } from '@/st/imageTagRegex';

vi.mock('@/api/client', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/client')>(),
  requestViaMainApi: vi.fn(),
}));

function message(mes: string, alternate?: string): STMessage {
  const swipes = alternate === undefined ? undefined : [mes, alternate];
  return {
    mes, name: 'Narrator', is_user: false, is_system: false,
    extra: { hostExtra: true },
    ...(swipes ? { swipes, swipe_id: 0, swipe_info: [{ extra: { unrelated: true } }, {}] } : {}),
  };
}

function speak(position: string, name: string, parts: string[], tag = 'girl, looking at viewer') {
  return {
    position, tag: '1girl, classroom', size: 'portrait',
    characters: [{
      name, tag, useProfile: true, appearanceTag: 'brown hair',
      outfitParts: parts, outfitTag: parts.length ? 'generic uniform' : '',
      nl: 'She speaks to someone across the room.',
    }],
  };
}

function respond(value: object) {
  vi.mocked(requestViaMainApi).mockImplementationOnce(async (_messages, options) => {
    const raw = JSON.stringify(value);
    await options?.validate?.(raw);
    return raw;
  });
}

const kit = (name: string, position = 'P1', tag = 'navy school blazer') => ({
  name, position, kind: 'start', reason: '已经穿着制服',
  parts: [{ id: 'outerwear', tag }, { id: 'bottom', tag: 'black pleated skirt' }],
});

function profile(name: string, fields: Record<string, string> = { sex: '1girl', hair: 'black hair' }) {
  return { name, position: 'P1', field: 'new', fields, visualOptions: [] };
}

function image(floor: STMessage, seq = 0) {
  return parseImageTagContent(parseImageTags(floor.mes)[seq]);
}

const chat: STMessage[] = [];
const saveChat = vi.fn<() => Promise<void>>();
let startingSettings: { backend: typeof settings.defaultBackend; model: string; naturalLanguage: boolean;
  autoGenerate: boolean; maxImages: number; retryCount: number; minImages: number; enabled: boolean };

beforeEach(() => {
  const plan = activeNaiPlan();
  startingSettings = {
    backend: settings.defaultBackend, model: plan.model, naturalLanguage: plan.naturalLanguage,
    autoGenerate: settings.autoTag.autoGenerate, maxImages: settings.autoTag.maxImages,
    retryCount: settings.autoTag.retryCount, minImages: settings.autoTag.minImages, enabled: settings.enabled,
  };
  settings.defaultBackend = 'nai';
  settings.enabled = true;
  plan.model = 'nai-diffusion-4-5-full';
  plan.naturalLanguage = true;
  settings.autoTag.autoGenerate = false;
  settings.autoTag.maxImages = 5;
  settings.autoTag.minImages = 0;
  settings.autoTag.retryCount = 0;
  vi.mocked(requestViaMainApi).mockReset();
  saveChat.mockReset().mockResolvedValue(undefined);
  chat.length = 0;
  vi.stubGlobal('window', { SillyTavern: { getContext: () => context } });
  const context = {
    chat, name1: 'Player', name2: 'Story', chatMetadata: {},
    getCurrentChatId: () => 'nai-continuity', saveChat,
    eventSource: { on: () => undefined }, eventTypes: {},
  };
  vi.stubGlobal('document', { querySelector: () => null });
  vi.stubGlobal('toastr', { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() });
  setGlobalCharTagSource(() => []);
  hydrateCharTags();
});

afterEach(() => {
  settings.defaultBackend = startingSettings.backend;
  settings.enabled = startingSettings.enabled;
  Object.assign(activeNaiPlan(), { model: startingSettings.model, naturalLanguage: startingSettings.naturalLanguage });
  Object.assign(settings.autoTag, {
    maxImages: startingSettings.maxImages, minImages: startingSettings.minImages,
    retryCount: startingSettings.retryCount, autoGenerate: startingSettings.autoGenerate,
  });
  vi.unstubAllGlobals();
  setGlobalCharTagSource(() => []);
});

describe('NovelAI automatic illustration continuity', () => {
  it('chooses different visual details while retaining explicit colors, provenance and one prompt per character', async () => {
    const floor = message('青禾和阿梨都是黑发棕眼。两人并肩倚在窗边。');
    chat.push(floor);
    const facts = { sex: '1girl', hair: 'black hair', eyes: 'brown eyes' };
    respond({
      images: [{
        position: 'P1', tag: '2girls, classroom',
        characters: [speak('P1', '青禾', []).characters[0], speak('P1', '阿梨', []).characters[0]],
      }],
      changes: [
        { ...profile('青禾', facts), visualOptions: [{ skin: 'tan skin', extra: 'freckles', body: 'tall' }] },
        { ...profile('阿梨', facts), visualOptions: [
          { skin: 'tan skin', extra: 'freckles', body: 'tall' },
          { hair: 'blonde hair, blunt bangs', skin: 'dark skin', extra: 'round face', eyes: 'blue eyes' },
        ] },
      ],
      outfits: [],
    });
    await requestFloorTags(0);
    const characters = image(floor).characters;
    expect(characters).toEqual([
      { name: '青禾', tag: 'black hair, brown eyes, tan skin, tall, freckles, girl, looking at viewer',
        nl: 'She speaks to someone across the room.' },
      { name: '阿梨', tag: 'black hair, blunt bangs, brown eyes, dark skin, round face, girl, looking at viewer',
        nl: 'She speaks to someone across the room.' },
    ]);
    expect(floor.mes).not.toMatch(/useProfile|outfitParts|visualOptions/);
    expect(charTagsBeforeFloor(1).find(entry => entry.name === '阿梨')?.origins)
      .toMatchObject({ hair: 'mixed', eyes: 'story', skin: 'design', extra: 'design' });
    expect(vi.mocked(requestViaMainApi).mock.calls[0][0].some(msg => msg.content.includes('visualOptions 数组')))
      .toBe(true);

    respond({ images: [speak('P1', '阿梨', [])], changes: [], outfits: [] });
    await requestFloorTags(0, { replace: true });
    expect(image(floor).characters[0].tag).toBe(characters[1].tag);
    expect(charTagsBeforeFloor(1)).toHaveLength(2);
  });

  it('uses one outfit across shot sizes and floors, records no-image changes, and rewrites at the original position', async () => {
    const first = message('小雪穿深蓝制服来到教室。\n小雪抬起头。\n小雪把外套拉下了一边肩膀。', '小雪穿运动服。');
    chat.push(first);
    respond({
      images: [
        speak('P1', '小雪', ['outerwear', 'bottom']),
        speak('P2', '小雪', []),
        speak('P3', '小雪', ['outerwear', 'bottom']),
      ],
      changes: [profile('小雪'), { name: '小雪', field: 'hair', value: 'short black hair', position: 'P3' }],
      outfits: [kit('小雪'), {
        name: '小雪', position: 'P3', kind: 'adjust', reason: '拉下一边肩膀',
        parts: [{ id: 'outerwear', state: 'jacket off one shoulder' }],
      }],
    });
    await requestFloorTags(0);
    expect(image(first).characters[0].tag).toContain('navy school blazer, black pleated skirt');
    expect(image(first, 1).characters[0].tag).not.toMatch(/blazer|skirt/);
    expect(image(first, 2).characters[0].tag).toContain('navy school blazer, jacket off one shoulder, black pleated skirt');
    expect(first.swipe_info?.[0].extra).toMatchObject({ unrelated: true, [NAI_STORY_EXTRA_KEY]: {} });
    const beforeRewrite = parseImageTags(first.mes);
    const savedExtra = first.extra;

    respond({ images: [speak('P3', '小雪', ['outerwear', 'bottom'], 'girl, smile')], changes: [], outfits: [] });
    await requestSlotTag(0, 0);
    expect(image(first).characters[0].tag).toBe('black hair, girl, smile, navy school blazer, black pleated skirt');
    expect(parseImageTags(first.mes).slice(1)).toEqual(beforeRewrite.slice(1));
    expect(first.extra).toBe(savedExtra);

    const second = message('小雪把外套整理好。');
    const third = message('小雪走向门口。');
    chat.push(second, third);
    respond({
      images: [], changes: [],
      outfits: [{ name: '小雪', position: 'P1', kind: 'adjust', reason: '整理外套',
        parts: [{ id: 'outerwear', state: '' }] }],
    });
    await requestFloorTags(1);
    expect(parseImageTags(second.mes)).toHaveLength(0);
    expect(readNaiStoryFloor(second)?.outfits).toHaveLength(1);
    respond({ images: [speak('P1', '小雪', ['outerwear', 'bottom'])], changes: [], outfits: [] });
    await requestFloorTags(2);
    expect(image(third).characters[0].tag)
      .toBe('short black hair, girl, looking at viewer, navy school blazer, black pleated skirt');
    expect(replayNaiOutfits(chat, chat.length, '小雪').history).toHaveLength(3);

    first.swipe_id = 1;
    first.mes = first.swipes![1];
    expect(replayNaiOutfits(chat, chat.length, '小雪').outfits.has('小雪')).toBe(false);
    first.swipe_id = 0;
    first.mes = first.swipes![0];
    expect(replayNaiOutfits(chat, chat.length, '小雪').outfits.get('小雪')?.[0].tag).toBe('navy school blazer');
    first.mes = '正文已经编辑掉了原来的换装依据。';
    expect(replayNaiOutfits(chat, chat.length, '小雪').outfits.has('小雪')).toBe(false);
  });

  it('rolls back both extra keys, the active swipe record and the story if saving fails', async () => {
    const floor = message('小雪穿制服走来。', '另一条剧情。');
    chat.push(floor);
    const before = structuredClone(floor);
    saveChat.mockRejectedValueOnce(new Error('disk error'));
    vi.spyOn(console, 'error').mockImplementationOnce(() => undefined);
    respond({
      images: [speak('P1', '小雪', ['outerwear'])], changes: [profile('小雪')], outfits: [kit('小雪')],
    });
    await requestFloorTags(0);
    expect(saveChat).toHaveBeenCalledOnce();
    expect(floor).toEqual(before);
    expect(toastr.error).toHaveBeenCalled();
  });

  it('keeps legacy caption output, drops disabled NL, and ignores new keys entirely on other backends', async () => {
    const first = message('她在教室等候。');
    const second = message('她走出教室。');
    chat.push(first, second);
    activeNaiPlan().naturalLanguage = false;
    const legacyTag = 'girl, long brown hair, white blouse, looking away';
    respond({ images: [{ position: 'P1', tag: '1girl', characters: [
      { name: '小雪', tag: legacyTag, nl: 'Legacy description.' },
    ] }], changes: [] });
    await requestFloorTags(0);
    expect(image(first).characters).toEqual([{ name: '小雪', tag: legacyTag, nl: '' }]);

    settings.defaultBackend = 'comfyui';
    respond({ images: [speak('P1', '小雪', ['outerwear'])], changes: [profile('小雪')], outfits: [kit('小雪')] });
    await requestFloorTags(1);
    expect(second.extra).not.toHaveProperty(NAI_STORY_EXTRA_KEY);
    expect(second.extra).not.toHaveProperty(BBI_CHAR_EXTRA_KEY);
    expect(image(second).characters[0].tag).toBe('girl, looking at viewer');
    expect(vi.mocked(requestViaMainApi).mock.calls[1][0].some(msg => msg.content.includes('visualOptions 数组')))
      .toBe(false);
  });

  it('keeps per-field source labels for untouched fields after an explicit manual correction', async () => {
    chat.push(message('小雪有红瞳。'));
    respond({ images: [], changes: [{ ...profile('小雪', { sex: '1girl', eyes: 'red eyes' }),
      visualOptions: [{ hair: 'silver hair, long hair' }] }], outfits: [] });
    await requestFloorTags(0);
    const [entry] = charTagsBeforeFloor(1);
    expect(entry.origins).toEqual({ eyes: 'story', hair: 'design' });
    expect(upsertCharTag({ ...entry, fields: { ...entry.fields, hair: 'short black hair' }, source: 'manual' }, '小雪'))
      .toBe(true);
    expect(charTagsBeforeFloor(1)[0].origins).toEqual({ eyes: 'story' });
  });

  it('keeps locked profiles and brief male captions while applying an explicit change of outfit on V5', async () => {
    activeNaiPlan().model = 'nai-diffusion-5-full';
    setGlobalCharTagSource(() => [{
      ...{ name: '小雪', raw: '', nl: '', desc: '', history: [] },
      fields: { ...emptyCharFields(), sex: '1girl', hair: 'silver hair' }, source: 'manual',
    }]);
    const floor = message('小雪穿制服走来。\n她换了件深绿长袍后与他说话。');
    chat.push(floor);
    const first = speak('P1', '小雪', ['outerwear']);
    first.characters[0] = { ...first.characters[0], temporaryFields: ['hair'] } as typeof first.characters[number];
    const second = speak('P2', '小雪', ['outerwear']);
    const boy = { name: '守卫', tag: 'boy, listening', nl: 'He listens.' };
    respond({
      images: [first, { ...second, tag: '1girl, 1boy', characters: [...second.characters, boy] }],
      changes: [
        { name: '小雪', field: 'hair', value: 'red hair', position: 'P1' },
        profile('守卫', { sex: '1boy' }),
      ],
      outfits: [
        kit('小雪'),
        { name: '小雪', position: 'P2', kind: 'change', reason: '换了件深绿长袍',
          parts: [{ id: 'outerwear', tag: 'dark green embroidered robe' }] },
      ],
    });
    await requestFloorTags(0);
    expect(image(floor).characters[0].tag).toBe('silver hair, girl, looking at viewer, navy school blazer');
    expect(image(floor, 1).characters[0].tag).toBe('silver hair, girl, looking at viewer, dark green embroidered robe');
    expect(image(floor, 1).characters[1]).toEqual(boy);
    expect(floor.extra).not.toHaveProperty(BBI_CHAR_EXTRA_KEY);
    expect(charTagsBeforeFloor(1).map(entry => entry.name)).toEqual(['小雪']);
  });
});
