import type { TargetSegment } from './clean';
import type { ImageInsertion } from './protocol';
import { storyClauses } from './storyMoment';

const INACTIVE_START = /^(?:[“「『"]|如果|假如|要是|想象|回忆|听说|本想|if\b|would\b)/i;
const SCENE_BOUNDARY = /场景切换|镜头(?:切|转)到|转到另一边|翌日|次日|第二天|隔日|几天后|数小时后|\b(?:the next day|hours? later|meanwhile elsewhere)\b/i;
const NEGATED = /(?:并未|并没有|还没(?:有)?|没有|未曾|尚未|没能|差点|本来要|正准备|想要|只是想|期待)(?:[^。！？]{0,22})$|\b(?:not yet|did not|didn.t|nearly|about to|wanted to)(?:[\w '’-]{0,35})$/i;

interface Anchor {
  segment: TargetSegment;
  clause: number;
  cue: string;
}

export const isFrameSceneBoundary = (text: string): boolean => SCENE_BOUNDARY.test(text);

export function affirmedCue(part: string, cue: string): boolean {
  const at = part.indexOf(cue);
  const dialogue = [...part.matchAll(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"/g)];
  return at >= 0 && !dialogue.some(quoted => quoted.index <= at && at < quoted.index + quoted[0].length)
    && !INACTIVE_START.test(part) && !NEGATED.test(part.slice(0, at))
    && !NEGATED.test(cue.slice(0, Math.min(15, cue.length)));
}

function matchesAnchor(clauses: string[], segment: TargetSegment, cue: string): Anchor[] {
  return clauses.flatMap((part, index) => {
    if (!affirmedCue(part, cue)) return [];
    return [{ segment, clause: index + 1, cue }];
  });
}

function findQuote(near: TargetSegment[], position: string, clause: number | undefined, cue: string): Anchor | undefined {
  const matches = near.flatMap(segment => matchesAnchor(storyClauses(segment.text), segment, cue));
  const here = matches.filter(anchor => anchor.segment.id === position);
  return here.find(anchor => anchor.clause === clause) ?? (here.length === 1 ? here[0] : matches.length === 1 ? matches[0] : undefined);
}

/** 兼容旧导演仅在标题中描述固定道具的动作。只从等待段后选择真实发生且唯一的段落。 */
function locatePropAttachment(near: TargetSegment[], image: ImageInsertion): Anchor | undefined {
  if (!/\b(?:clamps?|clips?)\b/i.test(image.tag) || !/\b(?:clips?|pinch(?:es)?|clamps?|fasten(?:s|ed)?)\b/i.test(image.nl)) return;
  const prop = /(?:夹子|夹具|夹钳|\b(?:clamps?|clips?)\b).{0,14}(?:夹在|夹住|夹上|固定在|\b(?:clips?|clamps?|fasten(?:s|ed)?)\b)/i;
  const linked = near.flatMap(segment => storyClauses(segment.text).flatMap((part, index) => {
    const match = prop.exec(part);
    if (!match || !affirmedCue(part, match[0])) return [];
    return [{ segment, clause: index + 1, cue: match[0] }];
  }));
  if (linked.some(anchor => anchor.segment.id === image.position)) return;
  const later = linked.filter(anchor => anchor.segment.sourceLine > image.sourceLine);
  if (new Set(later.map(anchor => anchor.segment.id)).size === 1) return later.at(-1);
}

/** 定位锚在正文中校验。引用可跨相邻段修正 P，但不可跨已知场景切换或跳到预告。 */
export function groundFrameAnchor(image: ImageInsertion, raw: Record<string, unknown>, segments: TargetSegment[], stagingQuote?: unknown): void {
  const index = segments.findIndex(segment => segment.id === image.position);
  if (index < 0) return;
  let start = index;
  let end = index;
  while (start > Math.max(0, index - 3) && !SCENE_BOUNDARY.test(segments[start].text)) start--;
  while (end + 1 < Math.min(segments.length, index + 4) && !SCENE_BOUNDARY.test(segments[end + 1].text)) end++;
  const near = segments.slice(start, end + 1);
  const quotes = [stagingQuote, raw.anchor, Array.isArray(raw.focus) ? raw.focus[1] : undefined]
    .filter((value): value is string => typeof value === 'string' && value.trim().length >= 4 && value.length <= 160);
  const anchor = quotes.map(quote => findQuote(near, image.position, image.clause, quote.trim())).find(Boolean)
    ?? locatePropAttachment(near.slice(index - start), image);
  if (!anchor) return;
  if (image.position !== anchor.segment.id) delete image.step;
  image.position = anchor.segment.id;
  image.sourceLine = anchor.segment.sourceLine;
  image.clause = anchor.clause;
  image.sourceCue = anchor.cue;
}

/** Resolve the declared selection before interpreting any rendering instructions. */
export function pinFrameAnchor(image: ImageInsertion, raw: Record<string, unknown>, segments: TargetSegment[]): boolean {
  const segment = segments.find(item => item.id === image.position);
  const exact = typeof raw.anchor === 'string' ? raw.anchor.trim() : '';
  if (!segment || exact.length < 4 || exact.length > 160 || !image.clause) return false;
  const clauses = storyClauses(segment.text);
  const selected = clauses[image.clause - 1];
  if (!selected || !affirmedCue(selected, exact) || selected.indexOf(exact) !== selected.lastIndexOf(exact)) return false;
  let offset = 0;
  for (const clause of clauses.slice(0, image.clause - 1)) offset = segment.text.indexOf(clause, offset) + clause.length;
  const clauseStart = segment.text.indexOf(selected, offset);
  if (clauseStart < 0) return false;
  const start = clauseStart + selected.indexOf(exact);
  const end = start + exact.length;
  image.sourceCue = exact;
  image.anchor = { exact, start, end, prefix: segment.text.slice(0, start).slice(-32), suffix: segment.text.slice(end, end + 32) };
  return true;
}
