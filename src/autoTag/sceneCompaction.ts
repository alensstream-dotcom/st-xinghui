import type { ImageInsertion } from './protocol';

const FILLER = /^(?:beautiful|highly detailed|incredibly detailed|detailed background|cinematic composition|intricate details|best quality|masterpiece)$/i;
const DETAIL = /^(?:long eyelashes|sanpaku|(?:small )?mole (?:on|under|beside) (?:neck|chin|nose|eye|mouth)|sharp focus)$/i;
const split = (text: string) => text.split(',').map(item => item.trim()).filter(Boolean);
const compactKey = (text: string) => text.toLowerCase().replace(/[’‘]/g, "'").replace(/[.!?\s]+$/g, '').replace(/\s+/g, ' ').trim();

function removeRepeatedSentences(text: string, seen: Set<string>): string {
  return (text.match(/[^.!?]+(?:[.!?]+|$)/g) ?? []).map(sentence => sentence.trim()).filter(sentence => {
    const key = compactKey(sentence);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(' ');
}

export interface SceneBudget {
  fixed: string;
  sharedReference?: number;
}

export function compactGeneratedScene(image: ImageInsertion, budget?: SceneBudget): ImageInsertion {
  const nl = removeRepeatedSentences(image.nl, new Set());
  const baseKey = new Set((nl.match(/[^.!?]+(?:[.!?]+|$)/g) ?? []).map(compactKey));
  const fixed = new Set(split(budget?.fixed ?? '').map(compactKey));
  const baseTags = split(image.tag).filter(token => !FILLER.test(token) || !fixed.has(compactKey(token)));
  const characters = image.characters.map(character => ({
    ...character,
    nl: removeRepeatedSentences(character.nl, new Set(baseKey)),
  }));
  let tag = baseTags.join(', ');
  // 只在共享提示词的旧模型上看近似长度；从可选修饰开始削减，角色身份、衣物、动作与用户画师串都保留。
  if (budget?.sharedReference) {
    const estimated = Math.ceil([budget.fixed, tag, nl, ...characters.flatMap(c => [c.tag, c.nl])].join(', ').length / 4);
    if (estimated >= budget.sharedReference * 0.82) {
      tag = baseTags.filter(token => !FILLER.test(token)).join(', ') || tag;
      for (const character of characters) {
        const tokens = split(character.tag);
        character.tag = tokens.filter(token => !FILLER.test(token) && !DETAIL.test(token)).join(', ') || character.tag;
      }
    }
  }
  return { ...image, tag, nl, characters };
}
