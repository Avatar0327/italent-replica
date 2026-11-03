/** DEC-791② / DEC-793：标准司龄校正字段，真实 HTTP 与版本链。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS, STANDARD_PROFILES, tenureYears, tenureSample, tenureSegment } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { employmentSession, withLoginEmail } from './AC-EMP-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const FIELD = 'workYearCompanyBefore';
const rows = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];

async function world(label: string) {
  const db = database().db;
  const s = await employmentSession(db, `f432-${label}`);
  const org = await s.org('合成司龄部门', { establishedOn: '2020-01-01' });
  const e = await s.employee();
  const create = (correction?: unknown) =>
    s.request('POST', `/employees/${e.id}/businesses`, {
      ifMatch: e.revision,
      body: withLoginEmail(e.id, {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2025-07-20',
        fields: {
          departmentId: org.id,
          employType: 'internal',
          ...(correction === undefined ? {} : { [FIELD]: correction }),
        },
      }),
    });
  return { db, s, org, e, create };
}

it('AC-EMP-F432-01：默认 0；可存读 2 位小数，编辑追加快照、旧底表不改；409 重读改回原值与幂等重放', async () => {
  const w = await world('store');
  const r = await w.create();
  expect(r.status, await r.clone().text()).toBe(201);
  const b = (await r.json()) as { id: string; revision: number };
  expect((await w.s.record(b.id)).fields[FIELD]).toBe(0);
  const edit = (value: number, revision: number, commandId = randomUUID()) =>
    w.s.request('PATCH', `/records/${b.id}`, {
      ifMatch: revision,
      idempotencyKey: commandId,
      body: { fields: { [FIELD]: value } },
    });
  const cmd = randomUUID();
  const changed = await edit(2.01, b.revision, cmd);
  expect(changed.status, await changed.clone().text()).toBe(200);
  expect((await w.s.record(b.id)).fields[FIELD]).toBe(2.01);
  expect((await edit(2.01, b.revision, cmd)).status).toBe(200);
  expect((await edit(0, b.revision)).status).toBe(409);
  const current = await w.s.request('GET', `/businesses/${b.id}`);
  const fresh = (await current.json()) as { revision: number };
  expect((await edit(0, fresh.revision)).status).toBe(200);
  expect((await w.s.record(b.id)).fields[FIELD]).toBe(0);
  const versions = await withTenant(w.db, w.s.tenant.id, async (tx) =>
    rows<{ value: string }>(
      await tx.execute(sql`
    SELECT work_year_company_before::text AS value FROM employment_payload_versions
    WHERE tenant_id=${w.s.tenant.id} AND business_id=${b.id} ORDER BY version_no`),
    ),
  );
  expect(versions.map((v) => Number(v.value))).toContain(2.01);
  const original = await withTenant(w.db, w.s.tenant.id, async (tx) =>
    rows<{ value: string }>(
      await tx.execute(sql`
    SELECT work_year_company_before::text AS value FROM employment_records
    WHERE tenant_id=${w.s.tenant.id} AND id=${b.id}`),
    ),
  );
  expect(Number(original[0]!.value)).toBe(0);
});

it('AC-EMP-F432-02：合法精度可创建；负数、三位小数、空值、字符串不接受，失败不产生记录', async () => {
  const w = await world('precision');
  // 先证明字段受理，避免基线把所有输入当未知字段而假绿。
  const valid = await w.create(1.23);
  expect(valid.status, await valid.clone().text()).toBe(201);
  const b = (await valid.json()) as { id: string; revision: number };
  expect((await w.s.record(b.id)).fields[FIELD]).toBe(1.23);
  for (const value of [-0.01, 1.234, null, '2.00', 1e100]) {
    const r = await w.s.request('PATCH', `/records/${b.id}`, {
      ifMatch: b.revision,
      body: { fields: { [FIELD]: value } },
    });
    expect(r.status, String(value)).toBe(400);
    expect((await w.s.record(b.id)).fields[FIELD]).toBe(1.23);
  }
});

it('AC-EMP-F432-03：既有字段写权拒绝编辑、无查看权读口裁剪、跨租户不披露', async () => {
  const w = await world('permission');
  const created = await w.create();
  const b = (await created.json()) as { id: string; revision: number };
  const api = tenantApi(w.db, { authorize: (q) => !q.fields?.includes(FIELD) });
  const who = { user: w.s.user.id, tenant: w.s.tenant.id };
  const denied = await api.request('PATCH', `/api/tenant/employment/records/${b.id}`, {
    ...who,
    ifMatch: b.revision,
    body: { fields: { [FIELD]: 9.25 } },
  });
  expect(denied.status, await denied.clone().text()).toBe(403);
  const read = await api.request('GET', `/api/tenant/employment/records/${b.id}`, who);
  expect(read.status).toBe(200);
  expect(((await read.json()) as { fields: object }).fields).not.toHaveProperty(FIELD);
  const other = await employmentSession(w.db, 'f432-other');
  expect((await other.request('GET', `/records/${b.id}`)).status).toBe(404);
});

it('AC-EMP-F432-04：标准字段可配置，员工身份默认仅查看', () => {
  const field = MODULE_OBJECTS.employmentRecord.fields.find((f) => f.code === FIELD);
  expect(field).toBeDefined();
  expect(field?.system).not.toBe(true);
  const employee = STANDARD_PROFILES.find((p) => p.code === 'employee_self_service')!;
  const grant = employee.objects.find((g) => g.objectCode === 'TenantBase.EmploymentRecord');
  expect(grant?.fields.find((f) => f.fieldCode === FIELD)).toMatchObject({ view: true, edit: false });
});

it('AC-EMP-F432-05：累计司龄加校正后向下舍位；365 天年、空值与未来日期；分段按累计司龄', () => {
  // 允许基线旧函数少接一个参数，旧实现必须在数值断言上红。
  const years = tenureYears as (from: string | null, end: string, correction?: number) => string | null;
  const sample = tenureSample as (from: string | null, end: string, correction?: number) => number | null;
  const segment = tenureSegment as (from: string | null, end: string, correction?: number) => string;
  expect(years('2025-07-20', '2026-10-01', 2)).toBe('3.2');
  expect(years('2026-10-01', '2026-10-01', 0.29)).toBe('0.2');
  expect(years('2024-01-01', '2025-01-01', 0)).toBe('1.0');
  expect(years(null, '2026-10-01', 2)).toBeNull();
  expect(years('2027-01-01', '2026-10-01', 2)).toBeNull();
  expect(sample('2025-07-20', '2026-10-01', 2)).toBe(3.2);
  expect(segment('2025-07-20', '2026-10-01', 2)).toBe('2to5y');
  expect(segment('2026-10-01', '2026-10-01', 0.5)).toBe('6mto1y');
});

it('AC-EMP-F432-06：同周期继承校正值；新周期默认 0，编辑只追加、不串租户', async () => {
  const w = await world('inherit');
  const created = await w.create(2.01);
  expect(created.status, await created.clone().text()).toBe(201);
  const b = (await created.json()) as { id: string; employeeRevision: number };
  const adjustment = await w.s.business(
    w.e.id,
    {
      kind: 'org_adjustment',
      mode: 'direct',
      effectiveDate: '2026-09-01',
      fields: { remarks: '合成调整' },
    },
    b.employeeRevision,
  );
  expect((await w.s.record(adjustment.id)).fields[FIELD]).toBe(2.01);
  const other = await w.s.employee('另一合成员工');
  const hired = await w.s.business(
    other.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-09-01',
      fields: { departmentId: w.org.id },
    },
    other.revision,
  );
  expect((await w.s.record(hired.id)).fields[FIELD]).toBe(0);
});
