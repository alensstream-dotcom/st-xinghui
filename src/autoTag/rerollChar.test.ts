import { describe, expect, it } from 'vitest';
import { parseRerolledAppearance, REROLL_FIELDS } from './rerollChar';

const valid =
  '{"hair":"short hair, black hair, straight hair, high ponytail, blunt bangs","eyes":"amber eyes, tsurime","skin":"tan","body":"petite, athletic, toned, small breasts","extra":"mole under eye, choker"}';

describe('重Roll形象解析', () => {
  it('剥掉 thinking 段与代码块后取 JSON', () => {
    const raw = `<thinking>\n先看正文再设计。\n</thinking>\n\`\`\`json\n${valid}\n\`\`\``;
    const result = parseRerolledAppearance(raw);
    expect(result.hair).toContain('high ponytail');
    expect(result.eyes).toBe('amber eyes, tsurime');
    expect(result.skin).toBe('tan');
    expect(result.extra).toContain('mole under eye');
  });

  it('容忍前后废话与多余字段,只留五个固定外貌字段', () => {
    const raw = `好的,方案如下:\n${valid.slice(0, -1)},"fandom":"x (y)"}\n希望满意。`;
    const result = parseRerolledAppearance(raw);
    expect(Object.keys(result).sort()).toEqual([...REROLL_FIELDS].sort());
  });

  it('漏字段直接报错,不静默填空', () => {
    const raw = '{"hair":"long hair, brown hair, hair down","eyes":"brown eyes, tareme","skin":"fair skin","body":"tall female, medium breasts"}';
    expect(() => parseRerolledAppearance(raw)).toThrow(/漏写了 extra/);
  });

  it('hair 里没有 hair 原子词时报错', () => {
    const raw = '{"hair":"black","eyes":"brown eyes, tareme","skin":"fair skin","body":"petite, slender","extra":"fang"}';
    expect(() => parseRerolledAppearance(raw)).toThrow(/hair/);
  });
});