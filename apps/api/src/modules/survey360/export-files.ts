/**
 * 报告 PDF 与结果报表 PNG 的文件生成（F-060，DEC-340④；规格 25 §10.1 ⑱、§10.3 ⑬⑭⑱）：
 * - 原站“报表下载”是整块报表视图的 PNG 截图，个人报告下载是 PDF；本模块只负责把**已经按查看人裁剪好的 JSON**
 *   （score-tables / 报告详情接口 present 之后的响应）排成版面再渲染，不读库、不读答卷、不做任何额外取数，所以文件内容
 *   与接口返回的数据一致：同一权限、同一范围、同一字段裁剪、同一匿名口径（报告快照没有答卷编号 / 评价者标识 / 逐份
 *   答案，DEC-355② / DEC-358②）。版面只打印名称、分数与文本，从不打印任何 ID 键；
 * - 流程：JSON → 版面模型 Doc（纯函数，字体无关，测试直接断言） → 分页排版 → SVG → sharp 栅格化成 PNG；PDF 是把各页
 *   位图作为图像页写入的最小 PDF（无外部依赖，不带时间戳，同一输入字节相同）。因此 PDF 页内文字不可选择 / 搜索，
 *   文本层需要嵌入中文字体，另行决策（见 PR 描述）；
 * - 栅格化依赖系统里有中文字体（fontconfig）：没有时返回 503 EXPORT_FONT_UNAVAILABLE，而不是输出一堆方框；
 * - 上限：报表 300 行、报告 80 页，超过拒绝而不是静默截断（整份文件必须与数据一致，AGENTS §10 批量设上限）。
 */
import { deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { AppError } from '../../errors.js';

export const EXPORT_ROW_LIMIT = 300;
export const EXPORT_PAGE_LIMIT = 80;

// ---- 版面模型 ----------------------------------------------------------------------------------------------------

export type Block =
  | { readonly kind: 'title'; readonly text: string }
  | { readonly kind: 'heading'; readonly text: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'table'; readonly header: readonly string[]; readonly rows: readonly (readonly string[])[] };

export interface Doc {
  /** 文件标题（PDF 信息字典）。 */
  readonly title: string;
  readonly blocks: readonly Block[];
}

/** 控制字符会让 SVG / PDF 变成非法文档；换行保留。 */
const clean = (value: unknown): string => {
  const raw = typeof value === 'string' ? value : value == null ? '' : String(value);
  return [...raw].filter((c) => c === '\n' || (c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)).join('');
};

/** 分数保留 4 位小数（`25` §7）；没有有效分数的格子为空，不加“已屏蔽 / 未作答”标记（§10.3 ⑲）。 */
const fmt = (value: unknown): string => (typeof value === 'number' ? value.toFixed(4) : '');

/** 版面里所有文本（测试与 PR 自查用：文件里出现的每个字都来自这里）。 */
export function docText(doc: Doc): string {
  return [
    doc.title,
    ...doc.blocks.flatMap((b) => (b.kind === 'table' ? [...b.header, ...b.rows.flat()] : [b.text])),
  ].join('\n');
}

// ---- 结果报表（score-tables） -----------------------------------------------------------------------------------

interface ScoreItem {
  objectName?: string;
  department?: string | null;
  position?: string | null;
  questionnaireName?: string;
  itemName?: string | null;
  values?: (number | null)[];
}
interface ScoreColumn {
  scope?: string;
  roleName?: string;
}
export interface ScoreTablesBody {
  level?: string;
  columns?: ScoreColumn[];
  items?: ScoreItem[];
}

const LEVEL_NAMES: Readonly<Record<string, string>> = {
  questionnaire: '总分清单',
  composite: '复合指标得分清单',
  basic: '基础指标得分清单',
  question: '题目得分清单',
};
const ITEM_HEADER: Readonly<Record<string, string>> = { composite: '复合指标', basic: '基础指标', question: '题目' };

export const levelName = (level: string | undefined): string => LEVEL_NAMES[level ?? ''] ?? '得分清单';

function columnName(column: ScoreColumn): string {
  if (column.scope === 'self') return '自评';
  if (column.scope === 'other') return '他评';
  return clean(column.roleName);
}

/** 结果报表版面：整张清单一个表（原站是整块报表视图的截图）。 */
export function scoreTableDocument(body: ScoreTablesBody, meta: { activityName: string }): Doc {
  const items = body.items ?? [];
  if (items.length > EXPORT_ROW_LIMIT)
    throw new AppError('PAYLOAD_TOO_LARGE', `报表超过 ${EXPORT_ROW_LIMIT} 行，不能生成完整截图`, {
      reason: 'EXPORT_TOO_LARGE',
      limit: EXPORT_ROW_LIMIT,
    });
  const columns = body.columns ?? [];
  const showDepartment = items.some((i) => 'department' in i);
  const showPosition = items.some((i) => 'position' in i);
  const showItem = body.level !== undefined && body.level !== 'questionnaire';
  const header = [
    '评价对象',
    ...(showDepartment ? ['部门'] : []),
    ...(showPosition ? ['职位'] : []),
    '套卷',
    ...(showItem ? [ITEM_HEADER[body.level!] ?? '指标'] : []),
    ...columns.map(columnName),
  ];
  const rows = items.map((item) => [
    clean(item.objectName),
    ...(showDepartment ? [clean(item.department)] : []),
    ...(showPosition ? [clean(item.position)] : []),
    clean(item.questionnaireName),
    ...(showItem ? [clean(item.itemName)] : []),
    ...columns.map((_, index) => fmt(item.values?.[index])),
  ]);
  const title = `360度评估结果（${levelName(body.level)}）`;
  return {
    title,
    blocks: [
      { kind: 'title', text: title },
      { kind: 'text', text: clean(meta.activityName) },
      rows.length ? { kind: 'table', header, rows } : { kind: 'text', text: '暂无数据' },
    ],
  };
}

// ---- 个人报告 ----------------------------------------------------------------------------------------------------

type Scored = { name?: string; score?: number | null };
interface Part {
  name?: string;
  preface?: {
    relationTable?: { roleName?: string; completed?: number; invited?: number; rate?: number }[];
    total?: { completed?: number; invited?: number; rate?: number };
    scaleTable?: { label?: string; value?: number | null }[];
  };
  overview?: {
    self?: number | null;
    other?: number | null;
    roles?: { roleName?: string; score?: number | null }[];
    reference?: { value?: number | null };
  };
  strengths?: string | { strengths?: Scored[]; weaknesses?: Scored[]; byRole?: Record<string, string | null>[] };
  bias?: string | { self?: Record<string, unknown>[]; roles?: { name?: string; scores?: Scored[] }[] };
  developmentAdvice?: string | { name?: string; definition?: string | null; score?: number | null }[];
  openFeedback?: { text?: string; roleName?: string }[];
  supplementary?: { question?: string; answers?: { text?: string; roleName?: string }[] }[];
  details?: {
    name?: string;
    level?: string;
    self?: number | null;
    other?: number | null;
    roles?: { roleName?: string; score?: number | null }[];
  }[];
}
export interface ReportBody {
  cover?: Record<string, string | null | undefined>;
  questionnaires?: Part[];
  statement?: string;
}

const text = (value: string): Block => ({ kind: 'text', text: clean(value) });
const heading = (value: string): Block => ({ kind: 'heading', text: value });
const table = (header: string[], rows: string[][]): Block[] => (rows.length ? [{ kind: 'table', header, rows }] : []);
const percent = (value: unknown) => (typeof value === 'number' ? `${value}%` : '');
const count = (value: unknown) => (typeof value === 'number' ? String(value) : '');
const roleScores = (list: { roleName?: string; score?: number | null }[] | undefined) =>
  (list ?? []).map((r) => `${clean(r.roleName)} ${fmt(r.score)}`.trim()).join('；');

/** 缺少数据的模块是原站文案（字符串）；有数据时是结构。 */
function section(title: string, value: unknown, render: (v: never) => Block[]): Block[] {
  if (value === undefined) return [];
  return [heading(title), ...(typeof value === 'string' ? [text(value)] : render(value as never))];
}

const roleLabel = (a: { roleName?: string }) => (a.roleName ? `【${clean(a.roleName)}】` : '');

function prefaceBlocks(preface: NonNullable<Part['preface']>): Block[] {
  const relation = (preface.relationTable ?? []).map((r) => [
    clean(r.roleName),
    count(r.completed),
    count(r.invited),
    percent(r.rate),
  ]);
  const total = preface.total
    ? [['合计', count(preface.total.completed), count(preface.total.invited), percent(preface.total.rate)]]
    : [];
  return [
    heading('前言：评价关系'),
    ...table(['评价角色', '完成人数', '邀请人数', '完成率'], [...relation, ...total]),
    heading('前言：选项分值'),
    ...table(
      ['选项', '分值'],
      (preface.scaleTable ?? []).map((o) => [clean(o.label), o.value == null ? '不计分' : fmt(o.value)]),
    ),
  ];
}

function overviewBlocks(overview: NonNullable<Part['overview']>): Block[] {
  const row = [fmt(overview.self), fmt(overview.other), fmt(overview.reference?.value), roleScores(overview.roles)];
  return [heading('概况'), ...table(['自评均分', '他评均分', '参照标准（80分位）', '各角色得分'], [row])];
}

/** 优势与待发展、认知偏差、发展建议：缺少数据时是原站文案，有数据时是结构。 */
function analysisBlocks(part: Part): Block[] {
  return [
    ...section('优势与待发展', part.strengths, (v: Exclude<Part['strengths'], string | undefined>) => [
      ...table(
        ['他人眼中的优势能力', '得分'],
        (v.strengths ?? []).map((e) => [clean(e.name), fmt(e.score)]),
      ),
      ...table(
        ['他人眼中的待发展能力', '得分'],
        (v.weaknesses ?? []).map((e) => [clean(e.name), fmt(e.score)]),
      ),
      ...table(
        ['评价角色', '最高分指标', '最低分指标'],
        (v.byRole ?? []).map((e) => [clean(e.roleName), clean(e.highest), clean(e.lowest)]),
      ),
    ]),
    ...section('认知偏差', part.bias, (v: Exclude<Part['bias'], string | undefined>) => [
      ...table(
        ['指标', '自评', '他评', '差值'],
        (v.self ?? []).map((e) => [clean(e.name), fmt(e.self), fmt(e.other), fmt(e.gap)]),
      ),
      ...table(
        ['指标', '各角色得分'],
        (v.roles ?? []).map((e) => [clean(e.name), roleScores(e.scores)]),
      ),
    ]),
    ...section('发展建议', part.developmentAdvice, (v: Exclude<Part['developmentAdvice'], string | undefined>) =>
      table(
        ['指标', '定义', '得分'],
        v.map((e) => [clean(e.name), clean(e.definition), fmt(e.score)]),
      ),
    ),
  ];
}

function appendixBlocks(part: Part): Block[] {
  return [
    ...(part.openFeedback
      ? [heading('附录：开放性反馈'), ...part.openFeedback.map((a) => text(`${roleLabel(a)}${clean(a.text)}`))]
      : []),
    ...(part.details
      ? [
          heading('附录：评估详情'),
          ...table(
            ['指标 / 题目', '自评', '他评', '各角色得分'],
            part.details.map((d) => [clean(d.name), fmt(d.self), fmt(d.other), roleScores(d.roles)]),
          ),
        ]
      : []),
    ...(part.supplementary
      ? [
          heading('附录：补充反馈'),
          ...part.supplementary.flatMap((entry) => [
            text(clean(entry.question)),
            ...(entry.answers ?? []).map((a) => text(`${roleLabel(a)}${clean(a.text)}`)),
          ]),
        ]
      : []),
  ];
}

function partBlocks(part: Part): Block[] {
  return [
    { kind: 'title', text: clean(part.name) },
    ...(part.preface ? prefaceBlocks(part.preface) : []),
    ...(part.overview ? overviewBlocks(part.overview) : []),
    ...analysisBlocks(part),
    ...appendixBlocks(part),
  ];
}

/** 标准版个人报告版面（`25` §10.3 ⑬ 的目录顺序）。报告 JSON 里的 id / objectId 等键一概不打印。 */
export function reportDocument(report: ReportBody): Doc {
  const cover = report.cover ?? {};
  const title = `${clean(cover.objectName)} 360度评估个人报告`.trim();
  return {
    title,
    blocks: [
      { kind: 'title', text: title },
      ...table(
        ['项目', '内容'],
        [
          ['活动', clean(cover.activityName)],
          ['评价对象', clean(cover.objectName)],
          ['部门', clean(cover.department)],
          ['职位', clean(cover.position)],
          ['报告模板', clean(cover.templateName)],
          ['生成时间', clean(cover.generatedAt)],
        ].filter((row) => row[1]),
      ),
      ...(report.questionnaires ?? []).flatMap(partBlocks),
      ...(report.statement ? [heading('声明'), text(report.statement)] : []),
    ],
  };
}

// ---- 排版 --------------------------------------------------------------------------------------------------------

type Draw =
  | { t: 'text'; x: number; y: number; size: number; bold: boolean; value: string }
  | { t: 'rect'; x: number; y: number; w: number; h: number; fill: string }
  | { t: 'line'; x1: number; x2: number; y: number };

interface Page {
  readonly width: number;
  height: number;
  readonly draws: Draw[];
}

const A4 = { width: 794, height: 1123 };
const MARGIN = 48;
const SIZE = { title: 26, heading: 18, body: 13, cell: 12 };
const PAD = 6;
const CELL_LINE = Math.round(SIZE.cell * 1.5);
const HEAD_FILL = '#eef1f6';

/** 字宽估算：全角字符 1 em，其余 0.56 em（版面只需要整齐，不需要字距精确）。 */
const advance = (char: string, size: number) => (char.codePointAt(0)! >= 0x2e80 ? size : size * 0.56);

function wrap(value: string, width: number, size: number): string[] {
  const lines: string[] = [];
  for (const paragraph of value.split('\n')) {
    let line = '';
    let used = 0;
    for (const char of paragraph) {
      const w = advance(char, size);
      if (used + w > width && line) {
        lines.push(line);
        line = '';
        used = 0;
      }
      line += char;
      used += w;
    }
    lines.push(line);
  }
  return lines;
}

const textWidth = (value: string, size: number) => [...value].reduce((n, c) => n + advance(c, size), 0);

/** 列宽：按内容估算（封顶），不足整幅时按比例放大，超出时按比例收窄。 */
function columnWidths(header: readonly string[], rows: readonly (readonly string[])[], total: number): number[] {
  const natural = header.map((h, i) =>
    Math.min(
      240,
      Math.max(
        textWidth(h, SIZE.cell),
        ...rows.map((r) => Math.max(...(r[i] ?? '').split('\n').map((l) => textWidth(l, SIZE.cell)))),
      ) +
        2 * PAD,
    ),
  );
  const sum = natural.reduce((a, b) => a + b, 0);
  return natural.map((w) => (w / sum) * total);
}

class Layout {
  readonly pages: Page[] = [];
  private page!: Page;
  private y = 0;

  constructor(
    private readonly width: number,
    /** 单页上限；undefined = 不分页（报表 PNG 一张长图）。 */
    private readonly limit: number | undefined,
  ) {
    this.next();
  }

  private next() {
    this.page = { width: this.width, height: this.limit ?? 0, draws: [] };
    this.pages.push(this.page);
    this.y = MARGIN;
  }

  private needsBreak(height: number): boolean {
    return this.limit !== undefined && this.y + height > this.limit - MARGIN && this.y > MARGIN;
  }

  private ensure(height: number) {
    if (this.needsBreak(height)) this.next();
  }

  private line(value: string, size: number, bold: boolean, gap: number) {
    const lh = Math.round(size * 1.6);
    this.ensure(lh);
    this.page.draws.push({ t: 'text', x: MARGIN, y: this.y + size, size, bold, value });
    this.y += lh + gap;
  }

  block(block: Block) {
    const inner = this.width - 2 * MARGIN;
    if (block.kind === 'table') return this.table(block, inner);
    const size = block.kind === 'title' ? SIZE.title : block.kind === 'heading' ? SIZE.heading : SIZE.body;
    // 标题 / 小节标题与上一块之间留白（页首不留）
    if (this.y > MARGIN) this.y += block.kind === 'title' ? 18 : block.kind === 'heading' ? 10 : 0;
    for (const l of wrap(block.text, inner, size)) this.line(l, size, block.kind !== 'text', 0);
    this.y += block.kind === 'text' ? 6 : 8;
  }

  private rowHeight(cells: readonly string[], widths: readonly number[]): number {
    return Math.max(...cells.map((c, i) => wrap(c, widths[i]! - 2 * PAD, SIZE.cell).length)) * CELL_LINE + 2 * PAD;
  }

  private row(cells: readonly string[], widths: readonly number[], fill: string | undefined, bold: boolean) {
    const height = this.rowHeight(cells, widths);
    this.ensure(height);
    if (fill) this.page.draws.push({ t: 'rect', x: MARGIN, y: this.y, w: this.width - 2 * MARGIN, h: height, fill });
    let x = MARGIN;
    cells.forEach((cell, i) => {
      wrap(cell, widths[i]! - 2 * PAD, SIZE.cell).forEach((value, n) =>
        this.page.draws.push({
          t: 'text',
          x: x + PAD,
          y: this.y + PAD + SIZE.cell + n * CELL_LINE,
          size: SIZE.cell,
          bold,
          value,
        }),
      );
      x += widths[i]!;
    });
    this.y += height;
    this.page.draws.push({ t: 'line', x1: MARGIN, x2: this.width - MARGIN, y: this.y });
  }

  private table(block: Extract<Block, { kind: 'table' }>, inner: number) {
    const widths = columnWidths(block.header, block.rows, inner);
    this.row(block.header, widths, HEAD_FILL, true);
    for (const cells of block.rows) {
      // 换页后重复表头，便于对照
      if (this.needsBreak(this.rowHeight(cells, widths))) {
        this.next();
        this.row(block.header, widths, HEAD_FILL, true);
      }
      this.row(cells, widths, undefined, false);
    }
    this.y += 10;
  }

  finish(): Page[] {
    for (const page of this.pages) if (this.limit === undefined) page.height = Math.max(this.y + MARGIN, 240);
    return this.pages;
  }
}

export function paginate(doc: Doc, mode: 'long' | 'a4'): Page[] {
  const layout = new Layout(mode === 'a4' ? A4.width : 1100, mode === 'a4' ? A4.height : undefined);
  for (const block of doc.blocks) layout.block(block);
  const pages = layout.finish();
  if (pages.length > EXPORT_PAGE_LIMIT)
    throw new AppError('PAYLOAD_TOO_LARGE', `文件超过 ${EXPORT_PAGE_LIMIT} 页，不能生成完整文件`, {
      reason: 'EXPORT_TOO_LARGE',
      limit: EXPORT_PAGE_LIMIT,
    });
  if (mode === 'a4') for (const page of pages) page.height = A4.height;
  return pages;
}

// ---- 栅格化 ------------------------------------------------------------------------------------------------------

const FONT_FAMILY = [
  'Noto Sans CJK SC',
  'Noto Sans SC',
  'Source Han Sans SC',
  'WenQuanYi Zen Hei',
  'WenQuanYi Micro Hei',
  'Microsoft YaHei',
  'PingFang SC',
  'Droid Sans Fallback',
]
  .map((family) => `'${family}'`)
  .concat('sans-serif')
  .join(',');
/** 96 dpi 的版面像素按 1.5 倍栅格化（≈144 dpi）。 */
const DENSITY = 108;

const escapeXml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

function svgOf(page: Page): string {
  const body = page.draws
    .map((d) => {
      if (d.t === 'rect') return `<rect x="${d.x}" y="${d.y}" width="${d.w}" height="${d.h}" fill="${d.fill}"/>`;
      if (d.t === 'line')
        return `<line x1="${d.x1}" y1="${d.y}" x2="${d.x2}" y2="${d.y}" stroke="#c9cfd9" stroke-width="1"/>`;
      const attrs = `x="${d.x}" y="${d.y}" font-size="${d.size}" font-weight="${d.bold ? 700 : 400}" fill="#1f2430"`;
      return `<text ${attrs}>${escapeXml(d.value)}</text>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}" height="${page.height}" font-family="${FONT_FAMILY}">
<rect width="100%" height="100%" fill="#ffffff"/>${body}</svg>`;
}

const rasterize = (page: Page) =>
  sharp(Buffer.from(svgOf(page)), { density: DENSITY }).flatten({ background: '#ffffff' });

/** 系统是否有能画出中文的字体：缺字的“中”和私用区码位画出同样的方框。 */
let fontProbe: Promise<boolean> | undefined;
export function exportFontReady(): Promise<boolean> {
  fontProbe ??= (async () => {
    const glyph = async (char: string) =>
      sharp(
        Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" font-family="${FONT_FAMILY}">` +
            `<rect width="48" height="48" fill="#fff"/><text x="4" y="38" font-size="36">${char}</text></svg>`,
        ),
      )
        .raw()
        .toBuffer();
    try {
      return !(await glyph('中')).equals(await glyph(''));
    } catch {
      return false;
    }
  })();
  return fontProbe;
}

async function requireFont() {
  if (!(await exportFontReady()))
    throw new AppError('SERVICE_UNAVAILABLE', '服务器缺少中文字体，暂时不能生成文件', {
      reason: 'EXPORT_FONT_UNAVAILABLE',
    });
}

/** 报表下载：整块报表视图的 PNG 长图。 */
export async function renderPng(doc: Doc): Promise<Buffer> {
  await requireFont();
  const [page] = paginate(doc, 'long');
  return rasterize(page!).png().toBuffer();
}

// ---- PDF ---------------------------------------------------------------------------------------------------------

const utf16Hex = (value: string) => `<FEFF${Buffer.from(value, 'utf16le').swap16().toString('hex').toUpperCase()}>`;

/** 最小 PDF：每页一张全幅位图（DeviceRGB + Flate）；不写时间戳，同一输入字节相同。 */
export async function renderPdf(doc: Doc): Promise<Buffer> {
  await requireFont();
  const pages = paginate(doc, 'a4');
  const objects: Buffer[] = [];
  const add = (body: string | Buffer) => objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'));
  const pageIds = pages.map((_, i) => 3 + i * 3);
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  for (const [index, page] of pages.entries()) {
    const { data, info } = await rasterize(page).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const flate = deflateSync(data, { level: 9 });
    const id = 3 + index * 3;
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> ` +
        `/Contents ${id + 1} 0 R >>`,
    );
    const content = 'q 595.28 0 0 841.89 0 0 cm /Im0 Do Q';
    add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    add(
      Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace /DeviceRGB ` +
            `/BitsPerComponent 8 /Filter /FlateDecode /Length ${flate.length} >>\nstream\n`,
          'latin1',
        ),
        flate,
        Buffer.from('\nendstream', 'latin1'),
      ]),
    );
  }
  const infoId = objects.length + 1;
  add(`<< /Title ${utf16Hex(doc.title)} /Producer (italent-replica) >>`);

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets: number[] = [];
  let position = chunks[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(position);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    chunks.push(chunk);
    position += chunk.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${position}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}

// ---- 响应头 ------------------------------------------------------------------------------------------------------

/** 附件文件名：RFC 5987 编码，去掉路径与引号等不宜出现在文件名里的字符。 */
export function attachmentName(name: string, extension: 'png' | 'pdf'): string {
  const safe =
    clean(name)
      .replace(/[\\/:*?"<>|\r\n]+/g, '_')
      .slice(0, 120) || 'download';
  return `attachment; filename*=UTF-8''${encodeURIComponent(`${safe}.${extension}`)}`;
}

/** 下载响应：附件、不缓存、禁止嗅探（文件含该查看人才能看到的数据）。 */
export function fileResponse(bytes: Buffer, contentType: string, disposition: string): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-disposition': disposition,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
