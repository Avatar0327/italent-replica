/**
 * BE-14a3 Offer 审批 / Offer 批量审批夹具：在审批中心夹具（approvalWorld）上建录用部门、部门负责人、申请人的直接上级，
 * 以可信方式安装并发布两个 Offer 预置流程（与开通时 provisioning 同一路径），Offer 走真实接口新建。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { PRESET_PROCESSES } from '@italent/domain';
import { expect } from 'vitest';
import { installPresets, publishProcess, replaceDraft } from '../../apps/api/src/modules/approval/definitions.js';
import { installMissingSeeds } from '../../apps/api/src/seeds/index.js';
import { approvalWorld, type InstanceView, type Person } from './AC-APV-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

export interface OfferView {
  readonly id: string;
  readonly status: string;
  readonly approvalStatus: string;
  readonly revision: number;
  readonly currentApprovers?: readonly string[];
  readonly currentApprovalNode?: string | null;
  readonly [key: string]: unknown;
}

const OFFERS = '/api/tenant/offers';

/** 可信夹具：安装全部预置并给指定类型的预置填异常管理员后发布（同 provisioning.publishPresetProcesses）。 */
async function publishPresets(db: Db, tenantId: string, userId: string, exceptionAdmin: string, types: string[]) {
  await withTenant(db, tenantId, async (tx) => {
    const ctx = { tenantId, userId, timezone: 'Asia/Shanghai', now: new Date(), commandId: randomUUID() };
    for (const installed of await installPresets(tx, { ...ctx, expectedRevision: 0 })) {
      if (!types.includes(installed.approvalType)) continue;
      const preset = PRESET_PROCESSES.find((p) => p.presetKey === installed.presetKey)!;
      const definition = { ...preset.definition, exceptionAdminUserId: exceptionAdmin };
      const draft = await replaceDraft(tx, { ...ctx, expectedRevision: installed.revision }, installed.id, definition);
      await publishProcess(tx, { ...ctx, expectedRevision: draft.revision }, installed.id);
    }
  });
}

export async function offerApprovalWorld(db: Db, label: string) {
  const w = await approvalWorld(db, `of3-${label}`);
  const department = await w.org(`录用部门${uniqueSuffix()}`);
  const manager = await w.person('直接上级', department);
  const head = await w.person('部门负责人', department);
  await w.setOrgRoles(department, { head: head.employeeId });
  const applicant = await w.person('申请人', department, { directManagerId: manager.employeeId });
  await publishPresets(db, w.tenant.id, w.hr.id, w.exceptionAdmin, ['offer', 'offer_batch']);
  // 失效原因字典（#398 失效接口要求启用的字典项）与社招必填的职级 / 合同主体（可信造数，同 AC-OF-BE14a-support）
  const [level, company] = await withTenant(db, w.tenant.id, async (tx) => {
    const context = { tenantId: w.tenant.id, actorUserId: null, now: w.clock(), commandId: randomUUID() };
    await installMissingSeeds(tx, context, { modules: ['offer'] });
    const rows = (result: unknown) => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows);
    const levelRow = rows(
      await tx.execute(sql`INSERT INTO job_level_objects(tenant_id) VALUES (${w.tenant.id})
      RETURNING id`),
    )[0] as { id: string };
    const companyRow = rows(
      await tx.execute(sql`INSERT INTO contract_companies(tenant_id, code, name)
      VALUES (${w.tenant.id}, ${`C${uniqueSuffix()}`}, '合成法人') RETURNING id`),
    )[0] as { id: string };
    return [levelRow.id, companyRow.id];
  });

  async function offer(actor: Person, departmentId = department): Promise<OfferView> {
    const body = {
      entry: 'intern',
      name: '合成实习生',
      personalEmail: `of3-${uniqueSuffix()}@example.com`,
      departmentId,
      plannedEntryDate: '2026-11-01',
      salaryAfterRegular: 6000,
    };
    return w.json<OfferView>(await w.request(actor.userId, 'POST', OFFERS, { ifMatch: 0, body }), 201);
  }
  /** 社招 Offer（待发可失效，OF-R7；实习待发不提供失效）。 */
  async function social(actor: Person): Promise<OfferView> {
    const body = {
      entry: 'offer',
      channelName: '内推',
      name: '合成候选人',
      personalEmail: `of3-${uniqueSuffix()}@example.com`,
      departmentId: department,
      plannedEntryDate: '2026-11-01',
      levelId: level,
      directManagerId: manager.employeeId,
      hrbpId: head.employeeId,
      costCenter: 'CC-001',
      contractCompanyId: company,
    };
    return w.json<OfferView>(await w.request(actor.userId, 'POST', OFFERS, { ifMatch: 0, body }), 201);
  }
  /** #398 的真实失效接口。 */
  const invalidateRaw = (target: OfferView, actor = applicant) =>
    w.request(actor.userId, 'POST', `${OFFERS}/${target.id}/invalidate`, {
      ifMatch: target.revision,
      body: { reasonCode: 'candidate_gave_up' },
    });
  const get = async (id: string, actor = applicant) =>
    w.json<OfferView>(await w.request(actor.userId, 'GET', `${OFFERS}/${id}`));
  const submitRaw = (target: OfferView, actor = applicant) =>
    w.request(actor.userId, 'POST', `${OFFERS}/${target.id}/approval`, { ifMatch: target.revision, body: {} });
  const batchRaw = (body: Record<string, unknown>, actor = applicant) =>
    w.request(actor.userId, 'POST', `${OFFERS}/batch-approvals`, { ifMatch: 0, body });
  /** 发起人视角的审批实例（按业务单 ID）。 */
  const instance = (businessId: string, actor = applicant): Promise<InstanceView> =>
    w.instanceOf(businessId, actor.userId);
  async function decide(view: InstanceView, actor: Person, action: 'approve' | 'disagree' | 'reject') {
    const task = w.pending(view).find((t) => t.assigneeUserId === actor.userId);
    expect(task, `${actor.name} 没有待办`).toBeDefined();
    const response = await w.taskAction(actor.userId, task!.id, action, view.revision, { comment: '合成意见' });
    expect(response.status, await response.clone().text()).toBe(200);
  }
  /** 拒绝 Offer 对象 update 的授权器（无权发起审批）；其余全部允许。 */
  const denying = tenantApi(db, {
    clock: w.clock,
    authorize: (request) => !(request.action === 'object.update' && request.resource === 'TenantBase.Offer'),
  });
  const denyUpdate = (actor: Person, path: string, ifMatch: number, body: Record<string, unknown> = {}) =>
    denying.request('POST', `${OFFERS}${path}`, { ...w.as(actor.userId), ifMatch, body });
  /** 同一授权器下的读（行操作反例：无编辑开关时不出现“发起审批”）。 */
  const denyRead = (actor: Person, path: string) => denying.request('GET', `${OFFERS}${path}`, w.as(actor.userId));
  return {
    ...w,
    apv: w,
    department,
    manager,
    head,
    applicant,
    offer,
    social,
    invalidateRaw,
    get,
    submitRaw,
    batchRaw,
    instance,
    decide,
    denyUpdate,
    denyRead,
  };
}

export const reasonOf = async (response: Response) => {
  const body = (await response.json()) as { error?: { code?: string; details?: { reason?: string } } };
  return { status: response.status, code: body.error?.code, reason: body.error?.details?.reason };
};
