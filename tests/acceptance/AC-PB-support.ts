/** BE-3 试用期与转正验收夹具（docs/02_业务建模/29 §2.1 / §2.3 / §4 / §8）：经路由入职、调整试用信息、转正。 */
import { randomUUID } from 'node:crypto';
import { withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { runEmploymentTransition } from '../../apps/api/src/modules/employment/transitions.js';
import { installMissingSeeds } from '../../apps/api/src/seeds/index.js';
import { employmentSession, withLoginEmail, type EmploymentBusiness } from './AC-EMP-support.js';
import { installApprovalFallbacks } from './AC-APV-support.js';

export async function pbWorld(db: Db, label: string, options: { approval?: boolean } = {}) {
  const session = await employmentSession(db, label);
  const org = await session.org(`试用部门-${label}`, { establishedOn: '2026-01-01' });
  if (options.approval) await installApprovalFallbacks(db, session.tenant.id, session.user.id);
  // 试用结果字典的预置项（DEC-361 种子）：新租户开通即装，夹具按模块补装
  await withTenant(db, session.tenant.id, (tx) =>
    installMissingSeeds(
      tx,
      { tenantId: session.tenant.id, actorUserId: null, now: new Date(), commandId: `pb-seed-${randomUUID()}` },
      { modules: ['employment-probation'] },
    ),
  );
  return { db, session, org };
}
export type PbWorld = Awaited<ReturnType<typeof pbWorld>>;

export interface ProbationDetail {
  readonly employeeId: string;
  readonly revision: number;
  readonly entryDate: string;
  readonly hasProbation: boolean;
  readonly startDate: string | null;
  readonly months: number | null;
  readonly expectedEndDate: string | null;
  readonly regularizationDate: string | null;
  readonly actualEndDate: string | null;
  readonly regularizationBusinessId: string | null;
  readonly regularizationState: string | null;
  readonly probationResult: string | null;
  readonly records: readonly {
    readonly id: string;
    readonly kind: string;
    readonly effectiveDate: string;
    readonly employeeStatus: number;
    readonly regularizationDate: string | null;
  }[];
}

/** 经通用入口直接入职；probation / probationMonths / probationEndDate 是入职控制项（entry-options.ts）。 */
export async function hire(
  w: PbWorld,
  options: { date?: string; probation?: boolean; months?: number; endDate?: string; name?: string } = {},
) {
  const employee = await w.session.employee(options.name ?? '试用合成员工');
  const body: Record<string, unknown> = {
    kind: 'hire',
    mode: 'direct',
    effectiveDate: options.date ?? '2026-09-01',
    fields: { employType: 'internal', departmentId: w.org.id },
    probation: options.probation ?? true,
    ...(options.months !== undefined ? { probationMonths: options.months } : {}),
    ...(options.endDate !== undefined ? { probationEndDate: options.endDate } : {}),
  };
  const response = await w.session.request('POST', `/employees/${employee.id}/businesses`, {
    ifMatch: employee.revision,
    body: withLoginEmail(employee.id, body),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return { employee, business: (await response.json()) as EmploymentBusiness };
}

export async function probationOf(w: PbWorld, employeeId: string, asOf = '2026-10-01'): Promise<ProbationDetail> {
  const response = await w.session.request('GET', `/employees/${employeeId}/probation?asOf=${asOf}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ProbationDetail;
}

export async function employeeRevision(w: PbWorld, employeeId: string): Promise<number> {
  return (await w.session.getEmployee(employeeId)).revision;
}

/** 调整试用信息（B6）：If-Match = 员工 revision。 */
export async function adjust(w: PbWorld, employeeId: string, body: Record<string, unknown>, revision?: number) {
  return w.session.request('PUT', `/employees/${employeeId}/probation`, {
    ifMatch: revision ?? (await employeeRevision(w, employeeId)),
    body,
  });
}

export interface RegularizationReceipt {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly items: readonly {
    readonly employeeId: string;
    readonly status: 'succeeded' | 'failed';
    readonly businessId: string | null;
    readonly effectiveDate: string | null;
    readonly businessStatus: string | null;
    readonly error: { readonly code: string; readonly message: string; readonly reason?: string } | null;
  }[];
}

/** 单个 / 批量转正（B7 / B8，PB-R8）：每人带员工 revision，单人失败只记在自己的回执里。 */
export async function regularize(
  w: PbWorld,
  body: { mode: 'direct' | 'application'; effectiveDate?: string; probationResult?: string },
  employees: readonly string[],
) {
  const items = [];
  for (const employeeId of employees) items.push({ employeeId, revision: await employeeRevision(w, employeeId) });
  return w.session.request('POST', '/regularizations', {
    body: { probationResult: 'normal', ...body, items },
  });
}

export async function regularizeOk(
  w: PbWorld,
  body: Parameters<typeof regularize>[1],
  employees: readonly string[],
): Promise<RegularizationReceipt> {
  const response = await regularize(w, body, employees);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as RegularizationReceipt;
}

/** 通用入口建一张转正申请草稿（原有能力）。 */
export async function draftRegularization(w: PbWorld, employeeId: string, effectiveDate: string) {
  return w.session.business(
    employeeId,
    { kind: 'regularization', mode: 'application', effectiveDate, probationResult: 'normal' },
    await employeeRevision(w, employeeId),
  );
}

/** 可信状态迁移端口（审批中心 / 定时任务）：造“审批中”“审批通过”的转正记录。 */
export async function transition(
  w: PbWorld,
  business: { id: string },
  action: 'submit' | 'approve' | 'reject' | 'activate',
  now = '2026-10-01T01:00:00Z',
) {
  const current = await w.session.request('GET', `/businesses/${business.id}`);
  const { revision } = (await current.json()) as { revision: number };
  return runEmploymentTransition(
    w.db,
    {
      tenantId: w.session.tenant.id,
      userId: w.session.user.id,
      timezone: w.session.tenant.timezone,
      now: new Date(now),
      commandId: randomUUID(),
      expectedRevision: revision,
    },
    { id: business.id, action },
  );
}

export async function probationView(w: PbWorld, view: string, query = '') {
  const response = await w.session.request('GET', `/probation-views?view=${view}${query}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: Record<string, unknown>[] }).items;
}
