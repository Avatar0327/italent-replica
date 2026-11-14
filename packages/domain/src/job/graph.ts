/**
 * 职务职级图谱的布局与不规范判定（F-474-7b；docs/08_设计/F-474-7a_职务职级图谱_设计.md §3.2、§4.1）。
 * 纯函数：输入是某一时点已按字段清单投影好的五类对象，输出是矩阵布局与待确认记录；超限整体抛错，不返回部分结果。
 * 排序一律用确定性键（名称、ID），保证输入乱序时结果相同。
 */

export interface JobGraphRecord {
  id: string;
  name: string;
  enabled: boolean;
  startDate: string;
  stopDate: string;
  grade?: number | null;
  levelTypeId?: string | null;
  minGradeId?: string | null;
  maxGradeId?: string | null;
  parentId?: string | null;
  sequenceId?: string | null;
  minLevelId?: string | null;
  maxLevelId?: string | null;
  displayOrder?: number | null;
  code?: string | null;
}

export interface JobGraphInput {
  grades: JobGraphRecord[];
  levelTypes: JobGraphRecord[];
  levels: JobGraphRecord[];
  sequences: JobGraphRecord[];
  posts: JobGraphRecord[];
}

export const JOB_GRAPH_REASONS = [
  'LEVEL_GRADE_RANGE_EMPTY',
  'LEVEL_TYPE_DISABLED',
  'LEVEL_GRADE_RANGE_OVERLAP',
  'POST_LEVEL_RANGE_EMPTY',
  'POST_SEQUENCE_EMPTY',
  'POST_SEQUENCE_HAS_CHILDREN',
  'POST_BOUND_LEVEL_OVERLAP',
  'POST_BOUND_LEVEL_TYPE_DISABLED',
  'POST_BOUND_LEVEL_GRADE_EMPTY',
] as const;
export type JobGraphReasonCode = (typeof JOB_GRAPH_REASONS)[number];

export interface JobGraphReason {
  readonly code: JobGraphReasonCode;
  readonly params: string[];
}
export interface JobGraphIssue {
  readonly objectId: string;
  readonly objectName: string;
  readonly kind: 'level' | 'post';
  readonly reasons: JobGraphReason[];
}

export interface JobGraphSequenceNode {
  readonly id: string;
  readonly name: string;
  readonly depth: number;
  readonly column: number;
  readonly colspan: number;
  readonly rowspan: number;
  readonly children: JobGraphSequenceNode[];
}
export interface JobGraphLayout {
  readonly headerRows: number;
  readonly rowGrades: { id: string; grade: number; name: string }[];
  readonly levelColumns: {
    typeId: string;
    name: string;
    colorKey: number;
    cells: { levelId: string; name: string; fromRow: number; toRow: number }[];
  }[];
  readonly sequenceColumns: JobGraphSequenceNode[];
  readonly postCells: { sequenceId: string; row: number; names: string[]; colorKey: number }[];
  /** 坐标为整张表的 0 起始行列：第 0 列是职等，随后是职级类别列，再是职务序列叶子列。 */
  readonly merges: { fromRow: number; toRow: number; fromColumn: number; toColumn: number }[];
}
export interface JobGraphResult {
  readonly empty: boolean;
  readonly issues: JobGraphIssue[];
  readonly layout: JobGraphLayout;
}

/** 上限是设计 §4.1-7 的预算假设；超限整单拒绝。 */
export const JOB_GRAPH_LIMITS = { posts: 5000, columns: 300, cells: 100000, text: 32767, bytes: 4 * 1024 * 1024 };
export type JobGraphLimitCode =
  'GRAPH_LIMIT_POSTS' | 'GRAPH_LIMIT_COLUMNS' | 'GRAPH_LIMIT_CELLS' | 'GRAPH_LIMIT_TEXT' | 'GRAPH_LIMIT_BYTES';
export class JobGraphLimitError extends Error {
  constructor(readonly code: JobGraphLimitCode) {
    super(code);
    this.name = 'JobGraphLimitError';
  }
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byNameId = (a: JobGraphRecord, b: JobGraphRecord) => compare(a.name, b.name) || compare(a.id, b.id);
const index = (rows: JobGraphRecord[]) => new Map(rows.map((row) => [row.id, row]));

interface LevelState {
  readonly record: JobGraphRecord;
  readonly lo: number | null;
  readonly hi: number | null;
  readonly reasons: JobGraphReason[];
  readonly typeEnabled: boolean;
  readonly overlaps: string[];
}

function gradeRange(level: JobGraphRecord, grades: Map<string, JobGraphRecord>): [number, number] | null {
  const min = level.minGradeId ? grades.get(level.minGradeId) : undefined;
  const max = level.maxGradeId ? grades.get(level.maxGradeId) : undefined;
  if (!min || !max || typeof min.grade !== 'number' || typeof max.grade !== 'number') return null;
  return min.grade <= max.grade ? [min.grade, max.grade] : null;
}

function analyseLevels(input: JobGraphInput, grades: Map<string, JobGraphRecord>): Map<string, LevelState> {
  const types = index(input.levelTypes);
  const levels = input.levels.filter((level) => level.enabled).sort(byNameId);
  const ranges = new Map(levels.map((level) => [level.id, gradeRange(level, grades)]));
  const states = new Map<string, LevelState>();
  for (const level of levels) {
    const range = ranges.get(level.id) ?? null;
    const type = level.levelTypeId ? types.get(level.levelTypeId) : undefined;
    const reasons: JobGraphReason[] = [];
    if (!range) reasons.push({ code: 'LEVEL_GRADE_RANGE_EMPTY', params: [] });
    if (!type?.enabled) reasons.push({ code: 'LEVEL_TYPE_DISABLED', params: type ? [type.name] : [] });
    const overlaps = !range
      ? []
      : levels
          .filter((other) => other.id !== level.id && other.levelTypeId === level.levelTypeId)
          .filter((other) => {
            const against = ranges.get(other.id);
            return against && against[0] <= range[1] && range[0] <= against[1];
          })
          .map((other) => other.name);
    if (overlaps.length) reasons.push({ code: 'LEVEL_GRADE_RANGE_OVERLAP', params: overlaps });
    states.set(level.id, {
      record: level,
      lo: range?.[0] ?? null,
      hi: range?.[1] ?? null,
      reasons,
      typeEnabled: !!type?.enabled,
      overlaps,
    });
  }
  return states;
}

function boundReasons(bound: 'min' | 'max', level: LevelState): JobGraphReason[] {
  const name = level.record.name;
  const reasons: JobGraphReason[] = [];
  for (const reason of level.reasons) {
    if (reason.code === 'LEVEL_GRADE_RANGE_EMPTY')
      reasons.push({ code: 'POST_BOUND_LEVEL_GRADE_EMPTY', params: [bound, name] });
    if (reason.code === 'LEVEL_TYPE_DISABLED')
      reasons.push({ code: 'POST_BOUND_LEVEL_TYPE_DISABLED', params: [bound, name, ...reason.params] });
    if (reason.code === 'LEVEL_GRADE_RANGE_OVERLAP')
      reasons.push({ code: 'POST_BOUND_LEVEL_OVERLAP', params: [bound, name, ...reason.params] });
  }
  return reasons;
}

interface PostState {
  readonly record: JobGraphRecord;
  readonly sequenceId: string | null;
  readonly reasons: JobGraphReason[];
  readonly lo: number;
  readonly hi: number;
  readonly typeId: string | null;
}

function analysePosts(input: JobGraphInput, levels: Map<string, LevelState>, childCount: Map<string, number>) {
  const sequences = index(input.sequences.filter((sequence) => sequence.enabled));
  const states: PostState[] = [];
  for (const post of input.posts.filter((row) => row.enabled).sort(byNameId)) {
    const bounds = (['min', 'max'] as const).flatMap((bound) => {
      const id = bound === 'min' ? post.minLevelId : post.maxLevelId;
      const level = id ? levels.get(id) : undefined;
      return level ? [{ bound, level }] : [];
    });
    const reasons: JobGraphReason[] = [];
    if (!bounds.length) reasons.push({ code: 'POST_LEVEL_RANGE_EMPTY', params: [] });
    const sequence = post.sequenceId ? sequences.get(post.sequenceId) : undefined;
    if (!sequence) reasons.push({ code: 'POST_SEQUENCE_EMPTY', params: [] });
    else if (childCount.get(sequence.id)) reasons.push({ code: 'POST_SEQUENCE_HAS_CHILDREN', params: [sequence.name] });
    const seen = new Set<string>();
    for (const { bound, level } of bounds) {
      if (seen.has(level.record.id)) continue;
      seen.add(level.record.id);
      reasons.push(...boundReasons(bound, level));
    }
    const spans = bounds.flatMap(({ level }) => (level.lo === null || level.hi === null ? [] : [level]));
    states.push({
      record: post,
      sequenceId: sequence?.id ?? null,
      reasons,
      lo: Math.min(...spans.map((level) => level.lo!)),
      hi: Math.max(...spans.map((level) => level.hi!)),
      typeId: bounds[0]?.level.record.levelTypeId ?? null,
    });
  }
  return states;
}

/** 启用序列按 parentId 成树；父级缺失 / 停用的序列当作根，成环的节点永远到不了根，不入图。 */
function sequenceForest(sequences: JobGraphRecord[]) {
  const enabled = sequences.filter((row) => row.enabled);
  const known = new Set(enabled.map((row) => row.id));
  const children = new Map<string, JobGraphRecord[]>();
  const roots: JobGraphRecord[] = [];
  for (const row of enabled.sort(byNameId)) {
    if (row.parentId && known.has(row.parentId) && row.parentId !== row.id) {
      children.set(row.parentId, [...(children.get(row.parentId) ?? []), row]);
    } else roots.push(row);
  }
  return { roots, children };
}

function buildNode(
  row: JobGraphRecord,
  depth: number,
  start: number,
  children: Map<string, JobGraphRecord[]>,
  seen: Set<string>,
): JobGraphSequenceNode {
  seen.add(row.id);
  let cursor = start;
  const kids: JobGraphSequenceNode[] = [];
  for (const child of children.get(row.id) ?? []) {
    if (seen.has(child.id)) continue;
    const node = buildNode(child, depth + 1, cursor, children, seen);
    kids.push(node);
    cursor += node.colspan;
  }
  const colspan = Math.max(1, cursor - start);
  return { id: row.id, name: row.name, depth, column: start, colspan, rowspan: 1, children: kids };
}

function withRowspan(node: JobGraphSequenceNode, headerRows: number): JobGraphSequenceNode {
  const children = node.children.map((child) => withRowspan(child, headerRows));
  return { ...node, children, rowspan: children.length ? 1 : headerRows - node.depth };
}

function leaves(nodes: JobGraphSequenceNode[]): JobGraphSequenceNode[] {
  return nodes.flatMap((node) => (node.children.length ? leaves(node.children) : [node]));
}
const depthOf = (nodes: JobGraphSequenceNode[]): number =>
  nodes.length ? 1 + Math.max(...nodes.map((node) => depthOf(node.children))) : 0;

const postOrder = (a: PostState, b: PostState) =>
  (a.record.displayOrder ?? Number.MAX_SAFE_INTEGER) - (b.record.displayOrder ?? Number.MAX_SAFE_INTEGER) ||
  compare(a.record.code ?? '', b.record.code ?? '') ||
  byNameId(a.record, b.record);

export function buildJobGraph(input: JobGraphInput): JobGraphResult {
  if (input.posts.filter((post) => post.enabled).length > JOB_GRAPH_LIMITS.posts)
    throw new JobGraphLimitError('GRAPH_LIMIT_POSTS');
  const rows = input.grades
    .filter((grade) => grade.enabled && typeof grade.grade === 'number')
    .sort((a, b) => b.grade! - a.grade! || byNameId(a, b));
  const gradeById = index(rows);
  const levels = analyseLevels(input, gradeById);
  const types = input.levelTypes.filter((type) => type.enabled).sort(byNameId);
  const typeColumn = new Map(types.map((type, i) => [type.id, i]));

  const forest = sequenceForest(input.sequences);
  const seen = new Set<string>();
  let cursor = 1 + types.length;
  const built = forest.roots.map((root) => {
    const node = buildNode(root, 0, cursor, forest.children, seen);
    cursor += node.colspan;
    return node;
  });
  const headerRows = Math.max(2, depthOf(built));
  const sequenceColumns = built.map((node) => withRowspan(node, headerRows));
  const leafColumns = leaves(sequenceColumns);
  const columns = cursor;
  if (columns > JOB_GRAPH_LIMITS.columns) throw new JobGraphLimitError('GRAPH_LIMIT_COLUMNS');
  if ((rows.length + headerRows) * columns > JOB_GRAPH_LIMITS.cells) throw new JobGraphLimitError('GRAPH_LIMIT_CELLS');

  const childCount = new Map([...forest.children].map(([id, list]) => [id, list.length]));
  const posts = analysePosts(input, levels, childCount);
  const fit = posts.filter((post) => !post.reasons.length);

  const issues = collectIssues(levels, posts);

  const rowOf = (grade: number) => rows.map((row) => row.grade).findIndex((value) => value === grade);
  const rowRange = (lo: number, hi: number) => {
    const indexes = rows.flatMap((row, i) => (row.grade! >= lo && row.grade! <= hi ? [i] : []));
    return [indexes[0] ?? rowOf(lo), indexes[indexes.length - 1] ?? rowOf(hi)] as const;
  };
  const levelColumns = types.map((type, colorKey) => ({
    typeId: type.id,
    name: type.name,
    colorKey,
    cells: [...levels.values()]
      .filter((level) => !level.reasons.length && level.record.levelTypeId === type.id)
      .map((level) => ({ levelId: level.record.id, name: level.record.name, range: rowRange(level.lo!, level.hi!) }))
      .map(({ levelId, name, range }) => ({ levelId, name, fromRow: range[0], toRow: range[1] }))
      .sort((a, b) => a.fromRow - b.fromRow || compare(a.levelId, b.levelId)),
  }));

  const cells = new Map<string, PostState[]>();
  for (const post of fit) {
    const [from, to] = rowRange(post.lo, post.hi);
    for (let row = from; row <= to; row++) {
      const key = `${post.sequenceId}\u0000${row}`;
      cells.set(key, [...(cells.get(key) ?? []), post]);
    }
  }
  const columnOf = new Map(leafColumns.map((leaf) => [leaf.id, leaf.column]));
  const postCells = [...cells.entries()]
    .map(([key, list]) => {
      const [sequenceId, row] = key.split('\u0000') as [string, string];
      const sorted = [...list].sort(postOrder);
      return {
        sequenceId,
        row: Number(row),
        names: sorted.map((post) => post.record.name),
        colorKey: typeColumn.get(sorted[0]?.typeId ?? '') ?? 0,
      };
    })
    .filter((cell) => columnOf.has(cell.sequenceId))
    .sort((a, b) => a.row - b.row || columnOf.get(a.sequenceId)! - columnOf.get(b.sequenceId)!);

  const layout: JobGraphLayout = {
    headerRows,
    rowGrades: rows.map((row) => ({ id: row.id, grade: row.grade!, name: row.name })),
    levelColumns,
    sequenceColumns,
    postCells,
    merges: layoutMerges(headerRows, types.length, sequenceColumns, levelColumns),
  };
  assertTextAndSize(layout, input);
  return { empty: fit.length === 0, issues, layout };
}

function collectIssues(levels: ReturnType<typeof analyseLevels>, posts: PostState[]): JobGraphIssue[] {
  const fromLevels = [...levels.values()]
    .filter((level) => level.reasons.length)
    .map((level) => ({
      objectId: level.record.id,
      objectName: level.record.name,
      kind: 'level' as const,
      reasons: level.reasons,
    }));
  const fromPosts = posts
    .filter((post) => post.reasons.length)
    .map((post) => ({
      objectId: post.record.id,
      objectName: post.record.name,
      kind: 'post' as const,
      reasons: post.reasons,
    }));
  return [...fromLevels, ...fromPosts];
}

function layoutMerges(
  headerRows: number,
  typeCount: number,
  sequences: JobGraphSequenceNode[],
  levelColumns: JobGraphLayout['levelColumns'],
): JobGraphLayout['merges'] {
  const merges: JobGraphLayout['merges'] = [];
  const add = (fromRow: number, toRow: number, fromColumn: number, toColumn: number) => {
    if (fromRow !== toRow || fromColumn !== toColumn) merges.push({ fromRow, toRow, fromColumn, toColumn });
  };
  add(0, headerRows - 1, 0, 0);
  if (typeCount) add(0, 0, 1, typeCount);
  levelColumns.forEach((type, i) => {
    add(1, headerRows - 1, 1 + i, 1 + i);
    for (const cell of type.cells) add(headerRows + cell.fromRow, headerRows + cell.toRow, 1 + i, 1 + i);
  });
  const walk = (nodes: JobGraphSequenceNode[]) => {
    for (const node of nodes) {
      add(node.depth, node.depth + node.rowspan - 1, node.column, node.column + node.colspan - 1);
      walk(node.children);
    }
  };
  walk(sequences);
  return merges;
}

function assertTextAndSize(layout: JobGraphLayout, input: JobGraphInput): void {
  const texts = [
    ...input.grades.map((row) => String(row.grade ?? '')),
    ...layout.levelColumns.flatMap((type) => [type.name, ...type.cells.map((cell) => cell.name)]),
    ...layout.postCells.map((cell) => cell.names.join(',')),
    ...layout.postCells.flatMap((cell) => cell.names),
    ...layout.rowGrades.map((row) => row.name),
  ];
  const sequenceNames = (nodes: JobGraphSequenceNode[]): string[] =>
    nodes.flatMap((node) => [node.name, ...sequenceNames(node.children)]);
  for (const text of [...texts, ...sequenceNames(layout.sequenceColumns)]) {
    if (text.length > JOB_GRAPH_LIMITS.text) throw new JobGraphLimitError('GRAPH_LIMIT_TEXT');
  }
  if (utf8Length(JSON.stringify(layout)) > JOB_GRAPH_LIMITS.bytes) throw new JobGraphLimitError('GRAPH_LIMIT_BYTES');
}

/** domain 不带 DOM / node 类型库，手算 UTF-8 字节数（JSON.stringify 输出里不会有孤立代理项）。 */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}
