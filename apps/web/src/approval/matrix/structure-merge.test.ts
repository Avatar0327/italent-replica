// 结构三方合并的删除、新增与行顺序规则（页面级的五类回填见 AC-APV-F326-25.test.ts）。
import { describe, expect, it } from 'vitest';
import { mergeStructure } from './structure-merge.js';
import type { DraftColumn, DraftRow, Structure } from './structure-model.js';

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
const base: Structure = {
  columns: [column('C', 'condition'), column('R')],
  rows: [row('r1', { C: ['d1'], R: ['p1'] }), row('r2', { C: ['d2'], R: ['p2'] })],
};
const show = (_: DraftColumn, ids: readonly string[]) => ids.join('、') || '（空）';
const merge = (latest: Structure, mine: Structure) => mergeStructure(base, latest, mine, show);
const refs = (list: readonly { ref: string }[]) => list.map((item) => item.ref);

describe('structure-merge 三方合并', () => {
  it('服务端删了我没动的行：跟着删并列出；我动过的行：保留并标两边都改', () => {
    const latest = { ...base, rows: [base.rows[1]!] };
    expect(refs(merge(latest, base).structure.rows)).toEqual(['r2']);
    expect(merge(latest, base).changes[0]).toMatchObject({ field: 'row:r1', latest: '已删除', mine: '有' });
    const mine = { ...base, rows: [row('r1', { C: ['d1'], R: ['p9'] }), base.rows[1]!] };
    const kept = merge(latest, mine);
    expect(refs(kept.structure.rows)).toEqual(['r1', 'r2']);
    expect(kept.changes[0]!.label).toContain('两边都改');
  });

  it('我删了服务端改过的行：仍按我的删，列为两边都改', () => {
    const latest = { ...base, rows: [row('r1', { C: ['d1'], R: ['p9'] }), base.rows[1]!] };
    const result = merge(latest, { ...base, rows: [base.rows[1]!] });
    expect(refs(result.structure.rows)).toEqual(['r2']);
    expect(result.changes[0]).toMatchObject({ field: 'row:r1', latest: '已修改', mine: '已删除' });
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
  });
});
