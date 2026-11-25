import type { TargetSegment } from './clean';

/** 行号决定插图位置。可选子句号决定这张图在该行里取哪个时点。 */
export function storyClauses(text: string): string[] {
  // 中文逗号常把两个先后动作写在同一行。引语保留为一个单位，避免把台词里的命令当作事件。
  return (text.match(/(?:“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"|[^，,。！？；;!?”」』"\r\n]|\.(?!\s|$))+/g) ?? [])
    .flatMap(part => part.split(/\.\s+(?=[A-Z])/))
    .map(part => part.trim()).filter(Boolean);
}

export function storyClause(segments: TargetSegment[], position: string, value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return;
  const segment = segments.find(item => item.id === position);
  if (segment && value <= storyClauses(segment.text).length) return value;
}

export function momentPromptText(segments: TargetSegment[]): string {
  return segments.map(({ id, text }) => {
    const clauses = storyClauses(text);
    if (clauses.length <= 1) return `${text} ⟦${id}⟧`;
    // 只插定位符，标点、引号和原文全部保留。
    let cursor = 0;
    const markers = clauses.flatMap((clause, index) => {
      const at = text.indexOf(clause, cursor);
      if (at < 0) return [];
      cursor = at + clause.length;
      return [{ at, index }];
    });
    let marked = text;
    for (const { at, index } of markers.reverse()) {
      marked = marked.slice(0, at) + `⟦${index + 1}⟧` + marked.slice(at);
    }
    return `${marked} ⟦${id}⟧`;
  }).join('\n\n');
}

type StoryMoment = { sourceLine: number; clause?: number; step?: number };

export function compareStoryMoments(a: StoryMoment, b: StoryMoment): number {
  return a.sourceLine - b.sourceLine || (a.clause ?? 0) - (b.clause ?? 0) || (a.step ?? 0) - (b.step ?? 0);
}
