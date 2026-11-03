import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { employmentSession, withLoginEmail, type EmploymentBusiness } from './AC-EMP-support.js';
import { tenantApi } from './support/tenant-api.js';
import { installApprovalFallbacks } from './AC-APV-support.js';
import { runEmploymentTransition } from '../../apps/api/src/modules/employment/transitions.js';

export const REHIRE_SETTING = 'employment.rehire_accumulate_seniority';
export async function rehireWorld(db: Db, label: string) {
  // 仅给业务红测补配置种子，使基线能走到“没有自动累计”的数值断言；种子本身另有无夹具验收。
  await db.execute(sql`INSERT INTO system_settings(key,value,description,overridable,version,updated_at)
    VALUES(${REHIRE_SETTING},'false'::jsonb,'合成重聘配置',true,1,now()) ON CONFLICT DO NOTHING`);
  const s = await employmentSession(db, `f432-rehire-${label}`);
  const api = tenantApi(db);
  const who = { user: s.user.id, tenant: s.tenant.id };
  const setting = async (value: boolean) => {
    const current = await api.request('GET', `/api/tenant/settings/${REHIRE_SETTING}`, who);
    expect(current.status).toBe(200);
    const { revision } = (await current.json()) as { revision: number };
    const r = await api.request('PUT', `/api/tenant/settings/${REHIRE_SETTING}`, {
      ...who,
      ifMatch: revision,
      body: { value },
    });
    expect(r.status, await r.clone().text()).toBe(200);
  };
  const departed = async () => {
    const e = await s.employee();
    const hire = await s.business(
      e.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2023-01-01',
        fields: { employType: 'internal', workYearCompanyBefore: 2 },
      },
      e.revision,
    );
    const leave = await s.business(
      e.id,
      { kind: 'leave', mode: 'direct', lastWorkDate: '2024-01-01' },
      hire.employeeRevision,
    );
    return { e, hire, leave };
  };
  const create = async (
    employeeId: string,
    correction = 1,
    mode = 'direct',
    date = '2026-10-01',
    commandId = randomUUID(),
  ) => {
    const employee = await s.getEmployee(employeeId);
    const r = await s.request('POST', `/employees/${employeeId}/businesses`, {
      ifMatch: employee.revision,
      idempotencyKey: commandId,
      body: withLoginEmail(employeeId, {
        kind: 'rehire',
        mode,
        effectiveDate: date,
        fields: { employType: 'internal', workYearCompanyBefore: correction },
      }),
    });
    expect(r.status, await r.clone().text()).toBe(201);
    return (await r.json()) as EmploymentBusiness;
  };
  const saved = async (id: string) => {
    const r = await s.request('GET', `/businesses/${id}`);
    expect(r.status).toBe(200);
    return (await r.json()) as EmploymentBusiness & { fields: { workYearCompanyBefore: number } };
  };
  const versions = (id: string) =>
    withTenant(db, s.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT work_year_company_before::text AS value
      FROM employment_payload_versions WHERE tenant_id=${s.tenant.id} AND business_id=${id}
      ORDER BY version_no`);
      return (Array.isArray(result) ? result : (result as { rows: { value: string }[] }).rows).map((r) =>
        Number((r as { value: string }).value),
      );
    });
  const approve = async (b: EmploymentBusiness) => {
    await installApprovalFallbacks(db, s.tenant.id, s.user.id);
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
    return r.body as EmploymentBusiness;
  };
  return { s, api, who, setting, departed, create, saved, versions, approve, transition };
}
