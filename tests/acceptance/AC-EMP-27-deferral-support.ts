/** F-036 S6 夹具：延迟继承三种形态（设计 §4.2 / §5.1 J7）与来源台账读取。造数据全走真实 HTTP 入口。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { activationWorld, type ActivationWorld } from './AC-TRF-activation-support.js';
import type { EmploymentBusiness } from './AC-EMP-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { tenantApi } from './support/tenant-api.js';

export type Shape = 'department' | 'position' | 'both';
/** inherit / open：职位可编辑且不被排除（职级调整表单），自动带出开则职位按继承带出，关则部门、职位都延迟。 */
export type WorldShape = Shape | 'inherit' | 'open';

/**
 * 三种形态靠表单配置得到。调动表单把部门、职位列入“不自动带出”（可编辑时记 none），所以：
 * 部门延迟用不排除部门的“职务职位调整”表单 + 关闭自动带出；职位延迟用职位 absent；职位 readonly 则按继承。
 */
const shapeConfig: Record<
  WorldShape,
  { formId: string; autoPopulate: boolean; positionMode: 'readonly' | 'absent' | null }
> = {
  both: { formId: 'TenantBase.JobPostTransferMultiFormView', autoPopulate: false, positionMode: 'absent' },
  department: { formId: 'TenantBase.JobPostTransferMultiFormView', autoPopulate: false, positionMode: 'readonly' },
  position: { formId: 'TenantBase.TransferMultiFormView', autoPopulate: true, positionMode: 'absent' },
  inherit: { formId: 'TenantBase.JobLevelTransferMultiFormView', autoPopulate: true, positionMode: null },
  open: { formId: 'TenantBase.JobLevelTransferMultiFormView', autoPopulate: false, positionMode: null },
};

export interface LedgerRow {
  seq: string;
  version: number;
  field: string;
  kind: string;
  value: unknown;
  source: string | null;
  record: string | null;
  refSeq: string | null;
  reason: string | null;
}

export async function deferralWorld(db: Db, label: string, shape: WorldShape) {
  return deferralWorldFor(await activationWorld(db, label), shape);
}

async function deferralWorldFor(w: ActivationWorld, shape: WorldShape) {
  const config = shapeConfig[shape];
  const settings = await w.session.request('PUT', '/transfers/settings', {
    ifMatch: 0,
    body: { unrestrictTargetDepartment: true, autoPopulate: config.autoPopulate },
  });
  expect(settings.status, await settings.clone().text()).toBe(200);
  if (config.positionMode) {
    const form = await w.session.request('PUT', `/transfers/forms/${config.formId}`, {
      ifMatch: 0,
      body: { name: '延迟形态表单', group: 'transfer', fieldModes: { 'preset:positionId': config.positionMode } },
    });
    expect(form.status, await form.clone().text()).toBe(200);
  }
  const jobs = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
  const job = async (path: string, body: Record<string, unknown>) => {
    const response = await jobs.request('POST', `/api/tenant/job/${path}`, {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      ifMatch: 0,
      body: { name: `合成引用${randomUUID().slice(0, 8)}`, code: randomUUID(), startDate: '2026-01-01', ...body },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string };
  };
  const post = await job('posts', {});
  const position = await job('positions', { postId: post.id, orgId: w.from.id });
  // 职位 → 所属部门（J3 判定用）：同部门的另一职位、目标部门的职位
  const sibling = await job('positions', { postId: post.id, orgId: w.from.id });
  const target = await job('positions', { postId: post.id, orgId: w.to.id });
  const orgOf = new Map([
    [position.id, w.from.id],
    [sibling.id, w.from.id],
    [target.id, w.to.id],
  ]);
  const employee = await w.session.employee('合成延迟员工');
  const hire = await w.session.business(
    employee.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-09-01',
      fields: { departmentId: w.from.id, positionId: position.id, postId: post.id, place: '原地点' },
    },
    employee.revision,
  );
  return { ...w, shape, formId: config.formId, job, post, position, sibling, target, orgOf, employee, hire };
}

export type DeferralWorld = Awaited<ReturnType<typeof deferralWorldFor>>;

/** 走业务入口发起调动，默认用该世界配置的表单；formId 传 undefined 用默认表单（不做调动必填校验）。 */
export async function createTransfer(
  w: DeferralWorld,
  mode: 'direct' | 'application',
  effectiveDate: string,
  fields: Record<string, unknown> = {},
  formId: string | undefined = w.formId,
) {
  const employee = await w.session.getEmployee(w.employee.id);
  const response = await w.session.request('POST', `/employees/${w.employee.id}/businesses`, {
    ifMatch: employee.revision,
    body: { kind: 'transfer', mode, effectiveDate, fields, ...(formId ? { formId } : {}) },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as EmploymentBusiness;
}

export async function submitBusiness(w: DeferralWorld, id: string) {
  const response = await w.session.request('POST', `/businesses/${id}/submit`, {
    ifMatch: (await w.business(id)).revision,
    body: {},
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

export async function ledger(w: DeferralWorld, businessId: string, fields?: readonly string[]): Promise<LedgerRow[]> {
  return withTenant(w.db, w.session.tenant.id, async (tx) =>
    resultRows<LedgerRow>(
      await tx.execute(sql`
        SELECT o.seq::text AS seq, p.version_no AS version, o.field_code AS field, o.origin_kind AS kind, o.value,
          o.source_record_id AS source, o.record_id AS record, o.ref_seq::text AS "refSeq", o.reason
        FROM employment_field_origins o JOIN employment_payload_versions p
          ON p.tenant_id = o.tenant_id AND p.id = o.payload_version_id
        WHERE o.tenant_id = ${w.session.tenant.id} AND o.business_id = ${businessId}::uuid
        ORDER BY o.seq`),
    ).filter((row) => !fields || fields.includes(row.field)),
  );
}

export async function payloadVersions(w: DeferralWorld, businessId: string) {
  return withTenant(w.db, w.session.tenant.id, async (tx) =>
    resultRows<{ version: number }>(
      await tx.execute(sql`SELECT version_no AS version FROM employment_payload_versions
        WHERE tenant_id = ${w.session.tenant.id} AND business_id = ${businessId}::uuid ORDER BY version_no`),
    ).map((row) => row.version),
  );
}

export async function patchBusiness(w: DeferralWorld, id: string, body: Record<string, unknown>) {
  const current = await w.business(id);
  return w.session.request('PATCH', `/businesses/${id}`, { ifMatch: current.revision, body });
}
