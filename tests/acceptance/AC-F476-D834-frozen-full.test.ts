/**
 * AC-F476-D834（DEC-834④）：已办按办理时冻结的那份完整可见，不套用审批人当前的组织数据范围；
 * 在办审批人 / 发起人等现值读路径仍按 B1b 的范围披露规则过滤（不被放宽）。
 * 世界：调整范围 [甲, 乙]，两条改名明细（甲行、乙行）；HRBP 同时持有组织对象数据范围（access.org 对所有人生效）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { flowWorld, type FlowWorld } from './AC-OA-approval-support.js';
import { ALL, only } from './AC-OA-head-support.js';
import { rename } from './AC-OA-items-support.js';
import { reader, type ItemsView, type DetailView, type RangeOrg } from './AC-OA-read-support.js';
import { NAME_A, NAME_B, SUBJECT_A, changeTo, seenBy } from './AC-F476-support.js';

const testDb = useTestDb();
const ROW_B = 'ZZ_乙行办理时名称';

/** 提交前：甲行 NAME_A、乙行 ROW_B，主题 SUBJECT_A；调整范围含甲、乙。 */
async function draftBoth(w: FlowWorld) {
  const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b], subject: SUBJECT_A }));
  const first = (await w.item(view.id, rename(w.a, { name: NAME_A }))).items.at(-1)!.id;
  await w.item(view.id, rename(w.b, { name: ROW_B }));
  return { id: view.id, itemId: first };
}

const rangeOf = (detail: DetailView) => detail.adjustmentRange as RangeOrg[];
const namesOf = (view: ItemsView) => view.items.map((item) => item.name);

describe('AC-F476-D834 已办冻结份完整可见（DEC-834④）', () => {
  it('审批人办理后组织数据范围缩小到只剩乙：读已办冻结份仍完整（甲行、调整范围甲、办理时名称），不受当前范围影响', async () => {
    const w = await flowWorld(testDb().db, 'f476-d834-frozen');
    const { id, itemId } = await draftBoth(w);
    await w.submitted(id);
    await w.acted(id, w.hrbp, 'approve');
    await w.acted(id, w.head, 'reject');
    await changeTo(w, { id, itemId }, NAME_B, 'ZZ_改后主题');
    const instanceId = (await w.instance(id)).id;

    w.access.org = only(w.b); // 办理后范围缩小：甲已不在 HRBP 的组织数据范围内
    const r = reader(w);
    const seen = await seenBy(w, { id, itemId, instanceId }, w.hrbp.userId);
    expect(seen.mode).toBe('frozen');
    expect(seen.centerNames).toEqual([NAME_A, ROW_B]);
    expect(seen.orgNames).toEqual([NAME_A, ROW_B]);
    const items = await r.items(id, w.hrbp.userId);
    expect(items.hiddenRowCount).toBe(0);
    expect(items.items.map((item) => item.targetOrgName).every((name) => typeof name === 'string')).toBe(true);
    const detail = await r.detail(id, w.hrbp.userId);
    expect(detail.sections).toEqual({ org: { count: 2, hiddenRowCount: 0 } });
    expect(rangeOf(detail).map((range) => typeof range.name)).toEqual(['string', 'string']);
    expect(detail.subject).toBe(SUBJECT_A);
  });

  it('反向对照：同一时刻的发起人读现值，仍按范围隐去甲行与调整范围里甲的名称（B1b 不被放宽）', async () => {
    const w = await flowWorld(testDb().db, 'f476-d834-initiator');
    const { id, itemId } = await draftBoth(w);
    await w.submitted(id);
    await w.acted(id, w.hrbp, 'approve');
    await w.acted(id, w.head, 'reject');
    await changeTo(w, { id, itemId }, NAME_B, 'ZZ_改后主题');

    w.access.org = only(w.b);
    const r = reader(w);
    const items = await r.items(id);
    expect(namesOf(items)).toEqual([ROW_B]);
    expect(items.hiddenRowCount).toBe(1);
    const range = rangeOf(await r.detail(id));
    expect(range.find((entry) => entry.orgId === w.a)).toMatchObject({ name: null, label: null });
    expect(range.find((entry) => entry.orgId === w.b)?.name).toEqual(expect.any(String));
  });
});

describe('AC-F476-D834 在办审批人仍按 B1b 规则过滤', () => {
  it('HRBP 有待办（未办理）且组织范围只含乙：读现值，甲行隐去并计数、调整范围里甲的名称为 null；办理后才读到完整冻结份', async () => {
    const w = await flowWorld(testDb().db, 'f476-d834-pending');
    const { id } = await draftBoth(w);
    await w.submitted(id);
    w.access.org = only(w.b);
    const r = reader(w);

    const items = await r.items(id, w.hrbp.userId);
    expect(namesOf(items)).toEqual([ROW_B]);
    expect(items.hiddenRowCount).toBe(1);
    const detail = await r.detail(id, w.hrbp.userId);
    expect(detail.sections).toEqual({ org: { count: 1, hiddenRowCount: 1 } });
    expect(rangeOf(detail).find((entry) => entry.orgId === w.a)).toMatchObject({ name: null, label: null });

    // 同意后（范围不变）：该节点已办，读办理时冻结份，甲行不再被当前范围隐去
    w.access.org = ALL;
    await w.acted(id, w.hrbp, 'approve');
    w.access.org = only(w.b);
    const after = await r.items(id, w.hrbp.userId);
    expect(namesOf(after)).toEqual([NAME_A, ROW_B]);
    expect(after.hiddenRowCount).toBe(0);
  });
});
