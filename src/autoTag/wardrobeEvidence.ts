import type { TargetSegment } from './clean';
import { storyClauses } from './storyMoment';
import { WARDROBE_SLOT_KEYS, type CharacterWardrobe, type WardrobeSlotKey, type WardrobeUpdate } from '@/state/outfitState';

const DAY_BREAK = /次日|翌日|隔[天日]|第二[天日]|第[二三四五六七八九十\d]+天|数日后|几天后|一[周月年]后|多年后|the next (?:day|morning)|\b(?:days|weeks|months|years) later\b/i;
const CARRIED_OVER = /(?:仍|依旧|还是|照旧|未|没).{0,12}(?:换衣|原来那身|昨天那身|昨日的|昨天那件|昨天的|同一[套件])|仍[然旧]?没(?:有)?穿|still (?:wear(?:s|ing) the same|hasn.t put .+ back on|isn.t wearing)|(?:without|did not) chang(?:e|ing) (?:clothes|outfits?)/i;
const GARMENT = /衣|袍|衫|裳|裙|裤|褲|袜|襪|鞋|靴|领口|領口|袖口|扣子|拉链|肩带|腰带|围巾|披风|帽子|配饰|抹胸|胸罩|文胸|肚兜|泳装|围裙|袈裟|大氅|长褂|比甲|\b(?:clothes|outfit|suit|dress|shirt|coat|jacket|sweater|robe|skirt|pants|jeans|bra|bra strap|stockings|shoes?|boots?|socks?|collar|hem|sleeves?|zipper|buttons?)\b/i;
const WEAR = /换|脱|褪|卸|穿|着[一件身]|身着|一身|一袭|披上|披着|裹着|套[上下着]|系[上好紧]|解[下开]|敞[开着]|卷[起上]|撩[起开]|掀[起开]|提[起上]|滑[落下]|扯[下开破]|掉[落下]|摘下|裸着|除去|撕破|[扯挣崩]断|修补|缝[好上]|沾[上满]|湿透|浸湿|扣[上紧好]|拉[上开下]|\b(?:wears?|wearing|dressed in|changes? into|remov(?:e|es|ed|ing)|tak(?:es|ing) off|took off|puts? on|unzip\w*|unbutton\w*|fasten\w*|lift\w*|rais\w*|slipp?\w*|tear\w*|torn|repair\w*|soaked)\b/i;
const FULL_REMOVAL = /脱(?:了|得)?(?:个)?精光|脱光(?:了)?|扒光(?:了)?|(?:衣服|衣物|衣裳)(?:全|都|全部).{0,8}(?:脱|褪|除)(?:掉|下|去|光|了)|(?:全身|浑身)赤[裸条]|赤[裸条]着身(?:子|体)|一丝不挂|\b(?:takes?|took|removes?|removed) (?:off )?(?:all (?:her |his |their )?clothes|everything off)\b|\b(?:completely bare|fully undressed)\b/i;
const OUTER_REMOVAL = /(?:脱[了去掉下]|褪[下去])(?:自己|她|他)?(?:身上(?:的)?)?(?:衣服|衣物|衣裳)|(?:衣服|衣物|衣裳)(?:已经|早已)?(?:脱了|脱下|脱掉)|\b(?:took|takes) off (?:her |his |their )?clothes\b/i;
const OUTER_CLOTHES: readonly WardrobeSlotKey[] = ['outer', 'top', 'bottom'];
const TORSO_SLOTS: readonly WardrobeSlotKey[] = ['outer', 'top', 'innerTop', 'bottom', 'innerBottom'];
const ACTUAL_OFF = /(?:脱|褪|卸|摘|取|扯|拽|扒|除)[掉下离去光了]|赤脚|光着脚|没(?:有)?穿|只穿|(?:从|离开).{0,8}(?:手臂|双脚)|\b(?:remov\w*|took off|tak(?:e|es|ing) off|slip\w* out of|pull\w* off)\b/i;
const ACTUAL_ON = /穿(?!过|行|梭|越|插|透)|着[一件身]|身着|披[上回着]|套[上回着]|扣[好上紧回]|拉[好上紧回]|放[下回]|恢复|\b(?:wear\w*|dress\w*|put\w* (?:back )?on|fasten\w*|lower\w*|button\w* up)\b/i;
const REWORN = /穿(?!过|行|梭|越|插|透)|身着|披[上回着]|套[上回着]|换[上成]|\b(?:wears?|wearing|dressed in|puts? (?:it |them |her |his )?(?:back )?on)\b/i;
const REPOSITION = /一只|单只|脱了半|敞|解开|卷|撩|掀|提[起上到至]|滑|松开|[掉落]到|拉开|\b(?:unbutton\w*|unzip\w*|lift\w*|rais\w*|slip\w*|roll\w* up|open\w*)\b/i;
const WEAR_CONDITION = /扯破|撕|破[了损洞]|[挣崩扯拉]?断[了裂开]?|湿透|浸湿|潮湿|湿漉漉|沾|缝[好上]|修补|晾干|\b(?:tore|torn|tear\w*|snapp\w*|broke|broken|repair\w*|soaked|wet|damp|stained|drie\w*)\b/i;
const CHANGE = /换[上成衣装]|更衣|换了|改穿|套上|一[袭身].{0,8}(?:新|改)|\b(?:chang(?:e|es|ed) into|put(?:s)? on)\b/i;
const WHOLE_OUTFIT = /换[了上成]?(?:一套|整套|全套|衣服|装扮|身行头)|更衣完|换装完|new (?:outfit|set of clothes)|changed (?:her |his |their )?(?:outfit|clothes)/i;
const HYPOTHETICAL = /(?:想要|想(?:着|到|去|换|脱|穿)|打算|准备(?:换|脱|穿)|要不要|如果|假如|梦见|本想|没打算|还没|没有去|未曾|没(?:换|脱|穿回|解|摘|撩|掀)|不用(?:换|脱)|别(?:换|脱)|拒绝|叫她换|让她换|命.{0,2}换|希望|\b(?:want\w* to|plan\w* to|consider\w*|would|might|if|asked .{0,30} to|dream\w* of|did not|has not|didn.t)\b)/i;

const SLOT_MENTION: Record<WardrobeSlotKey, RegExp> = {
  outer: /外套|风衣|夹克|西装(?![裤褲]|[长短][裤褲])|大衣|披风|大氅|羽绒|\b(?:coat|jacket|blazer|cloak|cardigan)\b/i,
  top: /上衣|衬[衫衣]|毛衣|卫衣|背心|吊带|[Tt]恤|袍|连[衣身]裙|旗袍|汉服|睡裙|\b(?:shirt|blouse|sweater|turtleneck|hoodie|robe|dress|nightgown)\b/i,
  innerTop: /内衣|胸罩|文胸|抹胸|肚兜|\b(?:bra|bralette)\b/i,
  bottom: /(?<!内|內|亵|褻)[裤褲]|(?<!连衣|连身|睡)裙|\b(?:pants|shorts|jeans|skirt|trousers)\b/i,
  innerBottom: /内裤|亵裤|\b(?:underpants|panties|briefs)\b/i,
  legs: /袜|襪|\b(?:socks?|stockings?|tights|pantyhose)\b/i,
  shoes: /鞋|靴|\b(?:shoes?|heels?|boots?|sandals?|slippers?)\b/i,
};

const QUOTED = /“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"/g;
const NON_PRESENT = /回忆|梦中|照片|画像|画中|脑海|想起|memory|portrait of|photograph of/i;

export function actualText(clause: string): string {
  const narration = clause.replace(QUOTED, '');
  return HYPOTHETICAL.test(narration) || NON_PRESENT.test(narration) ? '' : narration.trim();
}

export function belongsTo(text: string, names: string[], owner: string): boolean {
  const mentioned = names.filter(name => name && text.includes(name));
  const possessors = mentioned.filter(name => text.includes(name + '的') || text.includes(name + "'s"));
  if (possessors.length === 1) return possessors[0] === owner;
  if (mentioned.length < 2) return !mentioned.length || mentioned[0] === owner;
  const beforeFirstVerb = text.split(/换|脱|穿|解开|摘下|扣好|\b(?:wear|change|take|put)\b/i, 1)[0];
  const subjects = mentioned.filter(name => beforeFirstVerb.includes(name));
  const shared = /一起|都|各自|两人|一同|both|together/i.test(text);
  if (subjects.length === 1 || shared) return subjects.includes(owner);
  const nearest = subjects.find(name => beforeFirstVerb.trimEnd().endsWith(name));
  return nearest === owner;
}

const HER_GARMENT = /她(?:的|身上(?:的)?).{0,12}(?:衣服|衣物|上衣|衬衫|内衣|内裤|短裤|裤子|裙子|外套|鞋|袜)|\bher (?:[a-z-]+ ){0,3}(?:clothes|shirt|blouse|skirt|shorts|pants|coat|shoes|socks)\b/i;

function wearingSubject(text: string, cast: string[], soleWoman?: string): string | undefined {
  const possessor = cast.find(name => text.includes(name + '的') && GARMENT.test(text));
  if (possessor) return possessor;
  if (soleWoman && HER_GARMENT.test(text)) return soleWoman;
}

function appliesToWearer(text: string, cast: string[], owner: string, soleWoman?: string): boolean {
  const wearer = wearingSubject(text, cast, soleWoman);
  return wearer ? wearer === owner : belongsTo(text, cast, owner);
}

const COLOR_TEXT: Record<string, RegExp> = {
  black: /黑|墨色|乌色|black/i, white: /白|雪色|white/i, red: /红|赤|绯|朱|red/i,
  blue: /蓝|青蓝|靛|blue/i, navy: /藏蓝|深蓝|navy/i, green: /绿|翠|green/i,
  purple: /紫|purple/i, brown: /棕|褐|brown/i, grey: /灰|gr[ae]y/i, gray: /灰|gr[ae]y/i,
  beige: /米色|卡其|beige/i, ivory: /象牙白|ivory/i, pink: /粉|pink/i, yellow: /黄|yellow/i,
  teal: /蓝绿|青绿|teal/i, gold: /金色|gold/i, cream: /奶白|乳白|cream/i,
};

function observedColor(tag: string | undefined, text: string): boolean {
  const color = (tag ?? '').toLowerCase().split(/[\s,-]+/).find(word => Object.hasOwn(COLOR_TEXT, word));
  return Boolean(color && COLOR_TEXT[color].test(text));
}

export function isWardrobeDayBreak(clause: string): boolean {
  return DAY_BREAK.test(clause)
    && !/前一[日天]|日前|昨天|先前|last (?:year|week)|remember|约好|约在|预定|决定|预约|期待|第二天会|第二天要/i.test(clause);
}

export function explicitlyCarriesWardrobe(text: string): boolean {
  return CARRIED_OVER.test(text);
}

export function changesWardrobe(text: string): boolean {
  return CHANGE.test(text) || WHOLE_OUTFIT.test(text);
}

/** 状态证据限于指定 P 的实际动作；此前的段落只提供跨日时间锚点。 */
export function wardrobeEvidence(update: WardrobeUpdate, segments: TargetSegment[], cast: string[] = [], previous?: CharacterWardrobe, soleWoman?: string) {
  const index = update.position ? segments.findIndex(segment => segment.id === update.position) : -1;
  const text = segments[index]?.text ?? '';
  const clauses = storyClauses(text);
  const statements = (update.clause ? [clauses[update.clause - 1] ?? ''] : clauses)
    .map(actualText).filter(clause => clause && appliesToWearer(clause, cast, update.name, soleWoman));
  let day: string | undefined;
  if (index >= 0 && !CARRIED_OVER.test(text) && belongsTo(text, cast, update.name)) {
    for (const segment of segments.slice(0, Math.max(0, index) + 1)) {
      const points = storyClauses(segment.text);
      const limit = segment.id === update.position ? update.clause ?? points.length : points.length;
      for (let i = 0; i < limit; i++) {
        const clause = actualText(points[i]);
        if (isWardrobeDayBreak(clause)) day = segment.id + '.' + (i + 1);
      }
    }
  }
  const hasGarment = (clause: string) => GARMENT.test(clause) || WARDROBE_SLOT_KEYS.some(key => SLOT_MENTION[key].test(clause));
  const physical = statements.filter(clause => hasGarment(clause) || ACTUAL_OFF.test(clause) || FULL_REMOVAL.test(clause)
    || /穿回|重新穿上|重新扣好|衣扣|rolled (?:it|them) up|put (?:it|them) back on/i.test(clause));
  const changes = statements.filter(clause => hasGarment(clause) && CHANGE.test(clause));
  const matchingSlots = (clauses: string[]) => WARDROBE_SLOT_KEYS.filter(key => clauses.some(clause =>
    SLOT_MENTION[key].test(clause) || key === 'shoes' && /赤脚|光着脚|\bbarefoot\b/i.test(clause)));
  const statusCues = (pattern: RegExp) => {
    const matching = physical.filter(clause => pattern.test(clause));
    const changedSlots = matchingSlots(matching);
    return (key: WardrobeSlotKey) => matching.length > 0 && ((!changedSlots.length && pattern !== ACTUAL_OFF) || changedSlots.includes(key)
      // 0.3.24 的外套和鞋袜可以仍用 top、legs 旧槽。
      || key === 'top' && !previous?.outer && changedSlots.includes('outer')
      || key === 'legs' && !previous?.shoes && changedSlots.includes('shoes'));
  };
  return {
    day,
    observed: (key: WardrobeSlotKey, tag?: string) => Boolean(update.observed && statements.some(clause =>
      SLOT_MENTION[key].test(clause) && (ACTUAL_ON.test(clause) || /一身|一袭|身上是|身上那件/.test(clause))
      && observedColor(tag, clause))),
    specifiedGarment: statements.some(hasGarment),
    motion: physical.some(clause => WEAR.test(clause) || WEAR_CONDITION.test(clause)),
    shoeSide: (() => {
      const wear = physical.filter(line => SLOT_MENTION.shoes.test(line)).join(' ');
      const left = /左(?:脚|边|侧|鞋)|\bleft (?:foot|shoe|boot|slipper)\b/i.test(wear);
      const right = /右(?:脚|边|侧|鞋)|\bright (?:foot|shoe|boot|slipper)\b/i.test(wear);
      return left === right ? undefined : left ? 'left' as const : 'right' as const;
    })(),
    singleShoe: physical.some(line => SLOT_MENTION.shoes.test(line) && /一只|单只|[左右](?:脚|侧|边)|\b(?:one|left|right) (?:foot|shoe|boot|slipper)\b/i.test(line)),
    on: (key: WardrobeSlotKey) => statusCues(previous?.[key]?.status === 'off' ? REWORN : ACTUAL_ON)(key)
      && !physical.some(clause => (FULL_REMOVAL.test(clause) || /没(?:有)?穿|without wearing/i.test(clause))
        && !/穿回|重新穿上|put(?:s)? (?:it |them )?back on/i.test(clause)),
    off: (key: WardrobeSlotKey) => statusCues(ACTUAL_OFF)(key)
      || TORSO_SLOTS.includes(key) && physical.some(clause => FULL_REMOVAL.test(clause))
      || OUTER_CLOTHES.includes(key) && physical.some(clause => OUTER_REMOVAL.test(clause)),
    half: statusCues(REPOSITION),
    condition: statusCues(WEAR_CONDITION),
    replacement: changes.length > 0,
    replacementSlots: matchingSlots(changes),
    whole: statements.some(clause => WHOLE_OUTFIT.test(clause)),
  };
}

/** 从实际穿脱句提取带时点的槽位变动。整套、代词和同段多件不依赖导演逐项重报。 */
export function recoverExplicitWear(
  segments: TargetSegment[],
  cast: string[],
  written: WardrobeUpdate[],
  depicted: ReadonlySet<string>,
  soleWoman?: string,
): WardrobeUpdate[] {
  const events: WardrobeUpdate[] = [];
  const surname = soleWoman?.match(/^[\u3400-\u9fff](?=[\u3400-\u9fff]{1,3}$)/)?.[0];
  const courtesyTitle = surname ? new RegExp('^(?:小' + surname + '姐|' + surname + '(?:小姐|女士|姑娘|夫人))') : undefined;
  const wearVerb = /(?:脱下|脱掉|脱了|脱去|褪下|褪去|褪掉|脱光|扒光|穿回|穿好|穿上原来|重新穿上|\b(?:took off|takes off|removed|puts? .{0,16} back on)\b)/i;
  for (const segment of segments) {
    const clauses = storyClauses(segment.text);
    let subject: string | undefined;
    for (const [index, clause] of clauses.entries()) {
      const statement = actualText(clause);
      const lead = statement.replace(/^(?:随即|接着|随后|然后|此刻|这时|过了一会儿|now|then)\s*/i, '');
      const named = cast.find(name => lead.startsWith(name)) ?? (courtesyTitle?.test(lead) ? soleWoman : undefined);
      if (named) subject = named;
      else if (/^(?:她|she\b)/i.test(lead)) subject = soleWoman;
      else if (/^(?:他|他们|她们|he\b|they\b)/i.test(lead)) subject = undefined;
      const possessor = wearVerb.test(lead) ? wearingSubject(lead, cast, soleWoman) : undefined;
      const owner = possessor ?? subject;
      if (!owner || !depicted.has(owner) || !statement || /^(?:仿佛|好像|据说|传说)|正在准备|想象中|in a dream/i.test(statement)) continue;
      const whole = FULL_REMOVAL.test(statement);
      const outerRemoval = OUTER_REMOVAL.test(statement);
      if (!whole && !outerRemoval && (!wearVerb.test(statement) || /一只|一侧|半|另一|对方的|(?:借|买|换|新)[来上的]/.test(statement))) continue;
      if (!named && !/^(?:她|she\b)/i.test(lead) && !statement.startsWith('把') && !wearVerb.test(lead.slice(0, 10)) && !(whole || outerRemoval)) continue;
      const leadIn = statement.slice(0, wearVerb.exec(statement)?.index ?? statement.length);
      if (!possessor && /看着|看见|看到|听说|吩咐|命令|叫(?:她|他)|让(?:她|他)|要求|\b(?:watched|saw|told|asked|ordered)\b/i.test(leadIn)) continue;
      if (!appliesToWearer(statement, cast, owner, soleWoman)) continue;
      const status = /穿回|穿好|重新穿上|穿上原来|back on/i.test(statement) ? 'on' : 'off';
      const candidates = whole && status === 'off' ? TORSO_SLOTS : outerRemoval && status === 'off' ? OUTER_CLOTHES
        : WARDROBE_SLOT_KEYS.filter(key => SLOT_MENTION[key].test(statement));
      const slots: WardrobeUpdate['slots'] = {};
      for (const key of candidates) {
        const other = written.find(event => event.name === owner && event.position === segment.id && event.slots[key]
          && (event.clause === index + 1 || clauses.length === 1 && !event.clause));
        if (!other || other.slots[key]?.status !== status) slots[key] = { status };
      }
      if (Object.keys(slots).length) events.push({ name: owner, position: segment.id, sourceLine: segment.sourceLine, mode: 'patch',
        clause: clauses.length > 1 ? index + 1 : undefined, slots });
    }
  }
  return events;
}
