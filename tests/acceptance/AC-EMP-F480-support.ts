import { randomUUID } from 'node:crypto';
import { type Db } from '@italent/db';
import { expect } from 'vitest';
import { employmentSession, withLoginEmail, type EmploymentBusiness, type EmploymentRecord } from './AC-EMP-support.js';
import { installApprovalFallbacks } from './AC-APV-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';
import { runEmploymentTransition } from '../../apps/api/src/modules/employment/transitions.js';

/** DEC-797：【实习转正】累计司龄开关（租户可覆盖，默认开启）。 */
export const INTERN_SETTING = 'employment.intern_regularization_accumulate_seniority';

export type RegularizedRecord = EmploymentRecord & { traineeStartDate: string | null };
export type RegularizedBusiness = EmploymentBusiness & { record: RegularizedRecord | null };

export async function internWorld(db: Db, label: string) {
  const s = await employmentSession(db, `f480-${label}-${uniqueSuffix()}`);
  const api = tenantApi(db, { clock: () => new Date('2026-10-01T01:00:00Z') });
  const who = { user: s.user.id, tenant: s.tenant.id };
  const setting = async (value: boolean) => {
    const current = await api.request('GET', `/api/tenant/settings/${INTERN_SETTING}`, who);
    expect(current.status, await current.clone().text()).toBe(200);
    const { revision } = (await current.json()) as { revision: number };
    const r = await api.request('PUT', `/api/tenant/settings/${INTERN_SETTING}`, {
      ...who,
      ifMatch: revision,
      body: { value },
    });
    expect(r.status, await r.clone().text()).toBe(200);
  };
  const dept = await s.org('合成转正部门', { establishedOn: '2000-01-01' });
  /** 实习生：直接入职（雇佣关系 = 实习生，在合成部门），可带手工司龄校正值。 */
  const intern = async (date = '2025-01-01', correction?: number) => {
    const e = await s.employee();
    const hire = await s.business(
      e.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: date,
        fields: {
          employType: 'intern',
          departmentId: dept.id,
          ...(correction === undefined ? {} : { workYearCompanyBefore: correction }),
        },
      },
      e.revision,
    );
    return { e, hire };
  };
  /** 直接转正走 /interns/:id/regularize（保存即生效）；申请走通用业务入口，到期落地。 */
  const regularize = async (
    employeeId: string,
    options: { date?: string; mode?: 'direct' | 'application'; commandId?: string } = {},
  ) => {
    const employee = await s.getEmployee(employeeId);
    const date = options.date ?? '2026-10-01';
    const direct = (options.mode ?? 'direct') === 'direct';
    const r = direct
      ? await s.request('POST', `/interns/${employeeId}/regularize`, {
          ifMatch: employee.revision,
          idempotencyKey: options.commandId ?? randomUUID(),
          body: { effectiveDate: date, departmentId: dept.id, probation: false },
        })
      : await s.request('POST', `/employees/${employeeId}/businesses`, {
          ifMatch: employee.revision,
          idempotencyKey: options.commandId ?? randomUUID(),
          body: withLoginEmail(employeeId, {
            kind: 'intern_regularization',
            mode: 'application',
            effectiveDate: date,
            fields: { departmentId: dept.id },
            probation: false,
          }),
        });
    expect(r.status, await r.clone().text()).toBe(201);
    return (await r.json()) as RegularizedBusiness;
  };
  const saved = async (id: string) => {
    const r = await s.request('GET', `/businesses/${id}`);
    expect(r.status).toBe(200);
    return (await r.json()) as RegularizedBusiness;
  };
  const record = async (id: string, asOf?: string) => (await s.record(id, asOf)) as RegularizedRecord;
  let approvalInstalled = false;
  const approve = async (b: EmploymentBusiness) => {
    if (!approvalInstalled) await installApprovalFallbacks(db, s.tenant.id, s.user.id);
    approvalInstalled = true;
    const submitted = await s.request('POST', `/businesses/${b.id}/submit`, { ifMatch: b.revision, body: {} });
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    return transition((await submitted.json()) as EmploymentBusiness, 'approve', '2026-10-01T01:00:00Z');
  };
  const transition = async (b: EmploymentBusiness, action: 'approve' | 'activate', now: string) => {
    const r = await runEmploymentTransition(
      db,
      {
        tenantId: s.tenant.id,
        userId: s.user.id,
        timezone: s.tenant.timezone,
        now: new Date(now),
        commandId: randomUUID(),
        expectedRevision: b.revision,
      },
      { id: b.id, action },
    );
    expect(r.status).toBe(200);
    return r.body as RegularizedBusiness;
  };
  const remove = (b: { id: string; revision: number }, commandId = randomUUID()) =>
    s.request('DELETE', `/businesses/${b.id}`, { ifMatch: b.revision, idempotencyKey: commandId, body: {} });
  return { s, api, who, dept, setting, intern, regularize, saved, record, approve, transition, remove };
}
