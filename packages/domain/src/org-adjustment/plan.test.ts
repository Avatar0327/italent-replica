import { describe, expect, it } from 'vitest';
import { type OrgPlanItem, planOrgTree } from './plan.js';

const ROOT = 'root';
/** 生效日行政树：root ─ a ─ a1 ─ a11；root ─ b。 */
const orgs = [
  { id: 'a', parentId: ROOT },
  { id: 'a1', parentId: 'a' },
  { id: 'a11', parentId: 'a1' },
  { id: 'b', parentId: ROOT },
];
const create = (id: string, parent: OrgPlanItem['parent'], over: Partial<OrgPlanItem> = {}): OrgPlanItem => ({
  id,
  adjustType: 1,
  targetOrgId: null,
  parent,
  ...over,
});
const move = (id: string, targetOrgId: string, parentOrgId: string): OrgPlanItem => ({
  id,
  adjustType: 2,
  targetOrgId,
  parent: { kind: 'org', id: parentOrgId },
});
const stop = (id: string, targetOrgId: string): OrgPlanItem => ({ id, adjustType: 3, targetOrgId, parent: null });
const plan = (items: OrgPlanItem[]) => planOrgTree({ rootId: ROOT, orgs, items });
const reasonsOf = (items: OrgPlanItem[]) => plan(items).map((issue) => `${issue.itemId}:${issue.reason}`);

describe('planOrgTree（R2-T08 §5.2：本单明细叠到生效日组织树）', () => {
  it('无冲突的新增、改上级、停用不报问题', () => {
    expect(plan([create('i1', { kind: 'org', id: 'b' }), move('i2', 'a1', 'b'), stop('i3', 'a11')])).toEqual([]);
  });

  it('改上级到自己的下级（含经新增明细绕回）→ 循环', () => {
    expect(reasonsOf([move('i1', 'a', 'a11')])).toEqual(['i1:ORG_ADJUSTMENT_CYCLE']);
    const viaItem = [
      create('n', { kind: 'org', id: 'a1' }),
      { ...move('i2', 'a', 'x'), parent: { kind: 'item', id: 'n' } },
    ];
    expect(reasonsOf(viaItem as OrgPlanItem[]).sort()).toEqual(['i2:ORG_ADJUSTMENT_CYCLE', 'n:ORG_ADJUSTMENT_CYCLE']);
  });

  it('两条明细互为上级 → 两行都报循环', () => {
    const items = [move('i1', 'a', 'b'), move('i2', 'b', 'a')];
    expect(reasonsOf(items).sort()).toEqual(['i1:ORG_ADJUSTMENT_CYCLE', 'i2:ORG_ADJUSTMENT_CYCLE']);
  });

  it('层级 1～10：第 10 层可建，第 11 层报 LEVEL_EXCEEDED；改上级把整支压深同样拦（报发起行）', () => {
    const chain: OrgPlanItem[] = [];
    let parent: OrgPlanItem['parent'] = { kind: 'org', id: 'a11' };
    for (let level = 4; level <= 10; level++) {
      chain.push(create(`n${level}`, parent));
      parent = { kind: 'item', id: `n${level}` };
    }
    expect(plan(chain)).toEqual([]);
    expect(reasonsOf([...chain, create('n11', parent)])).toEqual(['n11:ORG_ADJUSTMENT_LEVEL_EXCEEDED']);
    expect(reasonsOf([...chain, move('m', 'b', 'n9')])).toEqual([]);
    const under = create('bc', { kind: 'org', id: 'b' });
    expect(reasonsOf([...chain, under, move('m', 'b', 'n9')])).toContain('m:ORG_ADJUSTMENT_LEVEL_EXCEEDED');
  });

  it('挂到本单停用整支下（含连带下级）→ PARENT_STOPPED；挂到未停用的上级不算', () => {
    expect(reasonsOf([stop('s', 'a'), create('n', { kind: 'org', id: 'a11' })])).toEqual([
      'n:ORG_ADJUSTMENT_PARENT_STOPPED',
    ]);
    expect(reasonsOf([stop('s', 'a'), move('m', 'b', 'a1')])).toEqual(['m:ORG_ADJUSTMENT_PARENT_STOPPED']);
    expect(reasonsOf([stop('s', 'a1'), move('m', 'b', 'a')])).toEqual([]);
  });

  it('引用不存在的明细或组织 → ITEM_REFERENCE；未知父链断开不误判为循环', () => {
    expect(reasonsOf([create('n', { kind: 'item', id: 'missing' })])).toEqual(['n:ORG_ADJUSTMENT_ITEM_REFERENCE']);
    expect(reasonsOf([move('m', 'a', 'ghost')])).toEqual(['m:ORG_ADJUSTMENT_ITEM_REFERENCE']);
    expect(reasonsOf([create('n', { kind: 'item', id: 's' }), stop('s', 'b')])).toEqual([
      'n:ORG_ADJUSTMENT_ITEM_REFERENCE',
    ]);
  });

  it('暂存行自身不报问题；被引用时由提交校验报 STAGED_REFERENCE，plan 不重复报', () => {
    const staged = create('st', { kind: 'org', id: 'b' }, { isStaged: true });
    expect(reasonsOf([staged, create('n', { kind: 'item', id: 'st' })])).toEqual([]);
    expect(reasonsOf([{ ...move('m', 'a', 'a11'), isStaged: true }])).toEqual([]);
  });
});
