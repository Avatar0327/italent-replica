/**
 * 组织调整架构图导出（R2-T08 §10A；§9.3 路由 28；F273A §3 / §6；DEC-644 范围、DEC-650①、DEC-653）。
 * 导出 = 当前预览：同一 `readPreview`（同一 §4.5 裁剪与节点上限），后端只出 SVG 文本与文件名，PNG 由前端栅格化；
 * 同步生成，不落盘、不进附件库。`after=false` 为调整前：本次调整的组织带状态标签与顶边色（停用 / 新增 / 变更）；
 * `after=true` 为调整后：被停用组织连同其下级不出现，节点不显示任何组织状态标记。编制变化箭头不属于状态标记，
 * 两态都画（DEC-653）。节点字段固定为 名称 / 负责人 / 分管领导（复刻无该字段，恒“--”）/ 编制，不含人数；
 * 无值或看不到都显示“--”。没有页眉、图例；文字都是 `<text>`，SVG 尺寸包住整张图。
 */
import type { Tx } from '@italent/db';
import { canSee, type Disclosure } from './disclosure.js';
import { type PreviewNode, readPreview } from './preview.js';
import { orgNamesAt } from './queries.js';

export interface ExportFile {
  /** 不含扩展名：前端按所选格式追加 `.svg` / `.png`，两态同名。 */
  readonly fileName: string;
  readonly svg: string;
}

type Tag = '新增' | '变更' | '停用';

export interface Card {
  readonly name: string;
  readonly tag: Tag | null;
  readonly head: string;
  readonly establishment: number | null;
  /** 编制变化量（调整后 − 原值）；编制生成行随 11e / 11f，此前恒为 null。 */
  readonly delta: number | null;
  readonly children: readonly Card[];
}

const NONE = '--';
const TAGS: Readonly<Record<NonNullable<PreviewNode['mark']>, Tag>> = {
  added: '新增',
  changed: '变更',
  deactivated: '停用',
};

export async function readExport(
  tx: Tx,
  tenantId: string,
  disclosure: Disclosure,
  after: boolean,
  today: string,
): Promise<ExportFile> {
  const preview = await readPreview(tx, tenantId, disclosure);
  const range = canSee(disclosure.fields, 'adjustmentRange') ? disclosure.view.adjustmentRange : [];
  const names = await orgNamesAt(tx, tenantId, range, preview.effectiveDate);
  const label = range.flatMap((id) => (names.has(id) ? [names.get(id)!] : []));
  return { fileName: exportFileName(label, today), svg: renderSvg(exportCards(preview.roots, after)) };
}

/** `架构图（{调整范围组织名}）_{yyyyMMdd}`：日期是下载当天（租户时区），多个组织按选择顺序以“、”连接。 */
export function exportFileName(rangeNames: readonly string[], today: string): string {
  return `架构图（${rangeNames.length ? rangeNames.join('、') : NONE}）_${today.replaceAll('-', '')}`;
}

/** 预览树 → 导出卡片；调整后视图剪掉被停用组织（含下级）并去掉状态标记。 */
export function exportCards(nodes: readonly PreviewNode[], after: boolean): Card[] {
  return nodes.flatMap((node) => {
    if (after && node.mark === 'deactivated') return [];
    const card: Card = {
      name: node.name ?? NONE,
      tag: after || !node.mark ? null : TAGS[node.mark],
      head: node.personInChargeName ?? NONE,
      establishment: node.establishment,
      // TODO(BE-11f)：编制生成行落地后由预览节点给出调整后编制与变化量；被停用组织无箭头。
      delta: null,
      children: exportCards(node.children, after),
    };
    return [card];
  });
}

export interface EstablishmentMark {
  readonly value: string;
  readonly arrow: 'up' | 'down' | null;
  /** 变化量绝对值（不带正负号）；无变化时为 null。 */
  readonly amount: string | null;
  /** 文本形式，如“编制 3↑1”“编制 2↓1”“编制 3”；没有编制为“--”。 */
  readonly label: string;
}

/** 编制标记（DEC-653，F273A 1_12 / 1_16）：有变化时“{调整后值}{↑ / ↓}{变化量}”，否则只有值；没有编制“--”。 */
export function establishmentMark(value: number | null, delta: number | null): EstablishmentMark {
  if (value === null) return { value: NONE, arrow: null, amount: null, label: NONE };
  const arrow = !delta ? null : delta > 0 ? 'up' : 'down';
  const amount = arrow ? String(Math.abs(delta!)) : null;
  const symbol = arrow === 'up' ? '↑' : arrow === 'down' ? '↓' : '';
  return { value: String(value), arrow, amount, label: `编制 ${value}${symbol}${amount ?? ''}` };
}

/** 估算显示宽度（单位 = 一个汉字宽）：全角 / CJK 记 1，其余记 0.6。 */
export function textUnits(text: string): number {
  let units = 0;
  for (const ch of text) units += ch.codePointAt(0)! >= 0x2e80 ? 1 : 0.6;
  return units;
}

/** 超过 max 个单位时截断并以“…”结尾（“…”记 1）；SVG 里就是截断后的文字。 */
export function truncate(text: string, max: number): string {
  if (textUnits(text) <= max) return text;
  let units = 0;
  let kept = '';
  for (const ch of text) {
    const next = units + textUnits(ch);
    if (next > max - 1) break;
    units = next;
    kept += ch;
  }
  return `${kept}…`;
}

export function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// 版式（像素）：自上而下的树，正交连线；多棵树按选择顺序并列。
const W = 260;
const H = 116;
const GAP_X = 24;
const GAP_Y = 48;
const MARGIN = 24;
const NAME_UNITS = 15;
const TAGGED_NAME_UNITS = 11;
const VALUE_X = 84;
const VALUE_UNITS = 13;
const FONT = 12;
const COLORS = { border: '#D9DEE8', text: '#1F2A3D', label: '#8A93A6', line: '#B5BCC8', icon: '#5B8FF9' };
const TAG_COLORS: Readonly<Record<Tag, { edge: string; fill: string; text: string }>> = {
  新增: { edge: '#00AD0E', fill: '#E6F7E8', text: '#00AD0E' },
  变更: { edge: '#1F7AFF', fill: '#E8F1FF', text: '#1F7AFF' },
  停用: { edge: '#B5BCC8', fill: '#F0F1F4', text: '#8A93A6' },
};
const ARROW_COLORS = { up: '#FF475A', down: '#00AD0E' } as const;

interface Placed {
  readonly card: Card;
  readonly x: number;
  readonly y: number;
  readonly children: readonly Placed[];
}

export function renderSvg(roots: readonly Card[]): string {
  const slots = new Map<Card, number>();
  const slot = (card: Card): number => {
    if (!slots.has(card)) {
      const kids = card.children.reduce((sum, child) => sum + slot(child), 0);
      slots.set(card, Math.max(W, kids + GAP_X * Math.max(card.children.length - 1, 0)));
    }
    return slots.get(card)!;
  };
  const place = (card: Card, left: number, depth: number): Placed => {
    const width = slot(card);
    const kids = card.children.reduce((sum, child) => sum + slot(child), 0) + GAP_X * (card.children.length - 1);
    let cursor = left + (width - kids) / 2;
    const children = card.children.map((child) => {
      const placed = place(child, cursor, depth + 1);
      cursor += slot(child) + GAP_X;
      return placed;
    });
    return { card, x: left + (width - W) / 2, y: MARGIN + depth * (H + GAP_Y), children };
  };
  let cursor = MARGIN;
  const placed = roots.map((root) => {
    const tree = place(root, cursor, 0);
    cursor += slot(root) + GAP_X * 2;
    return tree;
  });
  const all = flatten(placed);
  const width = Math.round(Math.max(cursor - GAP_X * 2, MARGIN) + MARGIN);
  const height = Math.round(Math.max(...all.map((p) => p.y + H), MARGIN) + MARGIN);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"`,
    ` font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="${FONT}">`,
    `<rect width="${width}" height="${height}" fill="#FFFFFF"/>`,
    ...all.flatMap(links),
    ...all.map(renderCard),
    '</svg>',
  ].join('');
}

function flatten(nodes: readonly Placed[]): Placed[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function links(parent: Placed): string[] {
  const top = parent.y + H;
  const mid = top + GAP_Y / 2;
  return parent.children.map(
    (child) =>
      `<path d="M${parent.x + W / 2} ${top}V${mid}H${child.x + W / 2}V${child.y}" fill="none" ` +
      `stroke="${COLORS.line}"/>`,
  );
}

const text = (x: number, y: number, value: string, attrs = '') =>
  `<text x="${x}" y="${y}"${attrs}>${escapeXml(value)}</text>`;

function renderCard({ card, x, y }: Placed): string {
  const tag = card.tag ? TAG_COLORS[card.tag] : null;
  const name = truncate(card.name, tag ? TAGGED_NAME_UNITS : NAME_UNITS);
  const field = (row: number, label: string, value: string) => [
    text(12, 56 + row * 24, label, ` fill="${COLORS.label}"`),
    text(VALUE_X, 56 + row * 24, truncate(value, VALUE_UNITS), ` fill="${COLORS.text}"`),
  ];
  return [
    `<g class="org-node" transform="translate(${x} ${y})">`,
    `<rect width="${W}" height="${H}" rx="4" fill="#FFFFFF" stroke="${COLORS.border}"/>`,
    tag ? `<rect width="${W}" height="4" rx="2" fill="${tag.edge}"/>` : '',
    // 组织图标（内嵌矢量，不引用外部资源）
    `<path d="M12 30V12h10v6h8v12zM15 15h4v3h-4zM15 21h4v3h-4zM24 21h3v3h-3z" fill="${COLORS.icon}" ` +
      'fill-rule="evenodd"/>',
    text(36, 26, name, ` font-size="14" font-weight="600" fill="${COLORS.text}"`),
    tag ? `<rect x="${W - 52}" y="12" width="40" height="20" rx="10" fill="${tag.fill}"/>` : '',
    tag ? text(W - 32, 26, card.tag!, ` text-anchor="middle" fill="${tag.text}"`) : '',
    ...field(0, '负责人', card.head),
    ...field(1, '分管领导', NONE),
    renderEstablishment(card),
    '</g>',
  ].join('');
}

/** 编制行：“编制”标签、值、[箭头图形、变化量]。 */
function renderEstablishment(card: Card): string {
  const mark = establishmentMark(card.establishment, card.delta);
  const y = 56 + 2 * 24;
  const parts = [
    text(12, y, '编制', ` fill="${COLORS.label}"`),
    text(VALUE_X, y, mark.value, ` fill="${COLORS.text}"`),
  ];
  if (mark.arrow) {
    const left = VALUE_X + Math.ceil(textUnits(mark.value) * FONT) + 4;
    const points =
      mark.arrow === 'up'
        ? `${left},${y - 1} ${left + 4},${y - 9} ${left + 8},${y - 1}`
        : `${left},${y - 9} ${left + 4},${y - 1} ${left + 8},${y - 9}`;
    parts.push(`<polygon points="${points}" fill="${ARROW_COLORS[mark.arrow]}"/>`);
    parts.push(text(left + 11, y, mark.amount!, ` fill="${ARROW_COLORS[mark.arrow]}"`));
  }
  return `<g class="establishment" aria-label="${escapeXml(mark.label)}">${parts.join('')}</g>`;
}
