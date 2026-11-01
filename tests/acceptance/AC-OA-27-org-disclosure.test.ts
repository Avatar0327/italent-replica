/**
 * BE-10c AC-OA-27 组织分区的审批披露与盲审（R2-T08 §4.5）：快照 = 头（含调整范围）+ 组织分区；节点只勾了的字段、
 * 审批人查看权内的字段才披露；变化字段 = 头里有值的字段 + 明细里实际改了的编码。审批人看不到变化字段时，
 * 手动同意被拦、自动跳过转异常管理员（DEC-069）。调动 / 职位 / 编制 / 兼职分区不在本片。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { ORG_ADJUSTMENT_SECTION_FIELDS } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { type FlowWorld, flowWorld, oaNodes } from './AC-OA-approval-support.js';
import { expectError } from './AC-OA-head-support.js';
import { rename } from './AC-OA-items-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { orgAdjustmentSnapshot } from '../../apps/api/src/modules/org-adjustment/snapshot.js';

const testDb = useTestDb();
const linkage = { transferOldHeadSubordinates: false, adjustNewHeadManager: false };
const HEAD_FIELD = 'orgItems.personInChargeId';

const hide = (w: FlowWorld, userId: string, ...fields: string[]) => w.access.hiddenByUser.set(userId, new Set(fields));
const pendingOf = async (w: FlowWorld, id: string) =>
  (await w.instance(id)).tasks.filter((t) => t.status === 'pending');

/** 只换负责人的明细（新负责人在本组织内，免调动）。 */
async function headChange(w: FlowWorld) {
  const newHead = await w.person('新负责人', w.a);
  return w.draft({
    entry: 'detail.change',
    adjustType: 2,
    targetOrgId: w.a,
    personInChargeId: newHead.employeeId,
    ...linkage,
  });
}

describe('AC-OA-27 快照：头 + 组织分区', () => {
  it('节点全字段：审批人看到头（含调整范围、主体组织）与改名明细（按 itemId 列出）', async () => {
    const w = await flowWorld(testDb().db, 'oa27-snapshot');
    const name = `快照改名${randomUUID()}`;
    const { id, itemId } = await w.draft(rename(w.a, { name }));
    await w.submitted(id);
    const view = await w.detail((await w.instance(id)).id, w.hrbp.userId);
    const values = view.form.values;
    expect(values.subject).toEqual(expect.any(String));
    expect(values.approvalSubjectOrgId).toBe(w.subject);
    expect(values.adjustmentRange).toEqual([w.a]);
    expect(values['orgItems.name']).toEqual([{ itemId, value: name }]);
    expect(values['orgItems.targetOrgId']).toEqual([{ itemId, value: w.a }]);
    expect(view.title).toContain('组织调整申请');
  });

  it('节点只勾组织分区、审批人看不到负责人：披露集只含勾了且看得见的字段', async () => {
    const nodes = oaNodes([
      { formFields: ORG_ADJUSTMENT_SECTION_FIELDS.orgItems, editableFields: [], editMode: 'none' },
    ]);
    const w = await flowWorld(testDb().db, 'oa27-node', { nodes });
    hide(w, w.hrbp.userId, HEAD_FIELD);
    const { id, itemId } = await w.draft();
    await w.submitted(id);
    const values = (await w.detail((await w.instance(id)).id, w.hrbp.userId)).form.values;
    expect(values).not.toHaveProperty('subject');
    expect(values).not.toHaveProperty('adjustmentRange');
    expect(values).not.toHaveProperty(HEAD_FIELD);
    expect(values['orgItems.name']).toEqual([{ itemId, value: expect.any(String) }]);
    // 负责人没改，看不到也不算盲审：可以同意
    await w.acted(id, w.hrbp, 'approve');
  });
});

describe('AC-OA-27 盲审：变化字段看不到', () => {
  it('只换负责人、审批人看不到负责人 → 同意 403 盲审，待办转异常管理员，单据仍审批中', async () => {
    const w = await flowWorld(testDb().db, 'oa27-blind');
    const { id } = await headChange(w);
    await w.submitted(id);
    hide(w, w.hrbp.userId, HEAD_FIELD);
    await expectError(await w.act(id, w.hrbp, 'approve'), 403, 'FORBIDDEN', 'APPROVAL_BLIND_REVIEW');
    expect(await pendingOf(w, id)).toEqual([
      expect.objectContaining({ nodeKey: 'n1', assigneeUserId: w.exceptionAdmin, origin: 'blind_review' }),
    ]);
    expect((await w.state(id)).approval).toBe(1);
  });

  it('历史同人自动跳过：审批人此时看不到负责人 → 不自动同意，转异常管理员', async () => {
    const recheck = { ...oaNodes()[0]!, key: 'n3', name: 'HRBP复核', historySameAssigneeSkip: true };
    const w = await flowWorld(testDb().db, 'oa27-auto', { nodes: [...oaNodes(), recheck] });
    const { id } = await headChange(w);
    await w.submitted(id);
    await w.acted(id, w.hrbp, 'approve');
    hide(w, w.hrbp.userId, HEAD_FIELD);
    await w.acted(id, w.head, 'approve');
    expect(await pendingOf(w, id)).toEqual([
      expect.objectContaining({ nodeKey: 'n3', assigneeUserId: w.exceptionAdmin, origin: 'blind_review' }),
    ]);
    expect(await w.state(id)).toMatchObject({ approval: 1, queued: 0 });
  });
});

/** 组织在生效日现行版本的名称（基线值）。 */
async function baseName(w: FlowWorld, orgId: string) {
  return withTenant(w.db, w.tenant.id, async (tx) => {
    const [row] = resultRows<{ name: string }>(
      await tx.execute(sql`SELECT name FROM org_versions WHERE org_id = ${orgId} ORDER BY version_no DESC LIMIT 1`),
    );
    return row!.name;
  });
}

describe('AC-OA-27 第 2 轮：快照按基线（base_version_id）算原值与真实变更集（§4.5）', () => {
  /** a 先有 HRBP；明细改名并把 HRBP 填成原值（填了但没变）。 */
  async function sameHrbp(w: FlowWorld) {
    const hrbp = await w.person(`原HRBP${randomUUID()}`, w.a);
    await w.setOrgRoles(w.a, { hrbp: hrbp.employeeId });
    const name = `基线改名${randomUUID()}`;
    const { id, itemId } = await w.draft(rename(w.a, { name, hrbpId: hrbp.employeeId }));
    await w.submitted(id);
    return { id, itemId, name };
  }

  it('隐藏且未改的字段（HRBP 填了原值）不阻断同意；原值按基线展示，行数另给', async () => {
    const w = await flowWorld(testDb().db, 'oa27-base');
    const { id, itemId, name } = await sameHrbp(w);
    const form = (await w.detail((await w.instance(id)).id, w.hrbp.userId)).form;
    expect(form.values['orgItems.name']).toEqual([{ itemId, value: name }]);
    expect(form.values).not.toHaveProperty('orgItems.hrbpId');
    expect(form.originals?.['orgItems.name']).toEqual([{ itemId, value: await baseName(w, w.a) }]);
    const snapshot = await withTenant(w.db, w.tenant.id, (tx) => orgAdjustmentSnapshot(tx, w.tenant.id, id));
    expect(snapshot.values['orgItems.count']).toBe(1);
    expect(snapshot.changedFields).not.toContain('orgItems.hrbpId');
    expect(snapshot.changedFields).not.toContain('orgItems.count');
    hide(w, w.hrbp.userId, 'orgItems.hrbpId');
    await w.acted(id, w.hrbp, 'approve');
  });

  it('隐藏且已改的字段（名称）仍阻断同意', async () => {
    const w = await flowWorld(testDb().db, 'oa27-base-blind');
    const { id } = await sameHrbp(w);
    hide(w, w.hrbp.userId, 'orgItems.name');
    await expectError(await w.act(id, w.hrbp, 'approve'), 403, 'FORBIDDEN', 'APPROVAL_BLIND_REVIEW');
  });
});
