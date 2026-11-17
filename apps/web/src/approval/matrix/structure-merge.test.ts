// 结构三方合并的删除、新增、维度与行顺序规则及结构冲突按处理结果重算（页面级回填与结构冲突见 AC-APV-F326-25.test.ts），
// 以及格值类别与列类型一致的兜底校验。
import { describe, expect, it } from 'vitest';
import { mergeStructure, type Decided } from './structure-merge.js';
import { structureIssues, type DraftColumn, type DraftRow, type Structure } from './structure-model.js';

const column = (ref: string, kind: DraftColumn['kind'] = 'role'): DraftColumn => ({
  ref,
  id: ref,
  kind,
  dimension: kind === 'condition' ? 'department' : null,
  includeChildren: false,
  name: ref,
  allowMultiple: false,
});
const row = (ref: string, cells: Record<string, string[]>): DraftRow => ({ ref, id: ref, cells });
const C = column('C', 'condition');
const base: Structure = {
  columns: [C, column('R')],
  rows: [row('r1', { C: ['d1'], R: ['p1'] }), row('r2', { C: ['d2'], R: ['p2'] })],
};
const show = (_: DraftColumn, ids: readonly string[]) => ids.join('、') || '（空）';
const merge = (latest: Structure, mine: Structure, decided: Decided = {}) =>
  mergeStructure(base, latest, mine, show, decided);
const refs = (list: readonly { ref: string }[]) => list.map((item) => item.ref);

describe('structure-merge 三方合并', () => {
  it('服务端删了我没动的行：跟着删并列出；我动过的行：先保留为新行（不带 id）并列为结构冲突，采用最新版本则删去', () => {
    const latest = { ...base, rows: [base.rows[1]!] };
    const silent = merge(latest, base);
    expect(refs(silent.structure.rows)).toEqual(['r2']);
    expect(silent.changes[0]).toMatchObject({ field: 'row:r1', latest: '已删除', mine: '有' });
    expect(silent.open).toEqual([]);
    const mine = { ...base, rows: [row('r1', { C: ['d1'], R: ['p9'] }), base.rows[1]!] };
    const kept = merge(latest, mine);
    expect(kept.structure.rows.map((item) => item.id)).toEqual([null, 'r2']);
    expect(kept.changes[0]!.label).toContain('须逐项处理');
    expect(kept.open.map((item) => item.key)).toEqual(['row:r1']);
    expect(refs(merge(latest, mine, { 'row:r1': true }).structure.rows)).toEqual(['r2']);
    const mineKept = merge(latest, mine, { 'row:r1': false });
    expect([mineKept.open, mineKept.structure.rows.map((item) => item.id)]).toEqual([[], [null, 'r2']]);
  });

  it('我删了服务端改过的行 / 列：先按我的删并列为结构冲突；采用最新版本按最新位置与格值放回', () => {
    const latest = { ...base, rows: [row('r1', { C: ['d1'], R: ['p9'] }), base.rows[1]!] };
    const mine = { ...base, rows: [base.rows[1]!] };
    const result = merge(latest, mine);
    expect(refs(result.structure.rows)).toEqual(['r2']);
    expect(result.changes[0]).toMatchObject({ field: 'row:r1', latest: '已修改', mine: '已删除' });
    expect(merge(latest, mine, { 'row:r1': true }).structure.rows).toEqual(latest.rows);
    const renamed = { ...column('R'), name: '复核' };
    const latestColumns = { ...base, columns: [C, renamed] };
    const mineColumns = { ...base, columns: [C] };
    expect(refs(merge(latestColumns, mineColumns).structure.columns)).toEqual(['C']);
    const restored = merge(latestColumns, mineColumns, { 'column:R': true }).structure;
    expect(restored.columns).toEqual([C, renamed]);
    expect(restored.rows.map((item) => item.cells.R)).toEqual([['p1'], ['p2']]);
  });

  it('条件列两边都动过且维度不一致：草稿先用我的维度与格值并列为结构冲突；采用最新版本整列换成最新维度与格值', () => {
    const position = { ...column('C', 'condition'), dimension: 'position' as const };
    const latest = {
      columns: [position, base.columns[1]!],
      rows: [row('r1', { C: ['j1'], R: ['p1'] }), row('r2', { C: [], R: ['p2'] })],
    };
    const mine = { ...base, rows: [...base.rows, { ...row('n1', { C: ['d3'], R: [] }), id: null }] };
    const result = merge(latest, mine);
    expect(result.structure.columns[0]!.dimension).toBe('department');
    expect(result.structure.rows.map((item) => item.cells.C)).toEqual([['d1'], ['d2'], ['d3']]);
    expect(result.open.map((item) => item.key)).toEqual(['column:C:type']);
    const taken = merge(latest, mine, { 'column:C:type': true }).structure;
    expect(taken.columns[0]!.dimension).toBe('position');
    expect(taken.rows.map((item) => item.cells.C)).toEqual([['j1'], [], []]);
    // 我没动这一列：维度与格值都是“只有服务端改”，照常回填，不列为结构冲突
    const backfilled = merge(latest, base);
    expect([backfilled.open, backfilled.structure.columns[0]!.dimension]).toEqual([[], 'position']);
    expect(backfilled.structure.rows.map((item) => item.cells.C)).toEqual([['j1'], []]);
  });

  it('服务端删了我没动的列：跟着删；服务端新增的列与行补进来', () => {
    const latest = { columns: [base.columns[0]!, column('R2')], rows: base.rows };
    const result = merge(latest, base);
    expect(refs(result.structure.columns)).toEqual(['C', 'R2']);
    expect(result.changes.map((change) => change.field)).toEqual(['column:R', 'column:R2']);
    const added = merge({ ...base, rows: [...base.rows, row('r3', { C: [], R: ['p3'] })] }, base);
    expect(refs(added.structure.rows)).toEqual(['r1', 'r2', 'r3']);
    expect(added.structure.rows[2]!.cells).toEqual({ C: [], R: ['p3'] });
  });

  it('两边都调了行顺序：保留我的顺序，列为两边都改；我新增的行留在我放的位置', () => {
    const latest = { ...base, rows: [base.rows[1]!, base.rows[0]!] };
    const mine = { ...base, rows: [row('n1', { C: [], R: [] }), base.rows[1]!, base.rows[0]!] };
    const same = merge(latest, mine);
    expect(refs(same.structure.rows)).toEqual(['n1', 'r2', 'r1']);
    expect(same.changes[0]!.label).toContain('已采用最新值');
    const three = { ...base, rows: [...base.rows, row('r3', {})] };
    const result = mergeStructure(
      three,
      { ...three, rows: [three.rows[2]!, three.rows[0]!, three.rows[1]!] },
      { ...three, rows: [three.rows[1]!, three.rows[0]!, three.rows[2]!] },
      show,
    );
    expect(refs(result.structure.rows)).toEqual(['r2', 'r1', 'r3']);
    expect(result.changes[0]).toMatchObject({ field: 'rows:order' });
    expect(result.changes[0]!.label).toContain('两边都改');
  });

  it('服务端没有改动：草稿原样，冲突区为空（仍须用户确认）', () => {
    const mine = { ...base, rows: [row('r1', { C: ['d1'], R: ['p9'] }), base.rows[1]!] };
    const result = merge(base, mine);
    expect(result.structure).toEqual(mine);
    expect(result.changes).toEqual([]);
    expect(result.open).toEqual([]);
  });

  it('只有服务端把条件列改成职位并删了第1行，我改过第1行并保留：该行这一列的部门值不带进职位列', () => {
    const position = { ...C, dimension: 'position' as const };
    const latest = { columns: [position, column('R')], rows: [row('r2', { C: ['j1'], R: ['p2'] })] };
    const mine = { ...base, rows: [row('r1', { C: ['d1'], R: ['p9'] }), base.rows[1]!] };
    const result = merge(latest, mine, { 'row:r1': false });
    expect([result.open, result.structure.columns[0]]).toEqual([[], position]);
    expect(result.structure.rows.map((item) => item.cells)).toEqual([
      { C: [], R: ['p9'] },
      { C: ['j1'], R: ['p2'] },
    ]);
  });
});

describe('structureIssues 一致性兜底', () => {
  it('格值只在别的类别登记过（部门 ID 进了人员格、人员 ID 进了部门格）：报类型不一致；没登记过的不报', () => {
    const registered = new Set(['department:d1', 'person:p1', 'person:p2']);
    const known = (kind: string, id: string) => registered.has(`${kind}:${id}`);
    const draft: Structure = {
      columns: [C, column('R')],
      rows: [row('r1', { C: ['p1'], R: ['d1'] }), row('r2', { C: ['d1', 'x1'], R: ['p2'] })],
    };
    expect(structureIssues(draft, known).map((issue) => [issue.text, issue.row])).toEqual([
      ['第1行「C」：格值与列类型不一致', 'r1'],
      ['第1行「R」：格值与列类型不一致', 'r1'],
    ]);
  });
});
