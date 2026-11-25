import { affirmedCue } from './frameAnchor';
import type { ImageInsertion } from './protocol';
import { ONEPIECE_GARMENT, type CharacterWardrobe, type WardrobeSlotKey } from '@/state/outfitState';

type Clearance = NonNullable<ImageInsertion['clearLayers']>;
const DIRECT = /直接|贴住|贴在|紧贴|夹[住在上]|碰到|触到|敷在|按在|绑在|系在|\b(?:against (?:bare |the )?skin|direct contact|touches?|fastens?|clips?)\b/i;
const OVER_CLOTHES = /隔着|隔衣|透过.{0,5}(?:衣|裤)|(?:在|从).{0,8}衣服外|\b(?:over|through) (?:her |his |the )?(?:clothes|clothing|shirt|pants|skirt)\b/i;
const CONTACT_REGION = {
  top: /肩|颈|胸|背|锁骨|上身|上臂|\b(?:upper body|shoulder|back|chest|neck|upper arm)\b/i,
  bottom: /腰|臀|大腿|腿根|胯|腹|下身|下体|下半身|\b(?:lower body|waist|hip|thigh|abdomen)\b/i,
};
const ATTACHMENT = /(?:夹子|夹具|夹钳).{0,12}(?:夹住|夹在|固定在)/;

/** 触点必须由该帧已发生的正文支持。画面约束不写成角色穿脱事件。 */
export function readContactLayers(raw: unknown, image: ImageInsertion, clauses: string[]): Clearance | undefined {
  if (!image.sourceCue) return;
  const result: Clearance = [];
  if (Array.isArray(raw)) for (const item of raw.slice(0, 4)) {
    if (!Array.isArray(item) || item.length !== 3) continue;
    const [name, region, evidence]: unknown[] = item;
    if (typeof name !== 'string' || (region !== 'top' && region !== 'bottom') || typeof evidence !== 'string' || evidence.length < 4
      || evidence.length > 160 || !DIRECT.test(evidence) || !CONTACT_REGION[region].test(evidence) || OVER_CLOTHES.test(evidence)
      || !image.characters.some(c => c.name === name)
      || !clauses.some(part => affirmedCue(part, evidence) && !OVER_CLOTHES.test(part))) continue;
    result.push({ name, region });
  }
  // 旧导演的夹具镜头已有准确触点标题时，也能避免补进挡住触点的下装。
  if (!result.length && image.characters.length === 1 && ATTACHMENT.test(image.sourceCue)
    && /\b(?:clips?|clamps?|fastens?) (?:on |to )?(?:her |his |their )?lower body\b/i.test(image.nl)
    && !clauses.some(part => OVER_CLOTHES.test(part))) {
    result.push({ name: image.characters[0].name, region: 'bottom' });
  }
  return result.length ? result : undefined;
}

export function projectContactWardrobe(shot: ImageInsertion, state: Map<string, CharacterWardrobe>): Map<string, CharacterWardrobe> {
  if (!shot.clearLayers?.length) return state;
  const projected = new Map(state);
  for (const { name, region } of shot.clearLayers) {
    const wardrobe = projected.get(name);
    if (!wardrobe) continue;
    const next = { ...wardrobe };
    const clear = (key: WardrobeSlotKey) => {
      const slot = next[key];
      if (slot && slot.status !== 'off') next[key] = { tag: slot.tag, style: slot.style, status: 'off' };
    };
    const onePiece = next.top?.status !== 'off' && ONEPIECE_GARMENT.test(next.top?.tag ?? '');
    const bothRegions = shot.clearLayers.some(layer => layer.name === name && layer.region !== region);
    if (onePiece && bothRegions) clear('top');
    else if (onePiece && next.top) {
      next.top = { ...next.top, status: region === 'top' ? 'half_top' : 'half_bottom', reveal: 'layer',
        halfTag: region === 'top' ? 'upper opening moved aside' : 'hem shifted aside' };
    }
    if (region === 'top') {
      clear('outer');
      if (!onePiece) clear('top');
      clear('innerTop');
    } else {
      clear('bottom');
      clear('innerBottom');
    }
    projected.set(name, next);
  }
  return projected;
}
