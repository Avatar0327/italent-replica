// 409 重读后的结构三方合并（F-123 设计「状态与恢复」：比较原基线与最新版本，只回填服务端改了、用户没改的部分，
// 用户修改始终保留）。内核按字段比较，整份结构是一个字段；这里把它拆到列设置、列 / 行的有无、行顺序与单元格。
// 两边都动过同一处时保留我的输入并列入冲突；行顺序、行 / 列删除设计没写细，同样按“两边都动过保留我的”处理。
import { sameValue } from '../../foundation/forms/values.js';
import { sm } from './structure-messages.js';
import type { DraftColumn, DraftRow, Structure } from './structure-model.js';

/** 冲突区的一行：服务端改过的一处，原值 / 最新值 / 我的输入都是给人看的文本。 */
export interface Change {
  field: string;
  label: string;
  before: string;
  latest: string;
  mine: string;
}
/** 单元格的 id → 显示名（条件列按维度，角色列按人员）。 */
export type Show = (column: DraftColumn, ids: readonly string[]) => string;

type Side<T extends { ref: string }> = Map<string, T>;
interface Sides {
  columns: Side<DraftColumn>;
  rows: Side<DraftRow>;
}
const byRef = <T extends { ref: string }>(list: readonly T[]): Side<T> => new Map(list.map((item) => [item.ref, item]));
const SETTINGS = ['name', 'dimension', 'includeChildren', 'allowMultiple'] as const;
type Setting = (typeof SETTINGS)[number];

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
/** 三份里共有的项，各自的先后顺序。 */
const orderOf = (list: readonly { ref: string }[], common: ReadonlySet<string>) =>
  list.map((item) => item.ref).filter((ref) => common.has(ref));

class Merger {
  readonly changes: Change[] = [];
  private readonly b: Sides;
  private readonly l: Sides;
  private readonly m: Sides;
  private readonly rowName: Map<string, string>;

  constructor(
    private readonly base: Structure,
    private readonly latest: Structure,
    private readonly mine: Structure,
    private readonly show: Show,
  ) {
    const sides = (value: Structure) => ({ columns: byRef(value.columns), rows: byRef(value.rows) });
    [this.b, this.l, this.m] = [sides(base), sides(latest), sides(mine)];
    // 行按原基线里的位置称呼（甲打开时看到的行号）；服务端新增的行按最新版本里的位置
    this.rowName = new Map(base.rows.map((row, index) => [row.ref, sm.row(index)]));
    latest.rows.forEach((row, index) => {
      if (!this.rowName.has(row.ref)) this.rowName.set(row.ref, sm.latestRow(index));
    });
  }

  /** both：两边都改了这一处（保留我的输入）；否则只有服务端改（已采用最新值，或我恰好改成同样的值）。 */
  private record(field: string, label: string, values: [string, string, string], both: boolean) {
    this.changes.push({
      field,
      label: `${label}（${both ? sm.keptMine : sm.tookLatest}）`,
      before: values[0],
      latest: values[1],
      mine: values[2],
    });
  }
  private columnName(ref: string) {
    const column = this.m.columns.get(ref) ?? this.l.columns.get(ref) ?? this.b.columns.get(ref)!;
    return column.name.trim();
  }
  private cell(side: Sides, row: string, column: string) {
    return side.rows.get(row)?.cells[column] ?? [];
  }
  /** 某一边相对原基线动过这一列（设置或这一列的任一格）。 */
  private columnTouched(side: Sides, ref: string) {
    const column = side.columns.get(ref);
    if (!column) return true;
    const before = this.b.columns.get(ref)!;
    if (SETTINGS.some((key) => !sameValue(column[key], before[key]))) return true;
    return this.base.rows.some(
      (row) => side.rows.has(row.ref) && !sameValue(this.cell(side, row.ref, ref), row.cells[ref]),
    );
  }
  /** 某一边相对原基线动过这一行（该行在原基线列上的任一格）。 */
  private rowTouched(side: Sides, ref: string) {
    if (!side.rows.has(ref)) return true;
    const row = this.b.rows.get(ref)!;
    return this.base.columns.some(
      (column) => side.columns.has(column.ref) && !sameValue(this.cell(side, ref, column.ref), row.cells[column.ref]),
    );
  }

  /** 原基线里的项：两边都在就保留；只有一边删了，另一边没动它就跟着删，动过就保留我的选择（我删了就删）。 */
  private keep(kind: 'column' | 'row', ref: string, label: string) {
    const [l, m] = kind === 'column' ? [this.l.columns, this.m.columns] : [this.l.rows, this.m.rows];
    const touched = (side: Sides) => (kind === 'column' ? this.columnTouched(side, ref) : this.rowTouched(side, ref));
    const field = `${kind}:${ref}`;
    if (l.has(ref) && m.has(ref)) return true;
    if (m.has(ref)) {
      const mine = touched(this.m);
      this.record(field, label, [sm.present, sm.removed, mine ? sm.changed : sm.present], mine);
      return mine;
    }
    if (l.has(ref) && touched(this.l)) this.record(field, label, [sm.present, sm.changed, sm.removed], true);
    return false;
  }

  columns(): DraftColumn[] {
    const kept = new Set<string>();
    for (const column of this.base.columns)
      if (this.keep('column', column.ref, sm.columnAt(column.name.trim()))) kept.add(column.ref);
    for (const column of this.latest.columns)
      if (!this.b.columns.has(column.ref)) {
        kept.add(column.ref);
        this.record(`column:${column.ref}`, sm.columnAt(column.name.trim()), [sm.absent, sm.added, sm.absent], false);
      }
    for (const column of this.mine.columns) if (!this.b.columns.has(column.ref)) kept.add(column.ref);
    // 本页不能调列序：列序以最新版本为准，我新增的列按我草稿里的位置插入；条件列始终在角色列之前
    const order = weave(
      this.latest.columns.map((column) => column.ref),
      this.mine.columns.map((column) => column.ref),
      kept,
    );
    const merged = order.map((ref) => this.column(ref));
    return [...merged.filter((column) => column.kind === 'condition'), ...merged.filter((c) => c.kind === 'role')];
  }
  private column(ref: string): DraftColumn {
    const [b, l, m] = [this.b.columns.get(ref), this.l.columns.get(ref), this.m.columns.get(ref)];
    if (!b || !l || !m) return (m ?? l)!;
    const merged = { ...m };
    for (const key of SETTINGS) {
      const text = (column: DraftColumn) => this.setting(column, key);
      if (sameValue(l[key], b[key])) continue;
      const mine = !sameValue(m[key], b[key]);
      if (!mine) Object.assign(merged, { [key]: l[key] });
      const label = `${sm.columnAt(this.columnName(ref))}·${sm.setting[key]}`;
      this.record(`column:${ref}:${key}`, label, [text(b), text(l), text(m)], mine && !sameValue(m[key], l[key]));
    }
    return merged;
  }
  private setting(column: DraftColumn, key: Setting) {
    if (key === 'name') return column.name.trim();
    if (key === 'dimension') return column.dimension ? sm.dimensionLabel[column.dimension]! : '—';
    return column[key] ? sm.yes : sm.no;
  }

  rows(columns: readonly DraftColumn[]): DraftRow[] {
    const kept = new Set<string>();
    for (const row of this.base.rows) if (this.keep('row', row.ref, this.rowName.get(row.ref)!)) kept.add(row.ref);
    for (const row of [...this.latest.rows, ...this.mine.rows])
      if (!this.b.rows.has(row.ref)) {
        kept.add(row.ref);
        if (this.l.rows.has(row.ref))
          this.record(`row:${row.ref}`, this.rowName.get(row.ref)!, [sm.absent, sm.added, sm.absent], false);
      }
    const order = this.order(kept);
    return order.map((ref) => ({
      ref,
      id: (this.m.rows.get(ref) ?? this.l.rows.get(ref))!.id,
      cells: Object.fromEntries(columns.map((column) => [column.ref, this.cellValue(ref, column)])),
    }));
  }
  /** 行顺序只比三份共有的行：只有服务端调过就按最新版本，否则按我的；新增的行按各自草稿里的位置插入。 */
  private order(kept: ReadonlySet<string>) {
    const common = new Set(
      this.base.rows.map((row) => row.ref).filter((ref) => this.l.rows.has(ref) && this.m.rows.has(ref)),
    );
    const [b, l, m] = [
      orderOf(this.base.rows, common),
      orderOf(this.latest.rows, common),
      orderOf(this.mine.rows, common),
    ];
    const latestOrder = this.latest.rows.map((row) => row.ref);
    const mineOrder = this.mine.rows.map((row) => row.ref);
    if (sameValue(l, b)) return weave(mineOrder, latestOrder, kept);
    const names = (refs: string[]) => refs.map((ref) => this.rowName.get(ref)).join('、');
    const mine = !sameValue(m, b);
    this.record('rows:order', sm.rowOrder, [names(b), names(l), names(m)], mine && !sameValue(m, l));
    return mine ? weave(mineOrder, latestOrder, kept) : weave(latestOrder, mineOrder, kept);
  }
  private cellValue(row: string, column: DraftColumn) {
    const ref = column.ref;
    const inAll = (side: Sides) => side.rows.has(row) && side.columns.has(ref);
    const m = this.cell(this.m, row, ref);
    const l = this.cell(this.l, row, ref);
    // 一边新增的行 / 列、只在一边保留下来的行 / 列：取有它的那一边（另一边没有就是空格）
    if (!inAll(this.b) || !inAll(this.l)) return inAll(this.m) || !this.l.rows.has(row) ? m : l;
    if (!inAll(this.m)) return l;
    const b = this.cell(this.b, row, ref);
    if (sameValue(l, b)) return m;
    const label = `${this.rowName.get(row)}「${this.columnName(ref)}」`;
    const mine = !sameValue(m, b);
    const texts = [b, l, m].map((ids) => this.show(column, ids)) as [string, string, string];
    this.record(`cell:${row}:${ref}`, label, texts, mine && !sameValue(m, l));
    return mine ? m : l;
  }
}

/** 原基线、最新版本、我的草稿 → 合并后的草稿与冲突区要列的服务端改动。 */
export function mergeStructure(base: Structure, latest: Structure, mine: Structure, show: Show) {
  const merger = new Merger(base, latest, mine, show);
  const columns = merger.columns();
  const rows = merger.rows(columns);
  return { structure: { columns, rows }, changes: merger.changes };
}
