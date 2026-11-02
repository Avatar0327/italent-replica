import './support/exit-gate-enforced.js';
/**
 * AC-HA-13c 审批实例“审批类别 / 业务日期”（规格 35 B51，R2 BE-13c）：由各业务的审批适配器在发起时写入；
 * Offer = 入职日期，离职 = 最后工作日，其余 = 生效日期；审批中改了业务日期，实例随新载荷刷新。存量不回填（DEC-402）。
 * 每条都走真实业务接口发起，再读 approval_instances 行。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { approvalCategoryOf, type ApproverSource } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { ADAPTERS, type BusinessSnapshot } from '../../apps/api/src/modules/approval/adapters.js';
import { resolveSource } from '../../apps/api/src/modules/approval/source-resolver.js';
import { approvalWorld, installApprovalFallbacks, transferScene, type InstanceView } from './AC-APV-support.js';
import { orgVersion } from './AC-APV-F318c-support.js';
import { contractWorld } from './AC-CT-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { offerApprovalWorld } from './AC-OF-BE14a3-support.js';
import { hire, pbWorld, regularizeOk } from './AC-PB-support.js';

const database = useTestDb();

function rowsOf<T>(value: unknown): T[] {
  return (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];
}

/** 业务单据的审批实例行：类别、业务日期、审批类型。 */
async function stamped(db: Db, tenantId: string, businessId: string) {
  const rows = await withTenant(db, tenantId, (tx) =>
    tx.execute(sql`SELECT approval_category AS category, business_date::text AS "businessDate",
        approval_type AS "approvalType"
      FROM approval_instances WHERE tenant_id=${tenantId} AND business_id=${businessId}::uuid ORDER BY created_at`),
  );
  return rowsOf<{ category: string | null; businessDate: string | null; approvalType: string }>(rows);
}

const current = (view: InstanceView) => view.tasks.find((task) => task.status === 'pending')!;

/** 部门关系来源（F-318a / F-318c）：按审批人来源日期取该组织当日的负责人。 */
const departmentHead = (orgId: string): ApproverSource => ({ type: 'department', value: orgId });

/**
 * 真实适配器快照 + 真实来源解析；主体字段与审批引擎 routingSubject 的取法一致。
 * control 是对照：同一来源给了日期时确能取到人，证明 heads 为空来自“未填来源日期”。
 */
async function snapshotHeads(
  w: { db: Db; tenantId: string; userId: string },
  business: { type: 'contract' | 'offer'; id: string; orgId: string },
) {
  return withTenant(w.db, w.tenantId, async (tx) => {
    const ctx = { tenantId: w.tenantId, userId: w.userId, timezone: 'Asia/Shanghai' };
    const command = { now: new Date('2026-10-01T01:00:00Z'), commandId: randomUUID(), expectedRevision: 0 };
    const snapshot: BusinessSnapshot = await ADAPTERS[business.type].snapshot(tx, { ...ctx, ...command }, business.id);
    const resolve = async (businessDate: string | undefined) =>
      (
        await resolveSource(
          tx,
          {
            tenantId: w.tenantId,
            asOf: '2026-10-01',
            businessDate,
            initiatorUserId: w.userId,
            subjectEmployeeId: snapshot.subjectEmployeeId,
            latestDepartmentId: snapshot.latestDepartmentId,
            recordDepartmentId: snapshot.recordDepartmentId,
          },
          departmentHead(business.orgId),
        )
      ).flatMap((candidate) => candidate.userId ?? []);
    return { snapshot, heads: await resolve(snapshot.businessDate), control: await resolve('2026-11-01') };
  });
}

describe('AC-HA-13c 审批类别与业务日期由各业务写入', () => {
  it('调动：类别 = 调动，业务日期 = 生效日期', async () => {
    const w = await approvalWorld(database().db, 'ha13c-transfer');
    const s = await transferScene(w);
    await w.publishedProcess({
      nodes: [{ key: 'out_head', approver: { type: 'department', value: 'latest_record_department_head' } }],
    });
    const business = await w.application(s.subject.employeeId, { departmentId: s.to }, { effectiveDate: '2026-10-15' });
    await w.submit(business);
    expect(await stamped(w.db, w.tenant.id, business.id)).toEqual([
      { category: 'transfer', businessDate: '2026-10-15', approvalType: 'transfer' },
    ]);
  });

  it('离职：类别 = 离职，业务日期 = 最后工作日（不是次日的生效日期）；审批中改最后工作日，实例随之刷新', async () => {
    const w = await approvalWorld(database().db, 'ha13c-leave');
    await installExitSeeds(w.db, w.tenant.id);
    const s = await transferScene(w);
    await w.publishedProcess({
      approvalType: 'leave',
      conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'DimissionProcessNew' }] },
      nodes: [
        {
          key: 'out_head',
          approver: { type: 'department', value: 'latest_record_department_head' },
          formFields: ['lastWorkDate', 'effectiveDate'],
          editableFields: ['lastWorkDate'],
          editMode: 'separate',
        },
      ],
    });
    const employee = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${s.subject.employeeId}`),
    );
    const draft = await w.json<{ id: string; revision: number }>(
      await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${s.subject.employeeId}/businesses`, {
        ifMatch: employee.revision,
        body: {
          kind: 'leave',
          mode: 'application',
          lastWorkDate: '2026-10-20',
          fields: {},
          exit: { exitTypeCode: 'voluntary' },
        },
      }),
      201,
    );
    const view = await w.submit(draft);
    expect(view.form.values).toMatchObject({ lastWorkDate: '2026-10-20', effectiveDate: '2026-10-21' });
    expect(await stamped(w.db, w.tenant.id, draft.id)).toEqual([
      { category: 'exit', businessDate: '2026-10-20', approvalType: 'leave' },
    ]);
    const edited = await w.taskAction(s.outHead.userId, current(view).id, 'edit', view.revision, {
      fields: { lastWorkDate: '2026-10-25' },
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect(await stamped(w.db, w.tenant.id, draft.id)).toEqual([
      { category: 'exit', businessDate: '2026-10-25', approvalType: 'leave' },
    ]);
  });

  it('转正：类别 = 转正，业务日期 = 转正生效日期', async () => {
    const w = await pbWorld(database().db, 'ha13c-regular', { approval: true });
    const a = await hire(w, { months: 3, name: '甲' });
    const receipt = await regularizeOk(w, { mode: 'application' }, [a.employee.id]);
    const item = receipt.items[0]!;
    expect(item).toMatchObject({ status: 'succeeded', effectiveDate: '2026-12-01', businessStatus: 'in_review' });
    expect(await stamped(w.db, w.session.tenant.id, item.businessId!)).toEqual([
      { category: 'regularization', businessDate: '2026-12-01', approvalType: 'regularization' },
    ]);
  });

  it('合同：类别 = 合同，业务日期 = 合同生效日期', async () => {
    const w = await contractWorld(database().db, 'ha13c-contract');
    await installApprovalFallbacks(w.db, w.session.tenant.id, w.session.user.id, ['contract_create']);
    const response = await w.request('POST', '/commands', {
      ifMatch: 0,
      body: {
        operation: 'create',
        mode: 'application',
        employeeId: w.employee.id,
        fields: { ...w.fields, effectiveDate: '2026-11-01', endDate: '2028-10-31', termMonths: 24 },
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const created = (await response.json()) as { id: string };
    expect(await stamped(w.db, w.session.tenant.id, created.id)).toEqual([
      { category: 'contract', businessDate: '2026-11-01', approvalType: 'contract_create' },
    ]);
  });

  it('Offer：类别 = Offer，业务日期 = 入职日期；Offer 批量审批类别 = Offer，没有单一入职日期则为空', async () => {
    const w = await offerApprovalWorld(database().db, 'ha13c-offer');
    const single = await w.offer(w.applicant);
    expect((await w.submitRaw(single)).status).toBe(200);
    expect(await stamped(w.db, w.tenant.id, single.id)).toEqual([
      { category: 'offer', businessDate: '2026-11-01', approvalType: 'offer' },
    ]);
    const a = await w.offer(w.applicant);
    const b = await w.offer(w.applicant);
    const batch = await w.json<{ id: string }>(await w.batchRaw({ offerIds: [a.id, b.id] }), 201);
    expect(await stamped(w.db, w.tenant.id, batch.id)).toEqual([
      { category: 'offer', businessDate: null, approvalType: 'offer_batch' },
    ]);
  });

  it('类别映射：6 类核心之外（退休、兼职、员工信息变更、IDP 等）一律归“其他”', () => {
    expect(
      ['offer', 'offer_batch', 'hire', 'regularization', 'intern_regularization', 'transfer', 'leave'].map(
        approvalCategoryOf,
      ),
    ).toEqual(['offer', 'offer', 'entry', 'regularization', 'regularization', 'transfer', 'exit']);
    for (const type of ['contract_create', 'contract_renew', 'contract_change', 'contract_terminate'])
      expect(approvalCategoryOf(type), type).toBe('contract');
    for (const type of ['retirement', 'part_time_add', 'emp_info_change', 'idp_plan', 'personnel_change'])
      expect(approvalCategoryOf(type), type).toBe('other');
  });
});

/**
 * 合并适配 m1：看板日期（规格 35 B51）与审批人来源日期（F-318a，DEC-686）是两个字段。
 * 离职单看板取最后工作日，审批人来源仍按生效日期；合同 / Offer 不填来源日期，取人结果与 main 一致。
 */
describe('AC-HA-13c 看板日期不改变 F-318a 审批人来源日期', () => {
  it('离职（生效日期 = 最后工作日次日）：实例业务日期 = 最后工作日，部门负责人按生效日期当天的组织版本取', async () => {
    const w = await approvalWorld(database().db, 'ha13c-split-leave');
    await installExitSeeds(w.db, w.tenant.id);
    const s = await transferScene(w);
    const approving = await w.org('合成审批部门');
    const before = await w.person('合成原负责人', approving);
    const after = await w.person('合成新负责人', approving);
    await w.setOrgRoles(approving, { head: before.employeeId });
    // 负责人恰在生效日期（最后工作日次日）换人：按最后工作日取会派给原负责人
    await orgVersion(w, approving, { startDate: '2026-10-21', personInChargeId: after.employeeId });
    await w.publishedProcess({
      approvalType: 'leave',
      conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'DimissionProcessNew' }] },
      nodes: [{ key: 'head', approver: departmentHead(approving), formFields: ['lastWorkDate', 'effectiveDate'] }],
    });
    const employee = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${s.subject.employeeId}`),
    );
    const draft = await w.json<{ id: string; revision: number }>(
      await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${s.subject.employeeId}/businesses`, {
        ifMatch: employee.revision,
        body: {
          kind: 'leave',
          mode: 'application',
          lastWorkDate: '2026-10-20',
          fields: {},
          exit: { exitTypeCode: 'voluntary' },
        },
      }),
      201,
    );
    const view = await w.submit(draft);
    expect(view.form.values).toMatchObject({ lastWorkDate: '2026-10-20', effectiveDate: '2026-10-21' });
    expect(w.pending(view).map((task) => task.assigneeUserId)).toEqual([after.userId]);
    expect(await stamped(w.db, w.tenant.id, draft.id)).toEqual([
      { category: 'exit', businessDate: '2026-10-20', approvalType: 'leave' },
    ]);
  });

  it('合同：不填审批人来源日期（与 main 一致），部门关系来源取不到人；看板业务日期照常写入', async () => {
    const w = await contractWorld(database().db, 'ha13c-split-contract');
    await installApprovalFallbacks(w.db, w.session.tenant.id, w.session.user.id, ['contract_create']);
    // 合同部门负责人设为本单员工（入职时已绑定账号）：来源日期一旦被填上，部门关系就会取到此人
    await orgVersion({ db: w.db, tenant: w.session.tenant }, w.org.id, { personInChargeId: w.employee.id });
    const response = await w.request('POST', '/commands', {
      ifMatch: 0,
      body: {
        operation: 'create',
        mode: 'application',
        employeeId: w.employee.id,
        fields: { ...w.fields, effectiveDate: '2026-11-01', endDate: '2028-10-31', termMonths: 24 },
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const created = (await response.json()) as { id: string };
    const { snapshot, heads, control } = await snapshotHeads(
      { db: w.db, tenantId: w.session.tenant.id, userId: w.session.user.id },
      { type: 'contract', id: created.id, orgId: w.org.id },
    );
    expect(heads).toEqual([]);
    expect(control).toHaveLength(1);
    expect(snapshot.businessDate).toBeUndefined();
    expect(await stamped(w.db, w.session.tenant.id, created.id)).toEqual([
      { category: 'contract', businessDate: '2026-11-01', approvalType: 'contract_create' },
    ]);
  });

  it('Offer：不填审批人来源日期（与 main 一致），录用部门负责人不经部门关系来源取出', async () => {
    const w = await offerApprovalWorld(database().db, 'ha13c-split-offer');
    const single = await w.offer(w.applicant);
    const { snapshot, heads, control } = await snapshotHeads(
      { db: w.db, tenantId: w.tenant.id, userId: w.hr.id },
      { type: 'offer', id: single.id, orgId: w.department },
    );
    expect(heads).toEqual([]);
    expect(control).toEqual([w.head.userId]);
    expect(snapshot.businessDate).toBeUndefined();
  });
});
