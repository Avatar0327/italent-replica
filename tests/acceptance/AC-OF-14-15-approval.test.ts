/**
 * BE-14a3：Offer 审批 / Offer 批量审批（34 §2.1、OF-R15；DEC-532⑦、DEC-533④、DEC-054、DEC-094；F-171 ①②）。
 * - AC-OF-14：批量审批中直接上级“不同意” → 流程结束，不再到审批主体一级组织负责人，子表 Offer 记“不通过”；
 * - AC-OF-15：批量审批申请人没有直接上级 → 首节点为空，提交报错（DEC-054），不建单、Offer 不变；
 * - 单个 Offer 审批：审批人“录用部门负责人”，审批中 / 通过 / 不通过 / 驳回回写 Offer 审批子状态，列表“当前审批人 /
 *   当前审批节点”取在途实例；首节点为空报错；无权发起 403；状态不对 409；
 * - 预置草稿与审批人取值的类型限制（批量不得用“录用部门负责人”，三个新取值只用于 Offer 两类审批）。
 */
import { PRESET_PROCESSES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { offerApprovalWorld, reasonOf, type OfferView } from './AC-OF-BE14a3-support.js';

const testDb = useTestDb();
const presetOf = (type: string) => PRESET_PROCESSES.find((p) => p.approvalType === type);

describe('预置草稿（DEC-094，OF-R15）', () => {
  it('Offer 批量审批：流程编码 OfferBatchApprovalProcess，直接上级（空 = 无操作）→ 审批主体一级组织负责人（空 = 异常管理员）', () => {
    const preset = presetOf('offer_batch')!.definition;
    expect(preset.conditions.items).toEqual([
      { no: 1, field: 'processCode', operator: 'eq', value: 'OfferBatchApprovalProcess' },
    ]);
    expect(preset.nodes.map((n) => [n.name, 'approver' in n && n.approver, n.noAssignee, n.exits])).toEqual([
      ['直接上级', 'initiator_direct_manager', 'none', ['approve', 'disagree']],
      ['审批主体一级组织负责人', 'approval_subject_first_level_org_head', 'exception_admin', ['approve', 'disagree']],
    ]);
  });

  it('单个 Offer 审批：录用部门负责人（节点结构未取证，沿用占位）', () => {
    const nodes = presetOf('offer')!.definition.nodes;
    expect(nodes.map((n) => 'approver' in n && n.approver)).toEqual(['offer_department_head']);
  });
});

describe('审批人取值的类型限制', () => {
  const process = (approvalType: string, approver: string) => ({
    code: `OF3_${approvalType}_${approver}`.slice(0, 60),
    name: '合成流程',
    approvalType,
    exceptionAdminUserId: null,
    isFallback: true,
    conditions: { items: [] },
    nodes: [{ key: 'n1', approver }],
  });

  it('批量审批不得用“录用部门负责人”；新取值不得用于调动；各自类型上可用', async () => {
    const w = await offerApprovalWorld(testDb().db, 'types');
    const post = (body: unknown) => w.request(w.hr.id, 'POST', '/api/tenant/approval/processes', { ifMatch: 0, body });
    for (const [type, approver] of [
      ['offer_batch', 'offer_department_head'],
      ['transfer', 'initiator_direct_manager'],
      ['transfer', 'approval_subject_first_level_org_head'],
      ['offer', 'approval_subject_first_level_org_head'],
    ] as const) {
      expect(await reasonOf(await post(process(type, approver))), `${type}/${approver}`).toMatchObject({
        status: 400,
        reason: 'APPROVAL_DEFINITION_INVALID',
      });
    }
    for (const [type, approver] of [
      ['offer', 'offer_department_head'],
      ['offer_batch', 'initiator_direct_manager'],
      ['offer_batch', 'approval_subject_first_level_org_head'],
    ] as const) {
      expect((await post(process(type, approver))).status, `${type}/${approver}`).toBe(201);
    }
  });
});

describe('单个 Offer 审批（录用部门负责人）', () => {
  it('发起 → 审批中，列表显示当前审批节点 / 当前审批人；负责人同意 → 审批通过', async () => {
    const w = await offerApprovalWorld(testDb().db, 'single-ok');
    const offer = await w.offer(w.applicant);
    const submitted = await w.json<OfferView>(await w.submitRaw(offer));
    expect(submitted).toMatchObject({ status: 'pending', approvalStatus: 'approving' });
    expect(submitted.revision).toBeGreaterThan(offer.revision);
    const edit = await w.request(w.applicant.userId, 'PUT', `/api/tenant/offers/${offer.id}`, {
      ifMatch: submitted.revision,
      body: { name: '改名' },
    });
    expect(await reasonOf(edit)).toMatchObject({ status: 409, reason: 'OFFER_NOT_EDITABLE' });

    const listed = await w.json<{ items: OfferView[] }>(
      await w.request(w.applicant.userId, 'GET', '/api/tenant/offers?view=approving'),
    );
    expect(listed.items.find((item) => item.id === offer.id)).toMatchObject({
      currentApprovalNode: '录用部门负责人',
      currentApprovers: ['部门负责人'],
    });
    const view = await w.instance(offer.id);
    expect(view).toMatchObject({ approvalType: 'offer', status: 'running', subjectEmployeeId: null });
    expect(w.pending(view).map((t) => t.assigneeUserId)).toEqual([w.head.userId]);

    await w.decide(view, w.head, 'approve');
    expect((await w.instance(offer.id)).status).toBe('approved');
    expect(await w.get(offer.id)).toMatchObject({
      approvalStatus: 'approved',
      currentApprovers: [],
      currentApprovalNode: null,
    });
  });

  it('负责人不同意 → 不通过；驳回 → 回到未发起审批、可编辑，重新发起沿用原实例（DEC-103）', async () => {
    const w = await offerApprovalWorld(testDb().db, 'single-no');
    const refused = await w.offer(w.applicant);
    await w.json(await w.submitRaw(refused));
    await w.decide(await w.instance(refused.id), w.head, 'disagree');
    expect((await w.instance(refused.id)).status).toBe('disapproved');
    expect((await w.get(refused.id)).approvalStatus).toBe('disapproved');

    const returned = await w.offer(w.applicant);
    await w.json(await w.submitRaw(returned));
    const first = await w.instance(returned.id);
    await w.decide(first, w.head, 'reject');
    const back = await w.get(returned.id);
    expect(back.approvalStatus).toBe('unsubmitted');
    const edited = await w.json<OfferView>(
      await w.request(w.applicant.userId, 'PUT', `/api/tenant/offers/${returned.id}`, {
        ifMatch: back.revision,
        body: { workPlace: '上海' },
      }),
    );
    expect((await w.json<OfferView>(await w.submitRaw(edited))).approvalStatus).toBe('approving');
    const again = await w.instanceOfAll(returned.id, w.applicant.userId);
    expect(again.map((v) => [v.id, v.status])).toEqual([[first.id, 'running']]);
  });

  it('录用部门没有负责人 → 首节点为空提交报错（DEC-054），Offer 不变', async () => {
    const w = await offerApprovalWorld(testDb().db, 'single-empty');
    const headless = await w.org('无负责人部门');
    const offer = await w.offer(w.applicant, headless);
    expect(await reasonOf(await w.submitRaw(offer))).toMatchObject({
      status: 409,
      reason: 'APPROVAL_FIRST_NODE_EMPTY',
    });
    expect(await w.get(offer.id)).toMatchObject({ approvalStatus: 'unsubmitted', revision: offer.revision });
  });

  it('无权发起（无 Offer 编辑权）→ 403；审批中 / 已审批通过 / 非待发 → 409；revision 不符 → 409', async () => {
    const w = await offerApprovalWorld(testDb().db, 'single-guard');
    const offer = await w.offer(w.applicant);
    expect((await w.denyUpdate(w.applicant, `/${offer.id}/approval`, offer.revision)).status).toBe(403);
    expect((await w.get(offer.id)).approvalStatus).toBe('unsubmitted');
    expect(await reasonOf(await w.submitRaw({ ...offer, revision: offer.revision + 5 }))).toMatchObject({
      status: 409,
      code: 'REVISION_CONFLICT',
    });

    const approving = await w.json<OfferView>(await w.submitRaw(offer));
    expect(await reasonOf(await w.submitRaw(approving))).toMatchObject({
      status: 409,
      reason: 'OFFER_APPROVAL_NOT_ALLOWED',
    });
    await w.decide(await w.instance(offer.id), w.head, 'approve');
    expect(await reasonOf(await w.submitRaw(await w.get(offer.id)))).toMatchObject({
      status: 409,
      reason: 'OFFER_APPROVAL_NOT_ALLOWED',
    });
  });
});

describe('删除与审批单', () => {
  it('被驳回待重发的 Offer 删除后实例作废；被批量单引用的 Offer 不能删除', async () => {
    const w = await offerApprovalWorld(testDb().db, 'delete');
    const returned = await w.offer(w.applicant);
    await w.json(await w.submitRaw(returned));
    const view = await w.instance(returned.id);
    await w.decide(view, w.head, 'reject');
    const back = await w.get(returned.id);
    const removed = await w.request(w.applicant.userId, 'DELETE', `/api/tenant/offers/${returned.id}`, {
      ifMatch: back.revision,
    });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect((await w.detail(view.id, w.applicant.userId)).status).toBe('cancelled');

    const batched = await w.offer(w.applicant);
    const batch = await w.json<{ id: string }>(await w.batchRaw({ offerIds: [batched.id] }), 201);
    await w.decide(await w.instance(batch.id), w.manager, 'disagree');
    const refused = await w.get(batched.id);
    const blocked = await w.request(w.applicant.userId, 'DELETE', `/api/tenant/offers/${batched.id}`, {
      ifMatch: refused.revision,
    });
    expect(await reasonOf(blocked)).toMatchObject({ status: 409, reason: 'OFFER_REFERENCED' });
  });
});

describe('Offer 批量审批（OF-R15）', () => {
  it('AC-OF-14：直接上级不同意 → 流程结束，不到一级组织负责人，子表 Offer 记不通过', async () => {
    const w = await offerApprovalWorld(testDb().db, 'batch-14');
    const [a, b] = [await w.offer(w.applicant), await w.offer(w.applicant)];
    const batch = await w.json<{ id: string; items: OfferView[] }>(await w.batchRaw({ offerIds: [a.id, b.id] }), 201);
    expect(batch.items.map((item) => item.approvalStatus)).toEqual(['approving', 'approving']);
    const view = await w.instance(batch.id);
    expect(view.approvalType).toBe('offer_batch');
    expect(w.pending(view).map((t) => t.assigneeUserId)).toEqual([w.manager.userId]);

    await w.decide(view, w.manager, 'disagree');
    const ended = await w.instance(batch.id);
    expect(ended.status).toBe('disapproved');
    expect(ended.tasks.some((t) => t.assigneeUserId === w.head.userId)).toBe(false);
    expect((await w.todos(w.head.userId)).items).toEqual([]);
    for (const offer of [a, b]) expect((await w.get(offer.id)).approvalStatus).toBe('disapproved');
  });

  it('同意两级 → 审批通过；审批主体缺省取申请人主职部门，表单带 7 列子表', async () => {
    const w = await offerApprovalWorld(testDb().db, 'batch-ok');
    const [a, b] = [await w.offer(w.applicant), await w.offer(w.applicant)];
    const batch = await w.json<{ id: string }>(await w.batchRaw({ offerIds: [a.id, b.id], remark: '合成批量' }), 201);
    const first = await w.instance(batch.id);
    expect(first.form.values).toMatchObject({ approvalSubjectOrgId: w.department, remark: '合成批量' });
    const rows = first.form.values.offers as Record<string, unknown>[];
    expect(rows.map((row) => row.offerId)).toEqual([a.id, b.id]);
    expect(Object.keys(rows[0]!).sort()).toEqual(
      ['offerId', 'name', 'school', 'education', 'plannedEntryDate', 'departmentId', 'positionId', 'baseSalary'].sort(),
    );
    expect(rows[0]).toMatchObject({ name: '合成实习生', plannedEntryDate: '2026-11-01', baseSalary: 6000 });

    await w.decide(first, w.manager, 'approve');
    const second = await w.instance(batch.id);
    expect(w.pending(second).map((t) => t.assigneeUserId)).toEqual([w.head.userId]);
    const listed = await w.json<{ items: OfferView[] }>(
      await w.request(w.applicant.userId, 'GET', '/api/tenant/offers?view=approving'),
    );
    expect(listed.items.find((item) => item.id === a.id)).toMatchObject({
      currentApprovalNode: '审批主体一级组织负责人',
      currentApprovers: ['部门负责人'],
    });
    await w.decide(second, w.head, 'approve');
    expect((await w.instance(batch.id)).status).toBe('approved');
    for (const offer of [a, b]) expect((await w.get(offer.id)).approvalStatus).toBe('approved');
  });

  it('AC-OF-15：申请人没有直接上级 → 首节点为空提交报错，不建单、Offer 不变', async () => {
    const w = await offerApprovalWorld(testDb().db, 'batch-15');
    const lonely = await w.person('无上级申请人', w.department);
    const offer = await w.offer(lonely);
    const refused = await reasonOf(await w.batchRaw({ offerIds: [offer.id] }, lonely));
    expect(refused).toMatchObject({ status: 409, code: 'CONFLICT' });
    // 首节点“处理人为空 = 无操作”（DEC-318 K-38）在提交时同样报错，不建单（DEC-054）
    expect(['APPROVAL_FIRST_NODE_EMPTY', 'APPROVAL_NO_ASSIGNEE']).toContain(refused.reason);
    expect(await w.get(offer.id, lonely)).toMatchObject({ approvalStatus: 'unsubmitted', revision: offer.revision });
    const initiated = await w.json<{ items: unknown[] }>(
      await w.request(lonely.userId, 'GET', '/api/tenant/approval/instances?role=initiated'),
    );
    expect(initiated.items).toEqual([]);
  });

  it('审批主体：显式指定组织按该组织的一级组织；申请人无主职部门又未指定 → 400', async () => {
    const w = await offerApprovalWorld(testDb().db, 'batch-subject');
    const top = await w.org('另一一级组织');
    const topHead = await w.person('另一负责人', top);
    await w.setOrgRoles(top, { head: topHead.employeeId });
    const child = await w.org('下级部门', top);
    const offer = await w.offer(w.applicant);
    const batch = await w.json<{ id: string }>(
      await w.batchRaw({ offerIds: [offer.id], approvalSubjectOrgId: child }),
      201,
    );
    await w.decide(await w.instance(batch.id), w.manager, 'approve');
    expect(w.pending(await w.instance(batch.id)).map((t) => t.assigneeUserId)).toEqual([topHead.userId]);

    const hrOffer = await w.json<OfferView>(
      await w.request(w.hr.id, 'POST', '/api/tenant/offers', {
        ifMatch: 0,
        body: {
          entry: 'intern',
          name: '合成',
          personalEmail: 'of3-hr@example.com',
          departmentId: w.department,
          plannedEntryDate: '2026-11-01',
        },
      }),
      201,
    );
    expect(
      await reasonOf(
        await w.request(w.hr.id, 'POST', '/api/tenant/offers/batch-approvals', {
          ifMatch: 0,
          body: { offerIds: [hrOffer.id] },
        }),
      ),
    ).toMatchObject({ status: 400, reason: 'OFFER_BATCH_SUBJECT_REQUIRED' });
  });

  it('子表校验：空 / 重复 → 400；含审批中的 Offer → 409，整单不建；无权发起 → 403', async () => {
    const w = await offerApprovalWorld(testDb().db, 'batch-guard');
    const [a, b] = [await w.offer(w.applicant), await w.offer(w.applicant)];
    expect((await w.batchRaw({ offerIds: [] })).status).toBe(400);
    expect((await w.batchRaw({ offerIds: [a.id, a.id] })).status).toBe(400);
    await w.json(await w.submitRaw(a));
    expect(await reasonOf(await w.batchRaw({ offerIds: [b.id, a.id] }))).toMatchObject({
      status: 409,
      reason: 'OFFER_APPROVAL_NOT_ALLOWED',
    });
    expect((await w.get(b.id)).approvalStatus).toBe('unsubmitted');
    expect((await w.denyUpdate(w.applicant, '/batch-approvals', 0, { offerIds: [b.id] })).status).toBe(403);
    expect((await w.get(b.id)).approvalStatus).toBe('unsubmitted');
  });
});
