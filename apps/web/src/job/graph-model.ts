import type { JobGraphLayout, JobGraphReason, JobGraphSequenceNode } from '@italent/domain';
import { graphText as t } from './messages.js';

/** 授权对象与路由（apps/api/src/modules/job/graph-routes.ts，设计 §4.2 / §4.3）。 */
export const GRAPH_OBJECT = 'TenantBase.JobPostAndJobLevelGraph';
export const GRAPH_PATH = '/api/tenant/job/graph';
/** 图谱每租户只有一份快照（DEC-896 U3）：命令内核的业务 ID 固定，回执与重读据此核对。 */
export const GRAPH_ID = 'job-graph';
export const graphViews = ['graph', 'graph-issues'] as const;
export type GraphView = (typeof graphViews)[number];

export interface GraphSnapshot {
  revision: number;
  asOfDate: string;
  empty: boolean;
  containsError: boolean;
  issueCount: number;
  generatedAt: string;
  layout: JobGraphLayout;
}
export interface GraphIssue {
  kind: 'level' | 'post';
  objectId: string;
  objectName: string;
  reasons: JobGraphReason[];
}
export interface GraphIssuePage {
  items: GraphIssue[];
  total: number;
  page: number;
  pageSize: number;
}

/** 生成时间按租户时区显示 yyyy-MM-dd HH:mm:ss（DEC-056），不用浏览器时区。 */
export function graphTime(instant: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}:${value('second')}`;
}

export function reasonText(reasons: readonly JobGraphReason[]) {
  const texts = t.reasons as Record<string, ((params: string[]) => string) | undefined>;
  return reasons.map((reason) => texts[reason.code]?.(reason.params) ?? t.unknownReason).join(t.reasonSeparator);
}

export function issueQuery(page: { page: number; pageSize: number }, kind: string, name: string) {
  const query = new URLSearchParams({ page: String(page.page), pageSize: String(page.pageSize) });
  if (kind) query.set('kind', kind);
  if (name.trim()) query.set('name', name.trim());
  return query.toString();
}

export interface GridCell {
  row: number;
  column: number;
  text: string;
  rowSpan: number;
  colSpan: number;
  /** 类别色序号（快照 colorKey）；职等列、序列列头没有。 */
  colorKey?: number;
}
const leaves = (nodes: readonly JobGraphSequenceNode[]): JobGraphSequenceNode[] =>
  nodes.flatMap((node) => (node.children.length ? leaves(node.children) : [node]));
const walk = (nodes: readonly JobGraphSequenceNode[]): JobGraphSequenceNode[] =>
  nodes.flatMap((node) => [node, ...walk(node.children)]);

/**
 * 把快照放进整张表的格子（设计 §5“不在前端重算布局”）：行列坐标、合并区域都照快照，
 * 这里只按 merges 给锚点格写 rowSpan / colSpan，被合并覆盖的格不输出。
 */
export function graphGrid(layout: JobGraphLayout): GridCell[][] {
  const { headerRows } = layout;
  const sequenceLeaves = leaves(layout.sequenceColumns);
  const columns = 1 + layout.levelColumns.length + sequenceLeaves.length;
  const rows = headerRows + layout.rowGrades.length;
  const content = new Map<string, Pick<GridCell, 'text' | 'colorKey'>>();
  const put = (row: number, column: number, text: string, colorKey?: number) =>
    content.set(`${row},${column}`, { text, colorKey });
  put(0, 0, t.grade);
  if (layout.levelColumns.length) put(0, 1, t.level);
  layout.levelColumns.forEach((type, i) => {
    put(1, 1 + i, type.name, type.colorKey);
    for (const cell of type.cells) put(headerRows + cell.fromRow, 1 + i, cell.name, type.colorKey);
  });
  for (const node of walk(layout.sequenceColumns)) put(node.depth, node.column, node.name);
  layout.rowGrades.forEach((grade, i) => put(headerRows + i, 0, grade.name));
  const columnOf = new Map(sequenceLeaves.map((leaf) => [leaf.id, leaf.column]));
  for (const cell of layout.postCells) {
    const column = columnOf.get(cell.sequenceId);
    if (column !== undefined) put(headerRows + cell.row, column, cell.names.join(','), cell.colorKey);
  }
  const anchors = new Map(layout.merges.map((merge) => [`${merge.fromRow},${merge.fromColumn}`, merge]));
  const covered = new Set<string>();
  for (const merge of layout.merges)
    for (let row = merge.fromRow; row <= merge.toRow; row++)
      for (let column = merge.fromColumn; column <= merge.toColumn; column++)
        if (row !== merge.fromRow || column !== merge.fromColumn) covered.add(`${row},${column}`);
  return Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column) => column)
      .filter((column) => !covered.has(`${row},${column}`))
      .map((column) => {
        const merge = anchors.get(`${row},${column}`);
        const value = content.get(`${row},${column}`);
        return {
          row,
          column,
          text: value?.text ?? '',
          colorKey: value?.colorKey,
          rowSpan: merge ? merge.toRow - merge.fromRow + 1 : 1,
          colSpan: merge ? merge.toColumn - merge.fromColumn + 1 : 1,
        };
      }),
  );
}
