import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BBI_WORLD_ANCHOR_KEY,
  WORLD_PRESETS,
  WORLD_PRESET_IDS,
  applyDetectedWorldPreset,
  defaultWorldAnchor,
  isWorldPresetId,
  portraitAttireFor,
  readWorldAnchor,
  saveWorldAnchor,
  selectWorldPreset,
  toCustomWorldAnchor,
  worldAnchorBlock,
  type WorldAnchorConfig,
} from '@/state/worldAnchor';

const chatMetadata: Record<string, unknown> = {};
const saveMetadataDebounced = vi.fn();

vi.mock('@/st/context', () => ({
  getContext: () => ({ chatMetadata, saveMetadataDebounced }),
}));

function resetMeta() {
  for (const key of Object.keys(chatMetadata)) delete chatMetadata[key];
  saveMetadataDebounced.mockClear();
}

describe('世界观锚点', () => {
  beforeEach(resetMeta);

  it('六个内置预设都齐全且字段完整', () => {
    expect(WORLD_PRESET_IDS).toHaveLength(6);
    for (const id of WORLD_PRESET_IDS) {
      const preset = WORLD_PRESETS[id];
      expect(isWorldPresetId(id)).toBe(true);
      expect(preset.label.trim()).toBeTruthy();
      expect(preset.characterGuidelines.trim()).toBeTruthy();
      expect(preset.outfitMappingHint.trim()).toBeTruthy();
      expect(preset.portraitAttire.trim()).toBeTruthy();
      // 预设表本身不带锁定态:锁定只记在 chatMetadata 里
      expect('lockedByUser' in preset).toBe(false);
    }
    expect(isWorldPresetId('custom')).toBe(false);
    expect(isWorldPresetId('nope')).toBe(false);
  });

  it('没存过时读出未锁定的现代默认', () => {
    const world = readWorldAnchor();
    expect(world.presetId).toBe('modern');
    expect(world.lockedByUser).toBe(false);
  });

  it('手动选预设即锁定并写入聊天元数据', () => {
    const world = selectWorldPreset('chinese_ancient');
    expect(world.lockedByUser).toBe(true);
    expect(world.label).toContain('古风');
    expect((chatMetadata[BBI_WORLD_ANCHOR_KEY] as WorldAnchorConfig).presetId).toBe('chinese_ancient');
    expect(saveMetadataDebounced).toHaveBeenCalled();
  });

  it('用户锁定后,首楼自动识别不得覆盖', () => {
    selectWorldPreset('scifi_cyberpunk');
    const after = applyDetectedWorldPreset('chinese_ancient');
    expect(after.presetId).toBe('scifi_cyberpunk');
    expect(readWorldAnchor().presetId).toBe('scifi_cyberpunk');
  });

  it('未锁定时按识别结果落地,非法值保持原样', () => {
    expect(applyDetectedWorldPreset('western_fantasy').presetId).toBe('western_fantasy');
    expect(readWorldAnchor().presetId).toBe('western_fantasy');
    expect(applyDetectedWorldPreset('garbage').presetId).toBe('western_fantasy');
    expect(applyDetectedWorldPreset(undefined).presetId).toBe('western_fantasy');
  });

  it('自定义世界观保留用户自由文本并保持锁定', () => {
    const custom = toCustomWorldAnchor({
      ...defaultWorldAnchor(),
      characterGuidelines: '古代东方,无现代科技',
      outfitMappingHint: '现代单品换成汉服',
      portraitAttire: 'plain white traditional hanfu',
      negativeGuardrails: 'jeans, sneakers',
    });
    expect(custom.presetId).toBe('custom');
    expect(custom.lockedByUser).toBe(true);
    const stored = readWorldAnchor();
    expect(stored.presetId).toBe('custom');
    expect(stored.portraitAttire).toBe('plain white traditional hanfu');
    expect(stored.negativeGuardrails).toBe('jeans, sneakers');
  });

  it('系统提示块带上标签、边界、映射与防穿帮负面', () => {
    const block = worldAnchorBlock({ ...WORLD_PRESETS.chinese_ancient, lockedByUser: true });
    expect(block).toContain('世界观');
    expect(block).toContain('用户已锁定');
    expect(block).toContain('服装映射');
    expect(block).toContain('jeans');
  });

  it('立绘素服优先角色自己的固定常服', () => {
    const world = { ...WORLD_PRESETS.chinese_ancient, lockedByUser: true };
    expect(portraitAttireFor(world, 'white blouse, black skirt')).toBe('white blouse, black skirt');
    expect(portraitAttireFor(world, '')).toBe(WORLD_PRESETS.chinese_ancient.portraitAttire);
    expect(portraitAttireFor({ ...world, portraitAttire: '  ' }, '')).toBe(WORLD_PRESETS.modern.portraitAttire);
  });

  it('写回时深拷贝,外部改对象不会污染元数据', () => {
    const world = { ...WORLD_PRESETS.modern, lockedByUser: true, label: '现代都市' };
    saveWorldAnchor(world);
    world.label = '被改坏';
    expect((chatMetadata[BBI_WORLD_ANCHOR_KEY] as WorldAnchorConfig).label).toBe('现代都市');
  });
});