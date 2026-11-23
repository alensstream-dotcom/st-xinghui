import { getContext, type STMessage } from '@/st/context';

/**
 * 结楼穿搭指纹（服装账本 v2）。
 *
 * v1 是按 P 节点逐层微操作的「五层状态机」(set_outfit / update_layer)，实践中两条通道对
 * 同一楼的穿脱会给出互相矛盾的微操作，回放出来就左右互搏。v2 改成：
 *   - 每楼只记「本楼结束时」各女角的最终穿搭快照（`wearing` 自由词串 + 可选的 `removed`
 *     类目与 `stateNote` 局部状态）；
 *   - 楼内的 P1/P2/P15 穿脱由导演通道在当帧自己给出（characters[].outfit / removed），
 *     不再落盘成微操作；
 *   - 读取时仍从第 0 楼顺序回放、按 swipe 过滤，删楼改楼切分支依然自洽。
 *
 * 与 `charTags.ts` 同构：状态永远由「现在还活着的那些楼层」推出来，不留会漂的全局快照。
 */

export interface CharOutfitSnapshot {
  name: string;
  /** 本楼结束时该角色身上的完整服装视觉指纹（自由英文逗号词串，全裸留空 ""）。 */
  wearing: string;
  /** 本楼结束时已明确脱掉的部位/衣物类目（如 ["bra"]、["outer","panties"]）。 */
  removed?: string[];
  /** 可选：当前局部状态备注（"robe open front" / "skirt lifted"）。 */
  stateNote?: string;
}

export interface OutfitFloorSnapshotDelta {
  v: 2;
  swipe: number;
  snapshots: CharOutfitSnapshot[];
}

export const BBI_OUTFIT_EXTRA_KEY = 'bbiOutfitOps';

/** 衣物类目的中文标签（面板展示用）。 */
export const OUTFIT_REMOVED_LABELS: Record<string, string> = {
  outer: '外衣',
  top: '上衣',
  shirt: '衬衫',
  dress: '裙装',
  robe: '长袍',
  hanfu: '汉服',
  bra: '胸罩',
  dudou: '肚兜',
  underwear: '内衣',
  bottom: '下装',
  skirt: '裙子',
  pants: '裤子',
  shorts: '短裤',
  panties: '内裤',
  hosiery: '袜/鞋',
  pantyhose: '丝袜',
  stockings: '长袜',
  socks: '袜子',
};

function normaliseRemoved(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const word = item.trim().toLowerCase();
    if (!word || seen.has(word)) continue;
    seen.add(word);
    result.push(word);
  }
  return result;
}

function normaliseSnapshot(raw: unknown): CharOutfitSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!name) return null;
  const wearing = typeof record.wearing === 'string' ? record.wearing.trim() : '';
  const removed = normaliseRemoved(record.removed);
  const stateNote = typeof record.stateNote === 'string' ? record.stateNote.trim() : '';
  return {
    name,
    wearing,
    ...(removed.length ? { removed } : {}),
    ...(stateNote ? { stateNote } : {}),
  };
}

/**
 * 读一楼的结楼穿搭增量。旧版 v1（五层 ops）存档一律安全忽略返回 null——
 * 换代后老聊天里的旧记录不能让它解析出错，更不能被当成「全裸」。
 */
export function readOutfitFloorDelta(
  message: STMessage | undefined,
): OutfitFloorSnapshotDelta | null {
  const raw = (message?.extra as Record<string, unknown> | undefined)?.[BBI_OUTFIT_EXTRA_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.v !== 2 || typeof obj.swipe !== 'number' || !Array.isArray(obj.snapshots)) return null;
  const snapshots: CharOutfitSnapshot[] = [];
  for (const item of obj.snapshots) {
    const snapshot = normaliseSnapshot(item);
    if (snapshot) snapshots.push(snapshot);
  }
  return { v: 2, swipe: obj.swipe, snapshots };
}

export function makeOutfitFloorDelta(
  snapshots: CharOutfitSnapshot[],
  swipe: number,
): OutfitFloorSnapshotDelta | undefined {
  const cleaned = snapshots
    .map(snapshot => normaliseSnapshot(snapshot))
    .filter((snapshot): snapshot is CharOutfitSnapshot => snapshot !== null);
  return cleaned.length ? { v: 2, swipe, snapshots: cleaned } : undefined;
}

/**
 * 从第 0 楼回放到 upToExclusive（不含）：每楼的快照按角色名覆盖合并。
 * swipe 不匹配就整楼跳过，避免另一条分支的「已脱」混进来让人凭空裸体。
 */
export function deriveOutfitSnapshots(
  chat: STMessage[],
  upToExclusive = chat.length,
): Map<string, CharOutfitSnapshot> {
  const state = new Map<string, CharOutfitSnapshot>();
  const end = Math.min(upToExclusive, chat.length);
  for (let floor = 0; floor < end; floor += 1) {
    const message = chat[floor];
    const delta = readOutfitFloorDelta(message);
    if (!delta) continue;
    const currentSwipe = typeof message?.swipe_id === 'number' ? message.swipe_id : 0;
    if (delta.swipe !== currentSwipe) continue;
    for (const snapshot of delta.snapshots) {
      state.set(snapshot.name, { ...snapshot, ...(snapshot.removed ? { removed: [...snapshot.removed] } : {}) });
    }
  }
  return state;
}

export function outfitStatesBeforeFloor(floor: number): Map<string, CharOutfitSnapshot> {
  const chat = getContext()?.chat ?? [];
  return deriveOutfitSnapshots(chat, Math.max(0, floor));
}

/** 喂给两个通道的「上一楼结尾穿搭指纹」文本。 */
export function buildOutfitSnapshotText(states: Map<string, CharOutfitSnapshot>): string {
  if (states.size === 0) {
    return '（上一楼无服装记录，请按正文实际描写确定初始穿搭指纹）';
  }
  const lines: string[] = [];
  for (const snapshot of states.values()) {
    const parts = [`穿着[${snapshot.wearing || '全裸'}]`];
    if (snapshot.removed?.length) parts.push(`已脱[${snapshot.removed.join(', ')}]`);
    if (snapshot.stateNote) parts.push(`状态[${snapshot.stateNote}]`);
    lines.push(`- ${snapshot.name}：${parts.join('｜')}`);
  }
  return lines.join('\n');
}