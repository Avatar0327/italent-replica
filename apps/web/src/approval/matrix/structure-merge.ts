// 409 重读后的结构三方合并（F-123 设计「状态与恢复」：比较原基线与最新版本，只回填服务端改了、用户没改的部分，
// 用户修改始终保留）。内核按字段比较，整份结构是一个字段；这里拆到列设置、列 / 行的有无、行顺序与单元格。
// 结构上有歧义的（一边删、另一边在其上改或新增；两边列类型不同；两边都动过的条件列维度不同）不自动定夺：
// 列为结构冲突，未处理时按我的草稿；用户逐项选“采用最新版本”或“保留我的修改”（decided）后按选择重算。
import { sameValue } from '../../foundation/forms/values.js';
import { sm } from './structure-messages.js';
import { kindOf, type DraftColumn, type DraftRow, type Structure } from './structure-model.js';

/** 冲突区的一行：服务端改过的一处，原值 / 最新值 / 我的输入都是给人看的文本。 */
export interface Change {
  field: string;
  label: string;
  before: string;
  latest: string;
  mine: string;
}
/** 须用户逐项处理的结构冲突；key 即冲突区里那一行的 field。 */
export interface Ambiguity {
  key: string;
  label: string;
}
/** 结构冲突的处理：true 采用最新版本，false 保留我的修改；没有的项尚未处理。 */
export type Decided = Readonly<Record<string, boolean>>;
/** 单元格的 id → 显示名（条件列按维度，角色列按人员）。 */
export type Show = (column: DraftColumn, ids: readonly string[]) => string;

type Kind = 'column' | 'row';
interface Sides {
  columns: Map<string, DraftColumn>;
  rows: Map<string, DraftRow>;
}
const byRef = <T extends { ref: string }>(list: readonly T[]) => new Map(list.map((item) => [item.ref, item]));
const refsOf = (list: readonly { ref: string }[]) => list.map((item) => item.ref);
const SETTINGS = ['name', 'dimension', 'includeChildren', 'allowMultiple'] as const;
type Setting = (typeof SETTINGS)[number];

function setting(key: Setting, value: DraftColumn[Setting]) {
  if (typeof value === 'boolean') return value ? sm.yes : sm.no;
  if (key === 'dimension') return value ? sm.dimensionLabel[value]! : '—';
  return value!.trim();
}
/** 列类型的文本：审批角色，或审批条件·维度。 */
const typeText = (column: DraftColumn) =>
  column.kind === 'role' ? sm.kindLabel.role! : `${sm.kindLabel.condition}·${setting('dimension', column.dimension)}`;
/** primary 的顺序为主；secondary 里多出来的项插在它在 secondary 中前一项之后（找不到前一项就放最前）。 */
function weave(primary: readonly string[], secondary: readonly string[], kept: ReadonlySet<string>) {
  const result = primary.filter((ref) => kept.has(ref));
  secondary.forEach((ref, index) => {
    if (!kept.has(ref) || result.includes(ref)) return;
    const before = secondary.slice(0, index).findLast((item) => result.includes(item));
    result.splice(before === undefined ? 0 : result.indexOf(before) + 1, 0, ref);
  });
  return result;
}

class Merger {
  readonly changes: Change[] = [];
  readonly open: Ambiguity[] = [];
  private readonly b: Sides;
  private readonly l: Sides;
  private readonly m: Sides;
  private readonly rowName: Map<string, string>;

  constructor(
    private readonly base: Structure,
    private readonly latest: Structure,
    private readonly mine: Structure,
    private readonly show: Show,
    private readonly decided: Decided,
  ) {
    const sides = (value: Structure) => ({ columns: byRef(value.columns), rows: byRef(value.rows) });
    [this.b, this.l, this.m] = [sides(base), sides(latest), sides(mine)];
    // 行按原基线里的位置称呼（甲打开时看到的行号）；服务端新增的行按最新版本里的位置
    this.rowName = new Map(base.rows.map((row, index) => [row.ref, sm.row(index)]));
    latest.rows.forEach((row, index) => {
      if (!this.rowName.has(row.ref)) this.rowName.set(row.ref, sm.latestRow(index));
    });
  }

  private record(field: string, label: string, values: string[], result: string) {
    const [before, latest, mine] = values as [string, string, string];
    this.changes.push({ field, label: `${label}（${result}）`, before, latest, mine });
  }
  /** 结构冲突：未处理的列入 open（草稿按我的）；返回 true 表示已选采用最新版本。 */
  private ambiguous(field: string, label: string, values: string[], text: string) {
    const take = this.decided[field];
    if (take === undefined) this.open.push({ key: field, label: text });
    const result = take ? sm.tookLatest : sm.keptMine;
    this.record(field, label, values, take === undefined ? sm.ambiguous : result);
    return take === true;
  }
  /** 三方取值：服务端没改取我的；只有服务端改了取最新（回填）；两边都改保留我的。服务端改过的列入冲突区。 */
  private pick<T>(field: string, label: string, [b, l, m]: [T, T, T], text: (value: T) => string) {
    if (sameValue(l, b)) return m;
    const mine = !sameValue(m, b);
    this.record(field, label, [b, l, m].map(text), mine && !sameValue(m, l) ? sm.keptMine : sm.tookLatest);
    return mine ? m : l;
  }
  private columnName(ref: string) {
    return (this.m.columns.get(ref) ?? this.l.columns.get(ref) ?? this.b.columns.get(ref)!).name.trim();
  }
  private cell(side: Sides, row: string, column: string) {
    return side.rows.get(row)?.cells[column] ?? [];
  }
  /** 某一边相对原基线动过这一行 / 列：列设置或其中任一格（新增的行 / 列在原基线里是空格，填了值就算动过）。 */
  private touched(side: Sides, kind: Kind, ref: string) {
    const edited = (row: string, column: string) =>
      !sameValue(this.cell(side, row, column), this.cell(this.b, row, column));
    if (kind === 'row') return [...side.columns.keys()].some((column) => edited(ref, column));
    if (!sameValue(side.columns.get(ref), this.b.columns.get(ref))) return true;
    return [...side.rows.keys()].some((row) => edited(row, ref));
  }

  /** 原基线里的行 / 列：两边都在就保留；一边删了，另一边没动就跟着删，动过（含新增行列里的格）列为结构冲突。 */
  private keep(kind: Kind, ref: string, label: string) {
    const has = (side: Sides) => (kind === 'column' ? side.columns : side.rows).has(ref);
    const [inLatest, inMine] = [has(this.l), has(this.m)];
    if (inLatest === inMine) return inMine;
    const field = `${kind}:${ref}`;
    if (!this.touched(inMine ? this.m : this.l, kind, ref)) {
      if (inMine) this.record(field, label, [sm.present, sm.removed, sm.present], sm.tookLatest);
      return false;
    }
    const values = inMine ? [sm.present, sm.removed, sm.changed] : [sm.present, sm.changed, sm.removed];
    const text = (inMine ? sm.goneThere : sm.goneHere)(label);
    return this.ambiguous(field, label, values, text) ? inLatest : inMine;
  }

  columns(): DraftColumn[] {
    const kept = new Set<string>();
    for (const column of this.base.columns)
      if (this.keep('column', column.ref, sm.columnAt(column.name.trim()))) kept.add(column.ref);
    for (const column of this.latest.columns)
      if (!this.b.columns.has(column.ref)) {
        kept.add(column.ref);
        const label = sm.columnAt(column.name.trim());
        this.record(`column:${column.ref}`, label, [sm.absent, sm.added, sm.absent], sm.tookLatest);
      }
    for (const column of this.mine.columns) if (!this.b.columns.has(column.ref)) kept.add(column.ref);
    // 本页不能调列序：列序以最新版本为准，我新增的列按我草稿里的位置插入；条件列始终在角色列之前
    const merged = weave(refsOf(this.latest.columns), refsOf(this.mine.columns), kept).map((r) => this.column(r));
    return [...merged.filter((column) => column.kind === 'condition'), ...merged.filter((c) => c.kind === 'role')];
  }
  private column(ref: string): DraftColumn {
    const [b, l, m] = [this.b.columns.get(ref), this.l.columns.get(ref), this.m.columns.get(ref)];
    // 最新版本里没有的列（我新增的、服务端删了而我保留的）按新列提交，不带持久 id
    if (!b || !l || !m) return { ...(m ?? l)!, id: l?.id ?? null };
    const name = sm.columnAt(this.columnName(ref));
    // 两边列类型不同（不论我是否动过），或两边都动过且维度不同：整列是一个不可拆的整体，类型、维度、开关、列名
    // 只取一边（未处理按我的）；格值随列类别取同一边（cellValue），不与另一边逐项拼接
    const touched = (side: Sides) => this.touched(side, 'column', ref);
    if (l.kind !== m.kind || (l.dimension !== m.dimension && touched(this.l) && touched(this.m))) {
      const field = `column:${ref}:type`;
      const take = this.ambiguous(field, `${name}·${sm.kind}`, [b, l, m].map(typeText), sm.columnClash(name));
      return { ...(take ? l : m) };
    }
    const merged = { ...m };
    for (const key of SETTINGS) {
      const label = `${name}·${sm.setting[key]}`;
      const value = this.pick(`column:${ref}:${key}`, label, [b[key], l[key], m[key]], (item) => setting(key, item));
      Object.assign(merged, { [key]: value });
    }
    return merged;
  }

  rows(columns: readonly DraftColumn[]): DraftRow[] {
    const kept = new Set<string>();
    for (const row of this.base.rows) if (this.keep('row', row.ref, this.rowName.get(row.ref)!)) kept.add(row.ref);
    for (const row of [...this.latest.rows, ...this.mine.rows])
      if (!this.b.rows.has(row.ref)) {
        kept.add(row.ref);
        if (this.l.rows.has(row.ref))
          this.record(`row:${row.ref}`, this.rowName.get(row.ref)!, [sm.absent, sm.added, sm.absent], sm.tookLatest);
      }
    return this.order(kept).map((ref) => ({
      ref,
      // 最新版本里没有的行（我新增的、服务端删了而我保留的）按新行提交
      id: this.l.rows.get(ref)?.id ?? null,
      cells: Object.fromEntries(columns.map((column) => [column.ref, this.cellValue(ref, column)])),
    }));
  }
  /** 行顺序只比三份共有的行：只有服务端调过就按最新版本，否则按我的；新增的行按各自草稿里的位置插入。 */
  private order(kept: ReadonlySet<string>) {
    const common = new Set(refsOf(this.base.rows).filter((ref) => this.l.rows.has(ref) && this.m.rows.has(ref)));
    const [b, l, m] = [this.base, this.latest, this.mine].map((side) => refsOf(side.rows).filter((r) => common.has(r)));
    const names = (refs: string[] = []) => refs.map((ref) => this.rowName.get(ref)).join('、');
    const [latestOrder, mineOrder] = [refsOf(this.latest.rows), refsOf(this.mine.rows)];
    // pick 取到最新版本那一份（只有服务端调过）时以最新顺序为主
    if (this.pick('rows:order', sm.rowOrder, [b, l, m], names) === l) return weave(latestOrder, mineOrder, kept);
    return weave(mineOrder, latestOrder, kept);
  }
  /**
   * 格值只取列类别（人员 / 维度）与合并后这一列相同的那一边：三份都相同才逐格三方合并；否则取我草稿里的，
   * 我的不同类取最新版本的，都不同类为空格。类别不同的一边的值（改类型、改维度前的 ID）一律不带入。
   */
  private cellValue(row: string, column: DraftColumn) {
    const ref = column.ref;
    const fits = (side: Sides) => {
      const own = side.columns.get(ref);
      return side.rows.has(row) && !!own && kindOf(own) === kindOf(column);
    };
    const value = (side: Sides) => this.cell(side, row, ref);
    if (!fits(this.b) || !fits(this.l) || !fits(this.m)) {
      const side = [this.m, this.l].find(fits);
      return side ? value(side) : [];
    }
    const ids: [string[], string[], string[]] = [value(this.b), value(this.l), value(this.m)];
    const label = `${this.rowName.get(row)}「${this.columnName(ref)}」`;
    return this.pick(`cell:${row}:${ref}`, label, ids, (item) => this.show(column, item));
  }
}

/** 原基线、最新版本、我的草稿与结构冲突的处理 → 合并后的草稿、冲突区要列的改动和尚未处理的结构冲突。 */
export function mergeStructure(base: Structure, latest: Structure, mine: Structure, show: Show, decided: Decided = {}) {
  const merger = new Merger(base, latest, mine, show, decided);
  const columns = merger.columns();
  const rows = merger.rows(columns);
  return { structure: { columns, rows }, changes: merger.changes, open: merger.open };
}
