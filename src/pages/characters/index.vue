<script setup lang="ts">
import BbiTextarea from '@/components/BbiTextarea.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { generateCharTags } from '@/autoTag/charAnchors';
import { generateCharacterPortrait } from '@/autoTag/portrait';
import { rerollCharacterAppearance } from '@/autoTag/rerollChar';
import { deletePortrait, readPortraitUrl } from '@/state/portraits';
import { readBookMemory } from '@/autoTag/bookMemory';
import {
  CHAR_TAG_FIELDS,
  CHAR_TAG_FIELD_LABELS,
  buildEntryTag,
  charTagBaseNames,
  charTagLib,
  emptyCharFields,
  findCharTag,
  removeCharTag,
  rollbackCharTag,
  upsertCharTag,
  type CharTagChangeRecord,
  type CharTagEntry,
  type CharTagField,
} from '@/state/charTags';
import {
  copyGlobalCharTagToChat,
  globalCharTagLib,
  promoteCharTagToGlobal,
  removeGlobalCharTag,
  upsertGlobalCharTag,
} from '@/state/globalCharTags';
import { getContext } from '@/st/context';
import { applyMessageText } from '@/st/messageEdit';
import {
  BBI_OUTFIT_EXTRA_KEY,
  deriveOutfitSnapshots,
  readOutfitFloorDelta,
  type CharOutfitSnapshot,
} from '@/state/outfitState';
import {
  WORLD_PRESETS,
  WORLD_PRESET_IDS,
  readWorldAnchor,
  saveWorldAnchor,
  selectWorldPreset,
  toCustomWorldAnchor,
  type WorldAnchorConfig,
} from '@/state/worldAnchor';
import { computed, ref, watch } from 'vue';

/**
 * 角色管理 —— 两层固定外貌库:
 * - 全局库:跨所有聊天生效的只读模板,AI 永不修改,仅手动维护(适合玩家角色等固定形象)。
 * - 本聊天库:仅当前聊天,星绘书自动建档、AI 随剧情变更;同名时优先于全局。
 * 外貌按字段记录(sex/hair/eyes/...),拼接结果即最终 tag;生成 tag 时 AI 照抄库中字段,
 * 残留的 @角色名 占位符由插件兜底替换 —— 外貌稳定不漂移。
 */

type Scope = 'chat' | 'global';

interface Draft {
  name: string;
  fields: Record<CharTagField, string>;
  raw: string;
  nl: string;
}

// editingName:正在编辑的已有条目名;null = 新建。弹窗开关以 draft 是否存在为准。
const editingName = ref<string | null>(null);
// editingScope:被编辑条目所在层;draftScope:草稿保存到哪层(仅新建时可选)。
const editingScope = ref<Scope>('chat');
const draftScope = ref<Scope>('chat');
const draft = ref<Draft | null>(null);
// 草稿来源:手改内容即转 manual;「从星绘书重新生成」后转 book。
const draftSource = ref<CharTagEntry['source']>('manual');
const draftDesc = ref('');
const regenerating = ref(false);
// 弹窗内历史面板开关
const historyOpen = ref(false);
// 回滚确认
const confirmRollbackOpen = ref(false);
const pendingRollback = ref<{ name: string; record: CharTagChangeRecord } | null>(null);

const FIELD_PLACEHOLDERS: Record<CharTagField, string> = {
  fandom: '同人角色填: character name (copyright name), 不带转义括号; 原创留空',
  sex: '如 1girl / 1boy',
  hair: '如 long black hair',
  eyes: '如 red eyes',
  skin: '如 pale skin(可不填)',
  body: '如 petite, small breasts',
  extra: '如 heterochromia(可不填)',
  outfit: '固定着装,可不填',
};

/** 全局库名字集(响应式),用于分区与「覆盖」徽标。 */
const globalNameSet = computed(() => new Set(globalCharTagLib.entries.map(entry => entry.name)));

/**
 * 本聊天分区 = 派生库里「属于本聊天」的条目:
 * 本聊天基线里的(含覆盖全局的同名条目)+ 非全局的(AI 楼层建档等)。
 * 纯全局条目只出现在全局分区。
 */
const chatEntries = computed(() =>
  charTagLib.entries.filter(
    entry => charTagBaseNames.has(entry.name) || !globalNameSet.value.has(entry.name),
  ),
);

/** 是否整串模式:有 raw 且没有字段。 */
const draftIsRaw = computed(
  () => !!draft.value && !!draft.value.raw.trim() && CHAR_TAG_FIELDS.every(f => !draft.value!.fields[f].trim()),
);

const previewTag = computed(() => {
  const d = draft.value;
  if (!d) return '';
  return buildEntryTag({ fields: d.fields, raw: d.raw });
});

/** 正在编辑的本聊天条目的实时历史(回滚后随之刷新);全局条目不记历史。 */
const editingHistory = computed<CharTagChangeRecord[]>(() => {
  if (!editingName.value || editingScope.value !== 'chat') return [];
  return findCharTag(editingName.value)?.history ?? [];
});

/** 卡片上的字段 chips:有字段用字段,整串模式回退 raw 文本(模板里分支)。 */
function chipsOf(entry: CharTagEntry): { label: string; value: string }[] {
  const chips: { label: string; value: string }[] = [];
  for (const f of CHAR_TAG_FIELDS) {
    const value = entry.fields[f]?.trim();
    if (value) chips.push({ label: CHAR_TAG_FIELD_LABELS[f], value });
  }
  return chips;
}

function openEntry(entry: CharTagEntry, scope: Scope) {
  editingName.value = entry.name;
  editingScope.value = scope;
  draftScope.value = scope;
  draft.value = {
    name: entry.name,
    fields: { ...emptyCharFields(), ...entry.fields },
    raw: entry.raw,
    nl: entry.nl,
  };
  draftSource.value = entry.source;
  draftDesc.value = entry.desc;
  historyOpen.value = false;
  draftPortraitKey.value = entry.portraitKey;
  draftPortrait.value = portraitUrls.value[entry.name] ?? '';
  if (!draftPortrait.value && entry.portraitKey) {
    void readPortraitUrl(entry.portraitKey).then(url => {
      if (url) {
        portraitUrls.value[entry.name] = url;
        if (draft.value?.name === entry.name) draftPortrait.value = url;
      }
    });
  }
}

function addEntry(scope: Scope = 'chat') {
  editingName.value = null;
  editingScope.value = scope;
  draftScope.value = scope;
  draft.value = { name: '', fields: emptyCharFields(), raw: '', nl: '' };
  draftSource.value = 'manual';
  draftDesc.value = '';
  historyOpen.value = false;
}

/* —— 分区折叠(参照星绘书「计划/悬念」)——
 * 标题行兼作折叠开关;折叠态是本机视图偏好,走 localStorage、不进设置(跨设备同步没意义)。 */
const COLLAPSE_KEYS: Record<Scope, string> = {
  global: 'bbi.ui.charGlobalCollapsed.v1',
  chat: 'bbi.ui.charChatCollapsed.v1',
};
function loadCollapsed(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function persistCollapsed(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* localStorage 不可用时仅本次会话生效 */
  }
}
const globalCollapsed = ref(loadCollapsed(COLLAPSE_KEYS.global));
const chatCollapsed = ref(loadCollapsed(COLLAPSE_KEYS.chat));
function toggleFold(scope: Scope) {
  const target = scope === 'global' ? globalCollapsed : chatCollapsed;
  target.value = !target.value;
  persistCollapsed(COLLAPSE_KEYS[scope], target.value);
}
// 无条目即无可折叠:不显示箭头与计数,也强制展开(避免删空后卡在收拢的空态)
const globalFoldable = computed(() => globalCharTagLib.entries.length > 0);
const globalShown = computed(() => !globalCollapsed.value || !globalFoldable.value);
const chatFoldable = computed(() => chatEntries.value.length > 0);
const chatShown = computed(() => !chatCollapsed.value || !chatFoldable.value);

function closeEntry() {
  editingName.value = null;
  draft.value = null;
  regenerating.value = false;
  historyOpen.value = false;
}

/** 手动编辑过的字段 → 条目归手动(但仍可被 AI 变更接管) */
function markManual() {
  draftSource.value = 'manual';
  draftDesc.value = '';
}

/** 重Roll 偏好输入(可选)与进行中状态。 */
const rerollHint = ref('');
const rerolling = ref(false);

/**
 * 重Roll 形象:调文本模型按正文人设重新设计五个固定外貌字段,
 * 结果只填进表单供预览;用户点「保存」才覆盖角色库。
 */
async function rerollAppearance() {
  const d = draft.value;
  if (!d || rerolling.value) return;
  const name = d.name.trim();
  if (!name) {
    toastr.warning('先填角色名再重Roll', '星绘');
    return;
  }
  rerolling.value = true;
  try {
    const current: CharTagEntry = {
      name,
      fields: { ...d.fields },
      raw: d.raw,
      nl: d.nl,
      source: draftSource.value,
      desc: draftDesc.value,
      history: [],
    };
    const others = chatEntries.value.filter(entry => entry.name !== name);
    const next = await rerollCharacterAppearance({
      name,
      currentEntry: current,
      otherEntries: others,
      userHint: rerollHint.value,
      world: world.value,
    });
    d.fields.hair = next.hair;
    d.fields.eyes = next.eyes;
    d.fields.skin = next.skin;
    d.fields.body = next.body;
    d.fields.extra = next.extra;
    markManual();
    toastr.success('已生成新形象,满意就点「保存」', '星绘');
  } catch (error) {
    toastr.error(`重Roll失败:${(error as Error).message}`, '星绘');
  } finally {
    rerolling.value = false;
  }
}

/* ============ 本聊天世界观锚点 ============ */

/** 读不到聊天元数据(纯单测环境)时退回现代默认,不让页面崩。 */
function safeReadWorld(): WorldAnchorConfig {
  try {
    return readWorldAnchor();
  } catch {
    return WORLD_PRESETS.modern;
  }
}

const world = ref<WorldAnchorConfig>(safeReadWorld());
/** 预设下拉的选项:六个内置 + 自定义(自定义只在保存过自定义配置后可选)。 */
const worldOptions = computed(() => [
  ...WORLD_PRESET_IDS.map(id => ({ id: id as string, label: WORLD_PRESETS[id].label })),
  { id: 'custom', label: '自定义' },
]);
/** 自定义模式的三个自由文本(直接编辑最近一次的自定义配置)。 */
const customWorld = ref({
  characterGuidelines: world.value.characterGuidelines,
  outfitMappingHint: world.value.outfitMappingHint,
  portraitAttire: world.value.portraitAttire,
  negativeGuardrails: world.value.negativeGuardrails,
});

function syncCustomFromWorld() {
  customWorld.value = {
    characterGuidelines: world.value.characterGuidelines,
    outfitMappingHint: world.value.outfitMappingHint,
    portraitAttire: world.value.portraitAttire,
    negativeGuardrails: world.value.negativeGuardrails,
  };
}

/** 换预设:立刻锁定并写回聊天元数据(AI 以后不得覆盖)。 */
function onWorldPresetChange(event: Event) {
  const id = (event.target as HTMLSelectElement | null)?.value ?? '';
  if (id === 'custom') {
    world.value = toCustomWorldAnchor(world.value);
    syncCustomFromWorld();
    toastr.success('已切到自定义世界观,改完三个字段即生效', '星绘');
    return;
  }
  const preset = WORLD_PRESET_IDS.find(item => item === id);
  if (!preset) return;
  world.value = selectWorldPreset(preset);
  syncCustomFromWorld();
  toastr.success(`世界观已锁定:${world.value.label}`, '星绘');
}

/** 自定义字段改动即时落盘(不锁定的话 AI 首楼还能改;自定义本身即锁定)。 */
function applyCustomWorld() {
  const next: WorldAnchorConfig = {
    ...world.value,
    presetId: 'custom',
    label: world.value.label || '自定义',
    lockedByUser: true,
    characterGuidelines: customWorld.value.characterGuidelines,
    outfitMappingHint: customWorld.value.outfitMappingHint,
    portraitAttire: customWorld.value.portraitAttire,
    negativeGuardrails: customWorld.value.negativeGuardrails,
  };
  world.value = next;
  saveWorldAnchor(next);
}

/* ============ 立绘:列表封面 + 弹窗预览 ============ */

const portraitUrls = ref<Record<string, string>>({});
/** 卡片上正在生成立绘的角色名(同一时刻只允许一个,避免并发挤爆 NAI 闸门)。 */
const portraitBusy = ref<string | null>(null);
/** 弹窗里的大图预览:新生成的不落库,点「保存」才把 portraitKey 写进条目。 */
const draftPortrait = ref('');
const draftPortraitKey = ref<string | undefined>(undefined);
/** 全屏灯箱。 */
const lightboxSrc = ref('');

const portraitSignature = computed(() =>
  [...globalCharTagLib.entries, ...chatEntries.value].map(entry => `${entry.name}:${entry.portraitKey ?? ''}`).join('|'),
);

watch(
  portraitSignature,
  async () => {
    for (const entry of [...globalCharTagLib.entries, ...chatEntries.value]) {
      const key = entry.portraitKey;
      if (!key || portraitUrls.value[entry.name]) continue;
      try {
        const url = await readPortraitUrl(key);
        if (url) portraitUrls.value[entry.name] = url;
      } catch (error) {
        console.warn('[星绘] 读取立绘失败', entry.name, error);
      }
    }
  },
  { immediate: true },
);

/**
 * 把草稿拼成条目(只用于生成立绘/重Roll,不落盘)。
 * 字段做深拷贝:出图要跑十几秒,期间用户可能继续改表单——生成必须用点击那一刻的快照,
 * 否则会把「改到一半的表单」和「已经发出去的请求」混在一起。
 */
function snapshotEntry(name: string, d: NonNullable<typeof draft.value>, portraitKey?: string): CharTagEntry {
  return {
    name,
    fields: JSON.parse(JSON.stringify(d.fields)) as CharTagEntry['fields'],
    raw: d.raw,
    nl: d.nl,
    source: draftSource.value,
    desc: draftDesc.value,
    history: [],
    ...(portraitKey ? { portraitKey } : {}),
  };
}

/** 把当前草稿拼成条目(只用于生成立绘,不落盘)。 */
function draftEntry(name: string): CharTagEntry {
  const d = draft.value;
  if (!d) throw new Error('没有打开的角色');
  return snapshotEntry(name, d, draftPortraitKey.value || undefined);
}

/** 列表卡片:生成立绘并立刻写进对应层级的库。 */
async function generatePortraitFor(entry: CharTagEntry, scope: Scope) {
  if (portraitBusy.value) return;
  portraitBusy.value = entry.name;
  try {
    const result = await generateCharacterPortrait(entry);
    portraitUrls.value[entry.name] = result.dataUrl;
    const next: CharTagEntry = { ...entry, portraitKey: result.key };
    if (scope === 'global') upsertGlobalCharTag(next);
    else upsertCharTag(next, entry.name, { recordChanges: false });
    toastr.success(`${entry.name} 的立绘已生成`, '星绘');
  } catch (error) {
    toastr.error(`生成立绘失败:${(error as Error).message}`, '星绘');
  } finally {
    portraitBusy.value = null;
  }
}

/** 弹窗:按当前表单字段生成/刷新立绘(只预览,保存才落库)。 */
async function refreshDraftPortrait() {
  const d = draft.value;
  if (!d || portraitBusy.value) return;
  const name = d.name.trim();
  if (!name) {
    toastr.warning('先填角色名再生成立绘', '星绘');
    return;
  }
  portraitBusy.value = name;
  // 跑之前先记住是哪个角色、哪一份字段:回来时若已经切换角色就丢弃,别把 A 的立绘画进 B 的卡片
  const editing = editingName.value;
  const snapshot = snapshotEntry(name, d, draftPortraitKey.value || undefined);
  try {
    const result = await generateCharacterPortrait(snapshot);
    if (editingName.value !== editing || !draft.value) {
      toastr.info('角色已切换,这次立绘已丢弃', '星绘');
      return;
    }
    draftPortrait.value = result.dataUrl;
    draftPortraitKey.value = result.key;
    markManual();
    toastr.success('立绘已更新,满意就点「保存」', '星绘');
  } catch (error) {
    toastr.error(`生成立绘失败:${(error as Error).message}`, '星绘');
  } finally {
    portraitBusy.value = null;
  }
}

/** 弹窗:重Roll 形象 + 自动出立绘(两步一起做)。 */
async function rerollAndPortrait() {
  const d = draft.value;
  if (!d || rerolling.value || portraitBusy.value) return;
  const name = d.name.trim();
  if (!name) {
    toastr.warning('先填角色名再重Roll', '星绘');
    return;
  }
  rerolling.value = true;
  const editing = editingName.value;
  const snapshot = snapshotEntry(name, d);
  try {
    const others = chatEntries.value.filter(entry => entry.name !== name);
    const next = await rerollCharacterAppearance({
      name,
      currentEntry: snapshot,
      otherEntries: others,
      userHint: rerollHint.value,
    });
    if (editingName.value !== editing || !draft.value) {
      toastr.info('角色已切换,这次重Roll已丢弃', '星绘');
      return;
    }
    d.fields.hair = next.hair;
    d.fields.eyes = next.eyes;
    d.fields.skin = next.skin;
    d.fields.body = next.body;
    d.fields.extra = next.extra;
    markManual();
    // 立绘必须按刚写回的新字段出图,所以这里重新取一次快照
    const refreshed = snapshotEntry(name, d);
    const result = await generateCharacterPortrait(refreshed);
    if (editingName.value !== editing || !draft.value) {
      toastr.info('角色已切换,这张立绘已丢弃', '星绘');
      return;
    }
    draftPortrait.value = result.dataUrl;
    draftPortraitKey.value = result.key;
    toastr.success('新形象与新立绘已生成,满意就点「保存」', '星绘');
  } catch (error) {
    toastr.error(`重Roll并出图失败:${(error as Error).message}`, '星绘');
  } finally {
    rerolling.value = false;
  }
}

function confirmEntry() {
  const d = draft.value;
  if (!d) return;
  const name = d.name.trim();
  if (!name) {
    toastr.warning('角色名不能为空', '星绘');
    return;
  }
  if (!previewTag.value) {
    toastr.warning('至少填一个外貌字段(或整串 tag)', '星绘');
    return;
  }
  const entryData: CharTagEntry = {
    name,
    fields: d.fields,
    raw: d.raw,
    nl: d.nl,
    source: draftSource.value,
    desc: draftDesc.value,
    history: [],
    ...(draftPortraitKey.value ? { portraitKey: draftPortraitKey.value } : {}),
  };
  const ok =
    draftScope.value === 'global'
      ? upsertGlobalCharTag(entryData, editingName.value ?? undefined)
      : upsertCharTag(entryData, editingName.value ?? undefined, { recordChanges: true });
  if (ok) closeEntry();
}

/* —— 删除:二次确认 —— */
const confirmDeleteOpen = ref(false);
function askRemove() {
  confirmDeleteOpen.value = true;
}
function confirmRemove() {
  confirmDeleteOpen.value = false;
  if (!editingName.value) return;
  const name = editingName.value;
  const existing = editingScope.value === 'global'
    ? globalCharTagLib.entries.find(entry => entry.name === name)
    : chatEntries.value.find(entry => entry.name === name);
  if (editingScope.value === 'global') removeGlobalCharTag(name);
  else removeCharTag(name);
  // 立绘是本地缓存,条目删了就没必要留着(换个名字再建也不会命中同键)
  if (existing?.portraitKey) void deletePortrait(existing.portraitKey);
  delete portraitUrls.value[name];
  closeEntry();
}

/* —— 提升为全局 / 复制到本聊天 —— */
const confirmPromoteOpen = ref(false);
function askPromote() {
  confirmPromoteOpen.value = true;
}
function confirmPromote() {
  confirmPromoteOpen.value = false;
  if (!editingName.value) return;
  if (promoteCharTagToGlobal(editingName.value)) {
    toastr.success(`「${editingName.value}」已提升为全局角色,所有聊天生效`, '星绘');
  }
  closeEntry();
}

function copyToChat() {
  if (!editingName.value) return;
  const name = editingName.value;
  if (copyGlobalCharTagToChat(name)) {
    toastr.success(`已把「${name}」复制到本聊天,之后本聊天以副本为准`, '星绘');
  }
  closeEntry();
}

/* —— 从星绘书最新状态建档:取最新楼的角色参考,找到同名角色的外貌记录,批量转换接口转字段 —— */
async function regenerateFromBook() {
  const d = draft.value;
  if (!d) return;
  const name = d.name.trim();
  if (!name) {
    toastr.warning('先填写角色名', '星绘');
    return;
  }
  const ctx = getContext();
  const floor = (ctx?.chat.length ?? 0) - 1;
  if (!ctx || floor < 0) {
    toastr.info('当前没有打开的聊天', '星绘');
    return;
  }
  regenerating.value = true;
  try {
    const memory = readBookMemory(floor, ctx.chat[floor]?.mes ?? '', ctx.name1);
    const role = memory?.roles.find(r => r.name === name);
    if (!role?.desc) {
      toastr.info('星绘书最新状态里没有该角色的外貌记录,可手动填写', '星绘');
      return;
    }
    const [result] = await generateCharTags([{ name, desc: role.desc }]);
    if (!result) {
      toastr.warning('模型没有返回该角色的 tag,请重试或手动填写', '星绘');
      return;
    }
    const fields = { ...emptyCharFields(), ...result.fields };
    d.fields = fields;
    d.raw = '';
    draftSource.value = 'book';
    draftDesc.value = role.desc;
    toastr.success('已按星绘书最新外貌生成,点「完成」保存', '星绘');
  } catch (error) {
    toastr.error(error instanceof Error ? error.message : String(error), '星绘');
  } finally {
    regenerating.value = false;
  }
}

/* —— 历史展示与回滚(仅本聊天条目) —— */
function fieldLabel(field: CharTagChangeRecord['field']): string {
  if (field === 'new') return '建档';
  if (field === 'raw') return '整串';
  if (field === 'nl') return '自然语言';
  return CHAR_TAG_FIELD_LABELS[field];
}

function askRollback(record: CharTagChangeRecord) {
  if (!editingName.value) return;
  pendingRollback.value = { name: editingName.value, record };
  confirmRollbackOpen.value = true;
}

function confirmRollback() {
  confirmRollbackOpen.value = false;
  const p = pendingRollback.value;
  pendingRollback.value = null;
  if (!p) return;
  if (rollbackCharTag(p.name, p.record)) {
    toastr.success(`已回滚「${p.name}」的${fieldLabel(p.record.field)}变更`, '星绘');
  } else {
    toastr.warning('回滚失败:条目可能已删除', '星绘');
  }
}

/** 五层服装状态:回放整段聊天得到的账本,只读展示 + 单角色清除。 */
const editingOutfit = computed<CharOutfitSnapshot | null>(() => {
  const name = editingName.value?.trim();
  if (!name) return null;
  const chat = getContext()?.chat ?? [];
  return deriveOutfitSnapshots(chat, chat.length).get(name) ?? null;
});

const REMOVED_CN: Record<string, string> = {
  outer: '外衣',
  top: '上衣',
  bra: '胸罩',
  bottom: '下装',
  panties: '内裤',
  hosiery: '袜/鞋',
};

const editingRemovedLabel = computed(() =>
  (editingOutfit.value?.removed ?? []).map(key => REMOVED_CN[key] ?? key).join('、'),
);

/**
 * 清掉这个角色在所有楼层里记的结楼穿搭快照。
 * 排查「明明穿着却画成裸的」时最有用:快照是逐楼回放出来的,删掉就等于从没记过。
 */
async function resetEditingOutfit() {
  const name = editingName.value?.trim();
  if (!name) return;
  const context = getContext();
  const chat = context?.chat ?? [];
  const chatId = context?.getCurrentChatId?.() ?? '';
  if (!chat.length || !context?.saveChat || !chatId) {
    toastr.warning('当前没有打开的聊天,无法改写服装记录', '星绘');
    return;
  }
  let touched = 0;
  for (let floor = 0; floor < chat.length; floor += 1) {
    const message = chat[floor];
    const delta = readOutfitFloorDelta(message);
    if (!delta || !delta.snapshots.length) continue;
    const kept = delta.snapshots.filter(snapshot => snapshot.name !== name);
    if (kept.length === delta.snapshots.length) continue;
    const value = kept.length ? { ...delta, snapshots: kept } : undefined;
    const result = await applyMessageText(
      floor,
      text => text,
      chatId,
      message.swipe_id ?? 0,
      message,
      { key: BBI_OUTFIT_EXTRA_KEY, value },
    );
    if (result === 'saved') touched += 1;
  }
  toastr[touched ? 'success' : 'info'](
    touched ? `已清除 ${touched} 楼里「${name}」的穿搭记录` : `「${name}」没有穿搭记录`,
    '星绘',
  );
}

function sourceLabel(entry: CharTagEntry): string {
  return entry.source === 'book' ? '星绘书' : entry.source === 'ai' ? 'AI 维护' : '手动';
}
</script>

<template>
  <section class="bbi-page">
    <div class="bbi-page-head">
      <h2 class="bbi-title bbi-title-sub">角色管理</h2>
    </div>
    <hr class="bbi-rule" />

    <p class="bbi-field-hint">
      角色固定外貌库:生成 tag 时 AI 照抄库中字段,@角色名 占位符也会被替换为库中最新外貌,稳定不漂移。
    </p>

    <!-- ===== 本聊天世界观锚点 ===== -->
    <div class="bbi-world-card">
      <div class="bbi-world-head">
        <span class="bbi-field-label">本聊天世界观</span>
        <span class="bbi-world-tag" :class="{ 'is-locked': world.lockedByUser }">
          {{ world.lockedByUser ? '已锁定' : '自动识别' }}
        </span>
        <select class="bbi-world-select" :value="world.presetId" @change="onWorldPresetChange">
          <option v-for="option in worldOptions" :key="option.id" :value="option.id">{{ option.label }}</option>
        </select>
      </div>
      <p class="bbi-field-hint bbi-world-hint">
        建档与服装按这个时代出词:古风不穿牛仔裤、赛博不披汉服;立绘也按这套素服出图。选过即锁定,AI 首楼不再改写。
      </p>
      <div v-if="world.presetId === 'custom'" class="bbi-world-custom">
        <label class="bbi-field">
          <span class="bbi-field-label">角色边界</span>
          <BbiTextarea v-model="customWorld.characterGuidelines" :rows="2" placeholder="例:古代东方,平民与士族分层,无现代科技" @change="applyCustomWorld" />
        </label>
        <label class="bbi-field">
          <span class="bbi-field-label">服装映射</span>
          <BbiTextarea v-model="customWorld.outfitMappingHint" :rows="2" placeholder="例:现代单品一律换成汉服/道袍/铠甲" @change="applyCustomWorld" />
        </label>
        <label class="bbi-field">
          <span class="bbi-field-label">立绘素服</span>
          <BbiTextarea v-model="customWorld.portraitAttire" :rows="2" placeholder="例:plain white traditional hanfu" @change="applyCustomWorld" />
        </label>
        <label class="bbi-field">
          <span class="bbi-field-label">防穿帮负面</span>
          <BbiTextarea v-model="customWorld.negativeGuardrails" :rows="2" placeholder="例:jeans, sneakers, smartphone" @change="applyCustomWorld" />
        </label>
      </div>
    </div>

    <!-- ===== 全局角色库 ===== -->
    <div class="bbi-char-section">
      <div class="bbi-char-section-head">
        <button
          class="bbi-fold-head"
          type="button"
          :class="{ 'is-static': !globalFoldable }"
          :disabled="!globalFoldable"
          :aria-expanded="globalShown"
          :title="globalFoldable ? (globalShown ? '收起全局角色库' : '展开全局角色库') : ''"
          @click="toggleFold('global')"
        >
          <Icon v-if="globalFoldable" name="chevron" class="bbi-fold-caret" :class="{ 'is-collapsed': !globalShown }" />
          <span class="bbi-field-label">全局角色库</span>
          <span v-if="globalFoldable" class="bbi-count">{{ globalCharTagLib.entries.length }}</span>
        </button>
        <button class="bbi-add-mini" type="button" title="添加全局角色" @click="addEntry('global')">
          <Icon name="plus" />
        </button>
      </div>
      <!-- grid 1fr↔0fr 收展:高度自适应、无需写死 max-height -->
      <div class="bbi-fold-wrap" :class="{ 'is-collapsed': !globalShown }">
        <div class="bbi-fold-inner">
          <p class="bbi-field-hint">
            所有聊天生效,仅手动维护——AI 不会修改全局角色,适合玩家角色等固定形象。本聊天有同名角色时以本聊天为准。
          </p>
          <ul v-if="globalCharTagLib.entries.length" class="bbi-portrait-grid">
          <li v-for="entry in globalCharTagLib.entries" :key="entry.name" class="bbi-portrait-card">
            <button class="bbi-portrait-btn" type="button" @click="openEntry(entry, 'global')">
              <img
                v-if="portraitUrls[entry.name]"
                class="bbi-portrait-img"
                :src="portraitUrls[entry.name]"
                :alt="entry.name"
                loading="lazy"
              />
              <span v-else class="bbi-portrait-placeholder">
                <Icon name="characters" />
                <span>暂无立绘</span>
              </span>
              <span class="bbi-portrait-caption">
                <span class="bbi-portrait-name">{{ entry.name }}</span>
                <span class="bbi-portrait-tags">
                  <span class="bbi-char-pill is-global">全局</span>
                  <span v-if="charTagBaseNames.has(entry.name)" class="bbi-char-pill is-override" title="本聊天有同名角色,当前聊天以本聊天的为准">本聊天已覆盖</span>
                </span>
              </span>
            </button>
            <button
              v-if="!portraitUrls[entry.name]"
              class="bbi-portrait-gen"
              type="button"
              :disabled="!!portraitBusy"
              @click.stop="generatePortraitFor(entry, 'global')"
            >
              
              <span>{{ portraitBusy === entry.name ? '生成中…' : '生成立绘' }}</span>
            </button>
          </li>
          </ul>
          <p v-else class="bbi-char-empty">
            还没有全局角色。在本聊天角色的编辑弹窗里点「提升为全局」,或点右上角「+」添加。
          </p>
        </div>
      </div>
    </div>

    <!-- ===== 本聊天角色 ===== -->
    <div class="bbi-char-section">
      <div class="bbi-char-section-head">
        <button
          class="bbi-fold-head"
          type="button"
          :class="{ 'is-static': !chatFoldable }"
          :disabled="!chatFoldable"
          :aria-expanded="chatShown"
          :title="chatFoldable ? (chatShown ? '收起本聊天角色' : '展开本聊天角色') : ''"
          @click="toggleFold('chat')"
        >
          <Icon v-if="chatFoldable" name="chevron" class="bbi-fold-caret" :class="{ 'is-collapsed': !chatShown }" />
          <span class="bbi-field-label">本聊天角色</span>
          <span v-if="chatFoldable" class="bbi-count">{{ chatEntries.length }}</span>
        </button>
        <button class="bbi-add-mini" type="button" title="添加本聊天角色" @click="addEntry('chat')">
          <Icon name="plus" />
        </button>
      </div>
      <div class="bbi-fold-wrap" :class="{ 'is-collapsed': !chatShown }">
        <div class="bbi-fold-inner">
          <p class="bbi-field-hint">
            仅当前聊天生效:星绘书角色自动建档,AI 随剧情报告永久变化;可查看历史并回滚。
          </p>
          <ul v-if="chatEntries.length" class="bbi-portrait-grid">
          <li v-for="entry in chatEntries" :key="entry.name" class="bbi-portrait-card">
            <button class="bbi-portrait-btn" type="button" @click="openEntry(entry, 'chat')">
              <img
                v-if="portraitUrls[entry.name]"
                class="bbi-portrait-img"
                :src="portraitUrls[entry.name]"
                :alt="entry.name"
                loading="lazy"
              />
              <span v-else class="bbi-portrait-placeholder">
                <Icon name="characters" />
                <span>暂无立绘</span>
              </span>
              <span class="bbi-portrait-caption">
                <span class="bbi-portrait-name">{{ entry.name }}</span>
                <span class="bbi-portrait-tags">
                  <span
                    class="bbi-char-pill"
                    :class="{ 'is-book': entry.source === 'book', 'is-ai': entry.source === 'ai' }"
                  >{{ sourceLabel(entry) }}</span>
                  <span v-if="globalNameSet.has(entry.name)" class="bbi-char-pill is-override" title="与全局库同名,当前聊天以本条为准">覆盖全局</span>
                  <span
                    v-if="entry.history.length"
                    class="bbi-char-history-badge"
                    :title="`${entry.history.length} 条变更记录,点卡片查看`"
                  ><Icon name="history" />{{ entry.history.length }}</span>
                </span>
              </span>
            </button>
            <button
              v-if="!portraitUrls[entry.name]"
              class="bbi-portrait-gen"
              type="button"
              :disabled="!!portraitBusy"
              @click.stop="generatePortraitFor(entry, 'chat')"
            >
              
              <span>{{ portraitBusy === entry.name ? '生成中…' : '生成立绘' }}</span>
            </button>
          </li>
          </ul>
          <p v-else class="bbi-char-empty">
            本聊天还没有角色。生成 tag 时星绘书角色会自动建档,也可点右上角「+」手动补。
          </p>
        </div>
      </div>
    </div>

    <!-- ===== 角色编辑弹窗 ===== -->
    <ModalMask :open="!!draft" @close="closeEntry">
      <div v-if="draft" class="bbi-modal bbi-char-modal" role="dialog" aria-modal="true" aria-label="编辑角色">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">
            {{ editingName ? '编辑角色' : '添加角色' }}
            <span v-if="editingName" class="bbi-char-pill" :class="editingScope === 'global' ? 'is-global' : 'is-chat'">
              {{ editingScope === 'global' ? '全局' : '本聊天' }}
            </span>
          </span>
          <button class="bbi-icon-mini" type="button" title="关闭" @click="closeEntry"><Icon name="close" /></button>
        </header>

        <!-- ===== 立绘预览:大图 + 生成/刷新 + 重Roll并出图 ===== -->
        <div class="bbi-portrait-panel">
          <button
            v-if="draftPortrait"
            class="bbi-portrait-preview"
            type="button"
            title="点击全屏查看"
            @click="lightboxSrc = draftPortrait"
          >
            <img :src="draftPortrait" alt="立绘预览" />
            <span class="bbi-portrait-preview-hint">点击全屏</span>
          </button>
          <div v-else class="bbi-portrait-preview is-empty">
            <Icon name="characters" />
            <span>还没有立绘</span>
          </div>
          <div class="bbi-portrait-panel-side">
            <button
              class="bbi-btn bbi-btn-sm"
              type="button"
              :disabled="!!portraitBusy || rerolling"
              @click="refreshDraftPortrait"
            >
              {{ portraitBusy ? '出图中…' : draftPortrait ? '刷新立绘' : '生成立绘' }}
            </button>
            <button
              class="bbi-btn bbi-btn-sm"
              type="button"
              :disabled="rerolling || !!portraitBusy"
              @click="rerollAndPortrait"
            >
              {{ rerolling ? '重Roll中…' : '重Roll形象并出图' }}
            </button>
            <span class="bbi-field-hint">
              立绘只用固定外貌 + 白底全身构图,不读剧情。生成后先预览,点「保存」才写进角色库。
            </span>
          </div>
        </div>

        <!-- ===== 结楼穿搭快照:逐楼回放结果,只读查看 + 单角色清除 ===== -->
        <details v-if="editingName" class="bbi-outfit-audit">
          <summary>
            当前穿搭(逐楼回放)
            <span class="bbi-outfit-audit-sub">
              {{ editingOutfit ? '有记录' : '暂无记录' }}
            </span>
          </summary>
          <template v-if="editingOutfit">
            <div class="bbi-outfit-snapshot">
              <div class="bbi-outfit-row">
                <span class="bbi-outfit-layer">穿着</span>
                <span class="bbi-outfit-tag">{{ editingOutfit.wearing || '(全裸)' }}</span>
              </div>
              <div class="bbi-outfit-row">
                <span class="bbi-outfit-layer">已脱</span>
                <span class="bbi-outfit-tag">{{ editingRemovedLabel || '—' }}</span>
              </div>
              <div class="bbi-outfit-row">
                <span class="bbi-outfit-layer">状态</span>
                <span class="bbi-outfit-tag">{{ editingOutfit.stateNote || '—' }}</span>
              </div>
            </div>
            <p class="bbi-field-hint">
              这是逐楼回放出来的「每楼结束时」的穿搭。画错多半是某楼把敞开/撩起记成了脱掉,可在这里清除后重新生成本楼 tag。
            </p>
            <button class="bbi-btn bbi-btn-sm bbi-btn-danger" type="button" @click="resetEditingOutfit">
              清除「{{ editingName }}」的穿搭记录
            </button>
          </template>
          <p v-else class="bbi-field-hint">
            这个角色还没有穿搭记录(没出过图,或所在楼层没有服装变更)。
          </p>
        </details>

        <!-- 作用域:仅新建时可选;已有条目换层用底部「提升为全局 / 复制到本聊天」 -->
        <div v-if="!editingName" class="bbi-modal-field">
          <span class="bbi-modal-label">保存到</span>
          <div class="bbi-segmented">
            <button
              class="bbi-seg"
              :class="{ 'is-on': draftScope === 'chat' }"
              type="button"
              @click="draftScope = 'chat'"
            >
              本聊天
            </button>
            <button
              class="bbi-seg"
              :class="{ 'is-on': draftScope === 'global' }"
              type="button"
              @click="draftScope = 'global'"
            >
              全局
            </button>
          </div>
          <span class="bbi-field-hint">
            {{ draftScope === 'global' ? '全局:所有聊天生效,AI 不会修改,tag 有问题需手动改。' : '本聊天:仅当前聊天,AI 可随剧情自动变更。' }}
          </span>
        </div>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">角色名</span>
          <input v-model="draft.name" class="bbi-input" placeholder="与正文/星绘书中的名字一致" @input="markManual" />
        </label>
        <span class="bbi-field-hint">按这个名字去正文和星绘书角色参考里匹配;AI 引用时也用它(@角色名)。改名不会自动跟随。</span>

        <div class="bbi-modal-field">
          <span class="bbi-modal-label">外貌字段</span>
          <div class="bbi-char-form">
            <label
              v-for="f in CHAR_TAG_FIELDS"
              :key="f"
              class="bbi-char-form-row"
              :class="{ 'is-wide': f === 'outfit' }"
            >
              <span class="bbi-char-form-label">{{ CHAR_TAG_FIELD_LABELS[f] }}</span>
              <input
                v-model="draft.fields[f]"
                class="bbi-input"
                :placeholder="FIELD_PLACEHOLDERS[f]"
                @input="markManual"
              />
            </label>
          </div>
        </div>
        <span class="bbi-field-hint">只写固定基础特征;服装、表情、动作不入库,每次按剧情生成。</span>

        <!-- 重Roll形象:仅本聊天角色(全局库是跨聊天模板,不该被重设计) -->
        <div v-if="draftScope === 'chat'" class="bbi-modal-field bbi-char-reroll">
          <span class="bbi-modal-label">重Roll形象</span>
          <div class="bbi-char-reroll-row">
            <input
              v-model="rerollHint"
              class="bbi-input"
              placeholder="重Roll偏好(可选,如:微黑皮短发运动系)"
              :disabled="rerolling"
            />
            <button class="bbi-btn bbi-btn-sm" type="button" :disabled="rerolling" @click="rerollAppearance">
              {{ rerolling ? '重Roll中…' : '重Roll形象' }}
            </button>
          </div>
          <span class="bbi-field-hint">
            按正文已写死的人设重设计发型/瞳色/肤色/体型/标志特征,只填进下面表单供预览;反复点会换新方案,点「保存」才落盘。
          </span>
        </div>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">整串模式(可选)</span>
          <BbiTextarea
            v-model="draft.raw"
            :rows="2"
            :max-rows="6"
            mono
            placeholder="留空则用上面的字段拼接;填了整串且字段全空时,以整串为准(旧数据格式)"
            @input="markManual"
          />
        </label>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">自然语言外貌(可选)</span>
          <BbiTextarea
            v-model="draft.nl"
            :rows="2"
            :max-rows="4"
            mono
            placeholder="一句连贯英文外貌描述,自然语言模式下替换 nl 里的 @角色名 用;留空则用 tag 串替换"
            @input="markManual"
          />
        </label>

        <div class="bbi-char-preview">
          <span class="bbi-field-label">最终 tag 预览</span>
          <code class="bbi-char-preview-tag">{{ previewTag || '(空)' }}</code>
          <span v-if="draftIsRaw" class="bbi-char-preview-mode">整串模式</span>
        </div>

        <!-- 变更历史:仅本聊天条目;全局条目无历史(AI 不可改,手动编辑不留痕) -->
        <div v-if="editingHistory.length" class="bbi-char-history">
          <button class="bbi-char-history-toggle" type="button" @click="historyOpen = !historyOpen">
            <span class="bbi-char-history-caret" :class="{ 'is-open': historyOpen }"><Icon name="chevron" /></span>
            变更历史({{ editingHistory.length }})
          </button>
          <ul v-if="historyOpen" class="bbi-char-history-list">
            <li v-for="(record, i) in [...editingHistory].reverse()" :key="i" class="bbi-char-history-item">
              <div class="bbi-char-history-main">
                <span class="bbi-char-history-field">{{ fieldLabel(record.field) }}</span>
                <span class="bbi-char-history-change">
                  <template v-if="record.from">{{ record.from }} → {{ record.to }}</template>
                  <template v-else>{{ record.to }}</template>
                </span>
                <span v-if="record.reason" class="bbi-char-history-reason">{{ record.reason }}</span>
                <span class="bbi-char-history-meta">{{ record.floor >= 0 ? `第${record.floor}楼` : '手动' }}·{{ new Date(record.at).toLocaleString() }}</span>
              </div>
              <button class="bbi-btn bbi-btn-sm" type="button" title="把该字段回滚到变更前的值" @click="askRollback(record)">
                回滚
              </button>
            </li>
          </ul>
        </div>

        <footer class="bbi-modal-foot">
          <button v-if="editingName" class="bbi-btn bbi-btn-danger" type="button" @click="askRemove">
            <Icon name="trash" /> 删除
          </button>
          <span class="bbi-modal-foot-spacer"></span>
          <button
            v-if="editingName && editingScope === 'chat'"
            class="bbi-btn"
            type="button"
            title="把当前外貌快照进全局库,所有聊天生效;本聊天副本与变更记录将清除"
            @click="askPromote"
          >
            <Icon name="star" /> 提升为全局
          </button>
          <button
            v-if="editingName && editingScope === 'global'"
            class="bbi-btn"
            type="button"
            title="复制为本聊天副本:之后本聊天以副本为准,AI 可对其变更"
            @click="copyToChat"
          >
            <Icon name="copy" /> 复制到本聊天
          </button>
          <button
            class="bbi-btn"
            type="button"
            title="读取星绘书最新状态里该角色的外貌,重新转换成字段"
            :disabled="regenerating"
            @click="regenerateFromBook"
          >
            <Icon name="refresh" /> {{ regenerating ? '生成中…' : '从星绘书生成' }}
          </button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="confirmEntry">完成</button>
        </footer>

        <ConfirmDialog
          v-model:open="confirmDeleteOpen"
          title="删除角色"
          confirm-text="删除"
          confirm-icon="trash"
          tone="danger"
          top-layer
          @confirm="confirmRemove"
        >
          确定删除「{{ editingName }}」的固定外貌 tag 吗?之后生成时该角色的外貌将不再锚定。
        </ConfirmDialog>

        <ConfirmDialog
          v-model:open="confirmPromoteOpen"
          title="提升为全局"
          confirm-text="提升"
          confirm-icon="star"
          top-layer
          @confirm="confirmPromote"
        >
          把「{{ editingName }}」的当前外貌快照进全局库?之后所有聊天(包括本聊天)都以全局值为准,
          AI 不能再修改它;本聊天的副本与变更记录将被清除。
        </ConfirmDialog>
      </div>
    </ModalMask>

    <!-- ===== 回滚确认 ===== -->
    <ConfirmDialog
      v-model:open="confirmRollbackOpen"
      title="回滚变更"
      confirm-text="回滚"
      tone="danger"
      top-layer
      @confirm="confirmRollback"
    >
      <template v-if="pendingRollback">
        把「{{ pendingRollback.name }}」的「{{ fieldLabel(pendingRollback.record.field) }}」从
        <code>{{ pendingRollback.record.to }}</code> 回滚到
        <code>{{ pendingRollback.record.from || '(空)' }}</code> ?
        建档记录的回滚会删除整个条目。
      </template>
    </ConfirmDialog>
    <!-- ===== 立绘全屏灯箱 ===== -->
    <div v-if="lightboxSrc" class="bbi-portrait-lightbox" @click="lightboxSrc = ''">
      <img :src="lightboxSrc" alt="立绘大图" />
      <button class="bbi-portrait-lightbox-close" type="button" title="关闭" @click.stop="lightboxSrc = ''">
        <Icon name="close" />
      </button>
    </div>
  </section>
</template>

<style scoped>
/* 世界观卡片:一条横向信息栏 + 可选的自定义四字段 */
.bbi-world-card {
  margin: 12px 0 18px;
  padding: 12px 14px;
  border: 1px solid var(--SmartThemeBorderColor, #3a3a3a);
  border-radius: 10px;
  background: var(--black30a, rgba(0, 0, 0, 0.18));
}
.bbi-world-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.bbi-world-tag {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  border: 1px solid var(--SmartThemeBorderColor, #4a4a4a);
  opacity: 0.75;
}
.bbi-world-tag.is-locked {
  border-color: var(--SmartThemeQuoteColor, #b58b4a);
  opacity: 1;
}
.bbi-world-select {
  margin-left: auto;
  min-width: 140px;
  padding: 3px 6px;
  border-radius: 6px;
  border: 1px solid var(--SmartThemeBorderColor, #4a4a4a);
  background: var(--black50a, rgba(0, 0, 0, 0.3));
  color: inherit;
}
.bbi-world-hint {
  margin: 6px 0 0;
  font-size: 12px;
  opacity: 0.7;
}
.bbi-world-custom {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 8px 12px;
  margin-top: 10px;
}
/* —— 计数药丸:与设置页版本号同款观感 —— */
.bbi-count {
  border: 0;
  padding: 7px 12px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  font-family: var(--bbi-font-mono);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
}

/* —— 分区 —— */
.bbi-char-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 20px;
}
.bbi-char-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

/* —— 折叠开关(参照星绘书「计划/悬念」)——
 * 标题行整体可点:左箭头 + 标题 + 计数标。无框透明,折叠是辅助操作,标题仍是主体。 */
.bbi-fold-head {
  flex: 1 1 auto;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.bbi-fold-head.is-static {
  cursor: default;
}
/* 折叠箭头:展开朝下,收拢转 -90° 朝右。描边继承 currentColor(muted),hover 整行点亮强调色。 */
.bbi-fold-caret {
  flex: 0 0 auto;
  color: var(--bbi-ink-muted);
  transition: transform 0.2s var(--bbi-ease), color 0.15s;
}
.bbi-fold-caret.is-collapsed {
  transform: rotate(-90deg);
}
.bbi-fold-head:hover:not(.is-static) .bbi-fold-caret,
.bbi-fold-head:focus-visible .bbi-fold-caret {
  color: var(--bbi-accent);
}

/* 可收展容器:grid 1fr↔0fr,高度随内容自适应,无需写死 max-height */
.bbi-fold-wrap {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.24s var(--bbi-ease);
}
.bbi-fold-wrap.is-collapsed {
  grid-template-rows: 0fr;
}
.bbi-fold-inner {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 区头右侧小「+」:透明底,hover 才点亮,不喷宾夺主 */
.bbi-add-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--bbi-radius-sm);
  background: transparent;
  color: var(--bbi-ink-muted);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.bbi-add-mini:hover {
  color: var(--bbi-accent);
  background: var(--bbi-surface-2);
}
.bbi-char-empty {
  margin: 0;
  padding: 14px 16px;
  border: 1px dashed var(--bbi-line);
  border-radius: var(--bbi-radius);
  color: var(--bbi-ink-muted);
  font-size: 12.5px;
}

/* —— 角色卡片网格 —— */
.bbi-char-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
}
.bbi-char-card {
  min-width: 0;
}
.bbi-char-card-btn {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  cursor: pointer;
  text-align: left;
  transition:
    border-color var(--bbi-dur) var(--bbi-ease),
    box-shadow var(--bbi-dur) var(--bbi-ease),
    transform var(--bbi-dur) var(--bbi-ease);
}
.bbi-char-card-btn:hover {
  border-color: var(--bbi-accent);
  box-shadow: 0 8px 20px -12px var(--bbi-overlay);
  transform: translateY(-1px);
}
.bbi-char-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}
.bbi-char-name {
  font-size: 15px;
  font-weight: 600;
  word-break: break-word;
  min-width: 0;
}
.bbi-char-pills {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* —— 徽标药丸:全局=实心强调;星绘书/AI=强调浅底;手动=弱化;覆盖=警示色 —— */
.bbi-char-pill {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: var(--bbi-radius-pill);
  color: var(--bbi-ink-muted);
  background: var(--bbi-surface-2);
  border: 1px solid var(--bbi-line);
  white-space: nowrap;
}
.bbi-char-pill.is-global {
  color: var(--bbi-accent-ink);
  background: var(--bbi-accent);
  border-color: transparent;
}
.bbi-char-pill.is-chat {
  color: var(--bbi-ink-soft);
}
.bbi-char-pill.is-book,
.bbi-char-pill.is-ai {
  color: var(--bbi-accent);
  background: var(--bbi-accent-soft);
  border-color: transparent;
}
.bbi-char-pill.is-override {
  color: var(--bbi-warning);
  background: var(--bbi-warning-soft);
  border-color: transparent;
}

/* —— 字段 chips:两行封顶,超出裁切 —— */
.bbi-char-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 52px;
  overflow: hidden;
}
.bbi-chip {
  font-family: var(--bbi-font-mono);
  font-size: 11px;
  padding: 3px 9px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  border: 1px solid var(--bbi-line);
  white-space: nowrap;
}
/* 整串模式:mono 小字两行截断 */
.bbi-char-raw {
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.bbi-char-history-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-family: var(--bbi-font-mono);
  font-size: 11px;
  color: var(--bbi-ink-muted);
}

/* —— 弹窗加宽,容纳两列字段表单 —— */
.bbi-char-modal {
  max-width: 600px;
}

/* —— 字段表单:两列网格,固定着装独占一行 —— */
.bbi-char-form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 12px;
}
.bbi-char-form-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.bbi-char-form-row.is-wide {
  grid-column: 1 / -1;
}
.bbi-char-form-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--bbi-ink-soft);
}

/* —— 重Roll 形象 —— */
.bbi-char-reroll-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bbi-char-reroll-row .bbi-input {
  flex: 1 1 auto;
  min-width: 0;
}
.bbi-char-reroll-row .bbi-btn {
  flex: 0 0 auto;
  white-space: nowrap;
}

/* —— 弹窗内历史面板 —— */
.bbi-char-history {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbi-char-history-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  border: 0;
  background: none;
  padding: 2px 6px;
  color: var(--bbi-ink-muted);
  font-size: 12px;
  font-family: var(--bbi-font-sans);
  cursor: pointer;
  border-radius: var(--bbi-radius-sm);
}
.bbi-char-history-toggle:hover {
  color: var(--bbi-accent);
  background: var(--bbi-surface-2);
}
.bbi-char-history-caret {
  display: inline-flex;
  transition: transform var(--bbi-dur) var(--bbi-ease);
}
.bbi-char-history-caret.is-open {
  transform: rotate(180deg);
}
.bbi-char-history-list {
  list-style: none;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 240px;
  overflow-y: auto;
}
.bbi-char-history-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.bbi-char-history-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.bbi-char-history-field {
  font-size: 11px;
  font-weight: 600;
  color: var(--bbi-accent);
}
.bbi-char-history-change {
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink);
  word-break: break-word;
}
.bbi-char-history-reason {
  font-size: 12px;
  color: var(--bbi-ink-muted);
}
.bbi-char-history-meta {
  font-size: 11px;
  color: var(--bbi-ink-muted);
}

/* —— 最终 tag 预览 —— */
.bbi-char-preview {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
}
.bbi-char-preview-tag {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink);
  word-break: break-word;
}
.bbi-char-preview-mode {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: var(--bbi-radius-pill);
  color: var(--bbi-ink-muted);
  background: var(--bbi-surface);
  border: 1px solid var(--bbi-line);
}

.bbi-icon-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 14px;
}
.bbi-icon-mini:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}

.bbi-modal-foot {
  flex-wrap: wrap;
}
.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}
.bbi-btn-danger {
  color: var(--bbi-danger);
  border-color: var(--bbi-line-strong);
}
.bbi-btn-danger:hover {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}


/* ===== 立绘卡片:竖版 3:4,底部渐变蒙层只留名字与标签 ===== */
.bbi-portrait-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.bbi-portrait-card {
  position: relative;
  min-width: 0;
}
.bbi-portrait-btn {
  display: block;
  width: 100%;
  padding: 0;
  border: 1px solid var(--bbi-line);
  border-radius: 10px;
  overflow: hidden;
  background: var(--bbi-panel);
  color: inherit;
  cursor: pointer;
  transition: border-color 0.15s, transform 0.15s;
}
.bbi-portrait-btn:hover {
  border-color: var(--bbi-line-strong);
  transform: translateY(-1px);
}
.bbi-portrait-img {
  display: block;
  width: 100%;
  aspect-ratio: 3 / 4;
  object-fit: cover;
  background: var(--bbi-panel-alt, #222);
}
.bbi-portrait-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  aspect-ratio: 3 / 4;
  color: var(--bbi-muted);
  font-size: 12px;
  background: repeating-linear-gradient(45deg, rgba(255,255,255,0.03) 0 8px, transparent 8px 16px);
}
.bbi-portrait-placeholder svg {
  width: 26px;
  height: 26px;
  opacity: 0.7;
}
.bbi-portrait-caption {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 18px 8px 7px;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.82), rgba(0, 0, 0, 0.35) 55%, transparent);
  text-align: left;
}
.bbi-portrait-name {
  font-size: 13px;
  font-weight: 600;
  color: #fff;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bbi-portrait-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.bbi-portrait-tags .bbi-char-pill,
.bbi-portrait-tags .bbi-char-history-badge {
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
  border: none;
}
.bbi-portrait-gen {
  position: absolute;
  top: 6px;
  right: 6px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 11px;
  cursor: pointer;
}
.bbi-portrait-gen:disabled {
  opacity: 0.6;
  cursor: default;
}

/* ===== 弹窗服装状态折叠区 ===== */
.bbi-outfit-audit {
  margin: 0 0 12px;
  padding: 8px 10px;
  border: 1px solid var(--bbi-line);
  border-radius: 10px;
  background: var(--bbi-bg-soft, rgba(255, 255, 255, 0.02));
}
.bbi-outfit-audit > summary {
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  color: var(--bbi-text);
  list-style: none;
}
.bbi-outfit-audit > summary::-webkit-details-marker {
  display: none;
}
.bbi-outfit-audit > summary::before {
  content: '▸';
  display: inline-block;
  width: 12px;
  color: var(--bbi-muted);
  transition: transform 0.15s ease;
}
.bbi-outfit-audit[open] > summary::before {
  transform: rotate(90deg);
}
.bbi-outfit-audit-sub {
  margin-left: 6px;
  font-weight: 400;
  color: var(--bbi-muted);
}
.bbi-outfit-snapshot {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}

.bbi-outfit-row {
  display: flex;
  gap: 10px;
  align-items: baseline;
  font-size: 12px;
}

.bbi-outfit-snapshot + .bbi-field-hint {
  margin: 6px 0 10px;
}

.bbi-outfit-list {
  margin: 8px 0 6px;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 4px;
}
.bbi-outfit-list li {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: 12px;
  line-height: 1.5;
}
.bbi-outfit-layer {
  flex: 0 0 44px;
  color: var(--bbi-muted);
}
.bbi-outfit-status {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid var(--bbi-line);
  font-size: 11px;
}
.bbi-outfit-status.is-worn {
  color: #6cc48a;
  border-color: rgba(108, 196, 138, 0.5);
}
.bbi-outfit-status.is-disheveled {
  color: #d8a94b;
  border-color: rgba(216, 169, 75, 0.5);
}
.bbi-outfit-status.is-removed {
  color: #d96a6a;
  border-color: rgba(217, 106, 106, 0.5);
}
.bbi-outfit-tag {
  flex: 1 1 auto;
  word-break: break-word;
  color: var(--bbi-text);
}

/* ===== 弹窗立绘面板 ===== */
.bbi-portrait-panel {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 12px;
}
.bbi-portrait-preview {
  position: relative;
  flex: 0 0 auto;
  width: 132px;
  padding: 0;
  border: 1px solid var(--bbi-line);
  border-radius: 10px;
  overflow: hidden;
  background: var(--bbi-panel);
  cursor: zoom-in;
}
.bbi-portrait-preview img {
  display: block;
  width: 100%;
  aspect-ratio: 3 / 4;
  object-fit: cover;
}
.bbi-portrait-preview.is-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  aspect-ratio: 3 / 4;
  color: var(--bbi-muted);
  font-size: 12px;
  cursor: default;
}
.bbi-portrait-preview-hint {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 3px 0;
  font-size: 10px;
  color: #fff;
  background: rgba(0, 0, 0, 0.55);
}
.bbi-portrait-panel-side {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  flex: 1 1 auto;
}

/* ===== 全屏灯箱 ===== */
.bbi-portrait-lightbox {
  position: fixed;
  inset: 0;
  z-index: 100000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.88);
  cursor: zoom-out;
}
.bbi-portrait-lightbox img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 8px;
}
.bbi-portrait-lightbox-close {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 255, 255, 0.4);
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  cursor: pointer;
}

@media (max-width: 900px) {
  .bbi-portrait-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 640px) {
  .bbi-portrait-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .bbi-portrait-panel {
    flex-direction: column;
  }
  .bbi-portrait-preview {
    width: 100%;
    max-width: 220px;
  }
}

@media (max-width: 640px) {
  .bbi-char-grid {
    grid-template-columns: 1fr;
  }
  .bbi-char-form {
    grid-template-columns: 1fr;
  }
  .bbi-char-name {
    font-size: 14px;
  }
}
</style>
