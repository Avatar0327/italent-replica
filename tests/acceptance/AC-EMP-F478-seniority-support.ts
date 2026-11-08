/**
 * F-478 S6 验收夹具：退休返聘（retire_rehire）累计司龄开关。
 * 在 F-432 离职重聘夹具思路之上：造“入职 → 退休 → 返聘”的真实版本链，开关经租户设置接口真 HTTP 修改。
 * 期望值一律手算（天数 / 365 取一位小数向下舍位），不调用产品里的 tenureYears。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { employmentSession, type EmploymentBusiness } from './AC-EMP-support.js';
import { REHIRE_SETTING } from './AC-EMP-F432-rehire-support.js';
import { tenantApi } from './support/tenant-api.js';
import { runEmploymentTransition } from '../../apps/api/src/modules/employment/transitions.js';

export const RETIRE_REHIRE_SETTING = 'employment.retire_rehire_accumulate_seniority';

/** 手算累计：(最后工作日 − 入职日)/365 + 校正值，一位小数向下舍位（15 WorkYearCompanyTotal）。 */
export function handTenure(entry: string, lastWork: string, correction: number): number {
  const days = (Date.parse(`${lastWork}T00:00:00Z`) - Date.parse(`${entry}T00:00:00Z`)) / 86_400_000;
  return Math.floor((days / 365 + correction) * 10 + 1e-9) / 10;
}

/** 仅给业务红测补配置种子，使基线能走到“没有自动累计”的数值断言；设置键本身另有无夹具验收（AC-EMP-F478-21）。 */
export async function seedSettings(db: Db) {
  for (const key of [REHIRE_SETTING, RETIRE_REHIRE_SETTING])
    await db.execute(sql`INSERT INTO system_settings(key,value,description,overridable,version,updated_at)
      VALUES(${key},'false'::jsonb,'合成累计司龄配置',true,1,now()) ON CONFLICT DO NOTHING`);
}

export async function putSetting(
  db: Db,
  who: { user: string; tenant: string },
  key: string,
  value: boolean,
  clock?: () => Date,
) {
  const api = tenantApi(db, clock ? { clock } : {});
  const current = await api.request('GET', `/api/tenant/settings/${key}`, who);
  expect(current.status, await current.clone().text()).toBe(200);
  const { revision } = (await current.json()) as { revision: number };
  const r = await api.request('PUT', `/api/tenant/settings/${key}`, { ...who, ifMatch: revision, body: { value } });
  expect(r.status, await r.clone().text()).toBe(200);
}

export async function retireWorld(db: Db, label: string) {
  await seedSettings(db);
  const s = await employmentSession(db, `f478-s6-${label}`);
  const who = { user: s.user.id, tenant: s.tenant.id };
  const setting = (key: string, value: boolean) => putSetting(db, who, key, value);
  const rows = <T>(statement: ReturnType<typeof sql>) =>
    withTenant(db, s.tenant.id, async (tx) => {
      const result = await tx.execute(statement);
      return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];
    });

  /** 入职 2023-01-01（校正值 2）→ 退休（最后工作日 2024-01-01）；累计期望 (365/365)+2 = 3。 */
  const retired = async () => {
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
    const retirement = await s.business(
      e.id,
      { kind: 'retirement', mode: 'direct', lastWorkDate: '2024-01-01', fields: {} },
      hire.employeeRevision,
    );
    return { e, hire, retirement };
  };
  /** 入职 → 离职（用于离职重聘对照，数值同上）。 */
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
  const rehireBody = (
    kind: 'rehire' | 'retire_rehire',
    correction: number,
    mode: string,
    date: string,
    extra = {},
  ) => ({
    kind,
    mode,
    effectiveDate: date,
    fields: { employType: 'internal', workYearCompanyBefore: correction },
    ...extra,
  });
  const create = async (
    employeeId: string,
    kind: 'rehire' | 'retire_rehire' = 'retire_rehire',
    correction = 1,
    mode = 'direct',
    date = '2026-10-01',
  ) => {
    const employee = await s.getEmployee(employeeId);
    const r = await s.request('POST', `/employees/${employeeId}/businesses`, {
      ifMatch: employee.revision,
      idempotencyKey: randomUUID(),
      body: rehireBody(kind, correction, mode, date),
    });
    expect(r.status, await r.clone().text()).toBe(201);
    return (await r.json()) as EmploymentBusiness;
  };
  const saved = async (id: string) => {
    const r = await s.request('GET', `/businesses/${id}`);
    expect(r.status).toBe(200);
    return (await r.json()) as EmploymentBusiness & { fields: { workYearCompanyBefore: number } };
  };
  const versions = async (id: string) =>
    (
      await rows<{ value: string }>(sql`SELECT work_year_company_before::text AS value
      FROM employment_payload_versions WHERE tenant_id=${s.tenant.id} AND business_id=${id}
      ORDER BY version_no`)
    ).map((r) => Number(r.value));
  const snapshots = async (id: string) =>
    (
      await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM employment_rehire_seniority_snapshots
      WHERE tenant_id=${s.tenant.id} AND business_id=${id}`)
    )[0]!.n;
  const audits = (id: string, action: string) =>
    rows<{ before: unknown; after: unknown }>(sql`SELECT before,after FROM audit_events
      WHERE tenant_id=${s.tenant.id} AND object_id=${id} AND action=${action}`);
  const activate = async (b: EmploymentBusiness, now: string) => {
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
      { id: b.id, action: 'activate' },
    );
    expect(r.status).toBe(200);
    return r.body as EmploymentBusiness;
  };
  return { s, who, setting, retired, departed, create, saved, versions, snapshots, audits, activate, rows };
}

export type RetireWorld = Awaited<ReturnType<typeof retireWorld>>;
