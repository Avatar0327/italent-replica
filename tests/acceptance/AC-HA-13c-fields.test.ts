import './support/exit-gate-enforced.js';
/**
 * AC-HA-13c 审批实例“审批类别 / 业务日期”（规格 35 B51，R2 BE-13c）：由各业务的审批适配器在发起时写入；
 * Offer = 入职日期，离职 = 最后工作日，其余 = 生效日期；审批中改了业务日期，实例随新载荷刷新。存量不回填（DEC-402）。
 * 每条都走真实业务接口发起，再读 approval_instances 行。
 */
import { sql, withTenant, type Db } from '@italent/db';
import { approvalCategoryOf } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, installApprovalFallbacks, transferScene, type InstanceView } from './AC-APV-support.js';
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

describe('AC-HA-13c 审批类别与业务日期由各业务写入', () => {
  it('调动：类别 = 调动，业务日期 = 生效日期', async () => {
    const w = await approvalWorld(database().db, 'ha13c-transfer');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: [{ key: 'out_head', approver: 'latest_record_department_head' }] });
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
          approver: 'latest_record_department_head',
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
