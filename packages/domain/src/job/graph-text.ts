import type { JobGraphLayout, JobGraphReason, JobGraphReasonCode, JobGraphSequenceNode } from './graph.js';

const bound = (side?: string) => (side === 'min' ? '最低' : '最高');
const marked = (names: string[]) => names.map((name) => `【${name}】`).join('、');

/**
 * 职务职级图谱的表头与原因文案（F-474-7a 设计 §3.2、§5）：页面与两种导出共用一份资源（DEC-045），
 * 保证“看到的 = 导出的”；原因按机器码与参数现拼，不存中文。
 */
export const JOB_GRAPH_TEXT = {
  grade: '职等',
  level: '职级',
  kind: '类型',
  kinds: { level: '职级', post: '职务' } as Record<string, string>,
  name: '名称',
  reason: '无法生成图谱原因',
  reasonSeparator: '；',
  unknownReason: '无法识别的原因',
  reasons: {
    LEVEL_GRADE_RANGE_EMPTY: () => '该职级的职等范围为空',
    LEVEL_TYPE_DISABLED: ([type]: string[]) => (type ? `该职级的职级类别【${type}】为停用` : '该职级的职级类别为停用'),
    LEVEL_GRADE_RANGE_OVERLAP: (names: string[]) => `与同一类别的职级${marked(names)}重叠`,
    POST_LEVEL_RANGE_EMPTY: () => '该职务的职级范围为空',
    POST_SEQUENCE_EMPTY: () => '该职务的职务序列为空',
    POST_SEQUENCE_HAS_CHILDREN: ([name]: string[]) => `所属序列【${name ?? ''}】，其下级序列已有职务`,
    POST_BOUND_LEVEL_OVERLAP: ([side, level, ...names]: string[]) =>
      `${bound(side)}职级【${level ?? ''}】的职等范围与同类别职级${marked(names)}重叠`,
    POST_BOUND_LEVEL_TYPE_DISABLED: ([side, level, type]: string[]) =>
      `${bound(side)}职级【${level ?? ''}】，其职级类别${type ? `【${type}】` : ''}为停用`,
    POST_BOUND_LEVEL_GRADE_EMPTY: ([side, level]: string[]) => `${bound(side)}职级【${level ?? ''}】，其职等范围为空`,
  } satisfies Record<JobGraphReasonCode, (params: string[]) => string>,
};

/** 多条原因以“；”串接；未知机器码给统一兜底文案，不把原因码显示给用户。 */
export function jobGraphReasonText(reasons: readonly JobGraphReason[]) {
  const texts = JOB_GRAPH_TEXT.reasons as Record<string, ((params: string[]) => string) | undefined>;
  return reasons
    .map((reason) => texts[reason.code]?.(reason.params) ?? JOB_GRAPH_TEXT.unknownReason)
    .join(JOB_GRAPH_TEXT.reasonSeparator);
}

export interface JobGraphGridCell {
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
 * 把快照放进整张表的格子（设计 §5“不重算布局”）：行列坐标、合并区域都照快照，
 * 这里只按 merges 给锚点格写 rowSpan / colSpan，被合并覆盖的格不输出。页面矩阵与图谱导出共用。
 */
export function jobGraphGrid(layout: JobGraphLayout): JobGraphGridCell[][] {
  const { headerRows } = layout;
  const sequenceLeaves = leaves(layout.sequenceColumns);
  const columns = 1 + layout.levelColumns.length + sequenceLeaves.length;
  const rows = headerRows + layout.rowGrades.length;
  const content = new Map<string, Pick<JobGraphGridCell, 'text' | 'colorKey'>>();
  const put = (row: number, column: number, text: string, colorKey?: number) =>
    content.set(`${row},${column}`, { text, colorKey });
  put(0, 0, JOB_GRAPH_TEXT.grade);
  if (layout.levelColumns.length) put(0, 1, JOB_GRAPH_TEXT.level);
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
