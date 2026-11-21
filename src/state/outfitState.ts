import { getContext, type STMessage } from '@/st/context';

/**
 * 五层服装状态机。
 *
 * 与 charTags.ts 同构：每楼把「本楼发生的穿脱」记进 `message.extra['bbiOutfitOps']`，
 * 读取时从第 0 楼顺序回放，所以删楼、改楼、切 swipe 都能自洽——状态永远由「现在还活着
 * 的那些楼层」推出来，不留一份会漂的全局快照。
 *
 * 为什么按层而不是按「整套衣服」记：剧情里最常发生的是「只有胸罩被拉下来」「只有裙子被
 * 撩起」，整套替换会把没变的层也一起洗掉，模型再看到就得重新猜，猜就是漂。
 */

export type OutfitLayerKey = 'outer' | 'bra' | 'bottom' | 'panties' | 'hosiery';

export const OUTFIT_LAYER_KEYS: readonly OutfitLayerKey[] = [
  'outer',
  'bra',
  'bottom',
  'panties',
  'hosiery',
];

export const OUTFIT_LAYER_LABELS: Record<OutfitLayerKey, string> = {
  outer: '外衣/上装',
  bra: '胸罩',
  bottom: '下装裙裤',
  panties: '内裤',
  hosiery: '袜子/丝袜/鞋',
};

/**
 * worn = 正常穿着且起作用（遮住该露的地方）；
 * disheveled = 还在身上，但形态变了（半敞、滑到肩下、撩起、拉到一边）；
 * removed = 已离开身体，或已被脱下（不再遮盖）。
 *
 * `stateTag` 只在 disheveled 时有意义：它是这层「现在是什么样」的英文指纹。
 */
export type OutfitLayerStatus = 'worn' | 'disheveled' | 'removed';

export interface OutfitLayerState {
  /** 这层是什么衣物（英文 tag 指纹，如 "black sheer lace bra"）；removed 时保留最后一次的值。 */
  tag: string;
  status: OutfitLayerStatus;
  /** disheveled 时的形态词（"unbuttoned, off shoulder" / "lifted above chest"）。 */
  stateTag?: string;
}

export interface CharOutfitState {
  name: string;
  /** 这身衣服是什么场合的（"school morning" / "bath"），换装时给人看的提示。 */
  sceneHint?: string;
  layers: Record<OutfitLayerKey, OutfitLayerState>;
}

export interface OutfitSetOp {
  op: 'set_outfit';
  name: string;
  sceneHint?: string;
  layers: Partial<Record<OutfitLayerKey, OutfitLayerState>>;
}

export interface OutfitUpdateLayerOp {
  op: 'update_layer';
  name: string;
  layer: OutfitLayerKey;
  status: OutfitLayerStatus;
  tag?: string;
  stateTag?: string;
}

export type RawOutfitOp = OutfitSetOp | OutfitUpdateLayerOp;

/** 落进楼层 extra 的一条操作：sourceLine 是它生效的物理行（P 节点对应的行）。 */
export interface StoredOutfitOp {
  sourceLine: number;
  op: RawOutfitOp;
}

export interface OutfitFloorDelta {
  v: 1;
  swipe: number;
  ops: StoredOutfitOp[];
}

export const BBI_OUTFIT_EXTRA_KEY = 'bbiOutfitOps';

export function emptyOutfitLayers(): Record<OutfitLayerKey, OutfitLayerState> {
  return {
    outer: { tag: '', status: 'removed' },
    bra: { tag: '', status: 'removed' },
    bottom: { tag: '', status: 'removed' },
    panties: { tag: '', status: 'removed' },
    hosiery: { tag: '', status: 'removed' },
  };
}

export function cloneOutfitState(state: CharOutfitState): CharOutfitState {
  return {
    name: state.name,
    ...(state.sceneHint ? { sceneHint: state.sceneHint } : {}),
    layers: {
      outer: { ...state.layers.outer },
      bra: { ...state.layers.bra },
      bottom: { ...state.layers.bottom },
      panties: { ...state.layers.panties },
      hosiery: { ...state.layers.hosiery },
    },
  };
}

export function cloneOutfitMap(map: Map<string, CharOutfitState>): Map<string, CharOutfitState> {
  const next = new Map<string, CharOutfitState>();
  for (const [key, value] of map.entries()) next.set(key, cloneOutfitState(value));
  return next;
}

/**
 * 回放一组操作。`set_outfit` 是整体换装：五层先全部清空再套用给定层，
 * 这样「换了一身」不会把上一身的残留层留在身上。`update_layer` 只动一层。
 */
export function applyOutfitOps(
  base: Map<string, CharOutfitState>,
  ops: RawOutfitOp[],
): Map<string, CharOutfitState> {
  const next = cloneOutfitMap(base);
  for (const op of ops) {
    const name = op.name.trim();
    if (!name) continue;
    let entry = next.get(name);
    if (!entry) {
      // 新角色默认五层全空（=还没写过任何衣服），由 set_outfit 一次填满。
      entry = { name, layers: emptyOutfitLayers() };
      next.set(name, entry);
    }

    if (op.op === 'set_outfit') {
      if (op.sceneHint) entry.sceneHint = op.sceneHint;
      const fresh = emptyOutfitLayers();
      for (const key of OUTFIT_LAYER_KEYS) {
        const incoming = op.layers[key];
        if (!incoming) continue;
        fresh[key] = {
          tag: incoming.tag.trim(),
          status: incoming.status,
          ...(incoming.stateTag?.trim() ? { stateTag: incoming.stateTag.trim() } : {}),
        };
      }
      entry.layers = fresh;
      continue;
    }

    const previous = entry.layers[op.layer];
    const nextTag = op.tag?.trim() ? op.tag.trim() : previous.tag;
    // 只有 disheveled 保留形态词；穿回去或脱掉时旧形态词必须消失，
    // 否则「已经穿好了」的画面里会继续挂着「半敞」。
    const nextStateTag =
      op.status === 'disheveled' ? (op.stateTag?.trim() || previous.stateTag || '') : '';
    entry.layers[op.layer] = {
      tag: nextTag,
      status: op.status,
      ...(nextStateTag ? { stateTag: nextStateTag } : {}),
    };
  }
  return next;
}

export function readOutfitFloorDelta(message: STMessage | undefined): OutfitFloorDelta | null {
  const raw = (message?.extra as Record<string, unknown> | undefined)?.[BBI_OUTFIT_EXTRA_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.v !== 1 || typeof obj.swipe !== 'number' || !Array.isArray(obj.ops)) return null;
  const ops: StoredOutfitOp[] = [];
  for (const item of obj.ops) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.sourceLine !== 'number' || !record.op || typeof record.op !== 'object') continue;
    ops.push({ sourceLine: record.sourceLine, op: record.op as RawOutfitOp });
  }
  return { v: 1, swipe: obj.swipe, ops };
}

export function makeOutfitFloorDelta(
  ops: StoredOutfitOp[],
  swipe: number,
): OutfitFloorDelta | undefined {
  return ops.length ? { v: 1, swipe, ops } : undefined;
}

/**
 * 从第 0 楼顺序回放到 upToExclusive（不含）：每楼的增量只在该楼当前 swipe 匹配时生效。
 *
 * swipe 不匹配就整楼跳过，而不是「尽力合并」——一条来自另一个 swipe 的「已脱」混进来，
 * 会让切回去的那条分支凭空裸体。
 */
export function deriveOutfitStates(
  chat: STMessage[],
  upToExclusive = chat.length,
): Map<string, CharOutfitState> {
  let state = new Map<string, CharOutfitState>();
  const end = Math.min(upToExclusive, chat.length);
  for (let floor = 0; floor < end; floor += 1) {
    const message = chat[floor];
    const delta = readOutfitFloorDelta(message);
    if (!delta) continue;
    const currentSwipe = typeof message?.swipe_id === 'number' ? message.swipe_id : 0;
    if (delta.swipe !== currentSwipe) continue;
    state = applyOutfitOps(
      state,
      delta.ops.map(item => item.op),
    );
  }
  return state;
}

export function outfitStatesBeforeFloor(floor: number): Map<string, CharOutfitState> {
  const chat = getContext()?.chat ?? [];
  return deriveOutfitStates(chat, Math.max(0, floor));
}

/** 本楼某个 P 节点那一刻的状态：楼前快照 + 本楼已生效的增量（按行号排序）。 */
export function outfitAtPosition(
  baseBeforeFloor: Map<string, CharOutfitState>,
  floorOps: StoredOutfitOp[],
  sourceLine: number,
): Map<string, CharOutfitState> {
  const activeOps = floorOps
    .filter(item => item.sourceLine <= sourceLine)
    .sort((left, right) => left.sourceLine - right.sourceLine)
    .map(item => item.op);
  return applyOutfitOps(baseBeforeFloor, activeOps);
}

/** 喂给状态填表通道的 P0 快照文本（只给存在过的角色，空则提示用 set_outfit 初始化）。 */
export function buildOutfitSnapshotText(states: Map<string, CharOutfitState>): string {
  if (states.size === 0) {
    return '【本楼起始五层服装快照 | P0】\n（当前为空：本楼首次出场的角色请用 set_outfit 初始化五层服装）';
  }
  const lines: string[] = ['【本楼起始五层服装快照 | P0】'];
  for (const state of states.values()) {
    const parts = OUTFIT_LAYER_KEYS.map(key => {
      const layer = state.layers[key];
      const statusText =
        layer.status === 'removed'
          ? 'removed(已脱)'
          : layer.status === 'disheveled'
            ? `disheveled(${layer.stateTag || '半敞'})`
            : 'worn(穿着)';
      return `${key}=${layer.tag || '-'}:${statusText}`;
    });
    lines.push(
      `- ${state.name}${state.sceneHint ? ` [${state.sceneHint}]` : ''}: ${parts.join(' | ')}`,
    );
  }
  return lines.join('\n');
}