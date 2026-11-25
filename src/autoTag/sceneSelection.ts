import type { ImageInsertion } from './protocol';

export interface SceneBeat {
  event: string;
  tier: 'S' | 'A' | 'B';
  phase: 'peak' | 'lead-in' | 'aftermath';
}

export function readSceneBeat(value: unknown): SceneBeat | undefined {
  if (!Array.isArray(value) || value.length !== 3) return;
  const [event, tier, phase] = value;
  if (typeof event !== 'string' || !/^[\p{L}\p{N}_ -]{1,32}$/u.test(event.trim())
    || !(tier === 'S' || tier === 'A' || tier === 'B')
    || !(phase === 'peak' || phase === 'lead-in' || phase === 'aftermath')) return;
  return { event: event.trim().toLowerCase(), tier, phase };
}

/** S/A/B 的配额按候选事件分配，每个事件先选一个成立瞬间。旧计划仍按导演原顺序截取。 */
export function selectStoryImages(candidates: ImageInsertion[], max: number, min: number, distinctPoses = false): ImageInsertion[] {
  const hasBeats = candidates.some(shot => shot.beat);
  if (!hasBeats && !distinctPoses) return candidates.slice(0, max);
  const ranks = { S: 0, A: 1, B: 2 };
  const phaseRank = (shot: ImageInsertion) => shot.beat ? Number(shot.beat.phase !== 'peak') * 2 : 1;
  const ordered = [...candidates].sort((a, b) =>
    phaseRank(a) - phaseRank(b) || (a.beat ? ranks[a.beat.tier] : 3) - (b.beat ? ranks[b.beat.tier] : 3));
  const selected: ImageInsertion[] = [];
  const reserves: ImageInsertion[] = [];
  const events = new Set<string>();
  const poses = new Set<string>();
  for (const shot of ordered) {
    if (distinctPoses && shot.visualPose && poses.has(shot.visualPose)) continue;
    const event = shot.beat?.event;
    if (event && events.has(event)) {
      if (shot.beat?.phase === 'peak') reserves.push(shot);
      continue;
    }
    if (event) events.add(event);
    if (shot.visualPose) poses.add(shot.visualPose);
    selected.push(shot);
    if (selected.length === max) return selected;
  }
  // 只有合格事件不足以满足用户设定的下限，才用一个已经成立且机位不同的备选。
  if (distinctPoses) return selected;
  for (const shot of reserves) {
    if (selected.length >= min) break;
    const previous = selected.find(item => item.beat?.event === shot.beat?.event);
    if (previous && (previous.tag !== shot.tag || previous.size !== shot.size)) selected.push(shot);
  }
  return selected;
}
