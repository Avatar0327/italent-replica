/**
 * AC-DM-30-16～18：历史离职导入的逐行校验与请求形状返工回归（F-139a 第 2 轮）。
 * 16 = 行内容错误收齐、带字段与中文原因（P2-1）；17 = 设计 §2.2 的 null 请求形状（P2-2）；
 * 18 = 隐藏编制提示只记在对应超编行（P2-3）。
 */
import './support/exit-gate-enforced.js';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { H, importWorld, type ErrorRow, type ImportWorld } from './AC-DM-30-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const CONFIRMED = 'employment.exit.over_capacity_confirmed';
const CHINESE = /[一-鿿]/;
const ALL: ModuleScope = { ...EMPTY_SCOPE, all: true, hasDataPermission: true };
const FIELDS = new Set([
  ...MODULE_OBJECTS.employmentRecord.fields.map((field) => field.code),
  ...MODULE_OBJECTS.employee.fields.map((field) => field.code),
  'id',
  'revision',
]);

describe('AC-DM-30-16 行内容错误收齐（P2-1）', () => {
  it('空白姓名、停用部门、入职早于设立日同批返回：每行带 field 与中文原因，按 rowNo 升序，零写入', async () => {
    const x = await importWorld(database().db, '16');
    const ok = await x.dept('收齐合法部门');
    const stopped = await x.dept('收齐停用部门');
    await x.disable(stopped.id, '2024-06-01');
    const late = await x.dept('收齐晚设立部门', { establishedOn: '2024-01-01' });
    const before = await x.writeCounts();
    const response = await x.importRows([
      x.row(1, ok.code, { employeeNo: 'H0001', name: '   ' }),
      x.row(2, stopped.code, { employeeNo: 'H0002' }),
      x.row(3, late.code, { employeeNo: 'H0003' }),
      x.row(4, ok.code, { employeeNo: 'H0004' }),
    ]);
    expect(response.status, await response.clone().text()).toBe(400);
    const error = await x.errorOf(response);
    expect(error.code).toBe('IMPORT_ROWS_INVALID');
    const rows = error.details!.rows as ErrorRow[];
    expect(rows.map((r) => r.rowNo)).toEqual([1, 2, 3]);
    const errors = rows.map((r) => r.errors!);
    expect(errors.map((list) => list.map((e) => e.field))).toEqual([['name'], ['departmentCode'], ['entryDate']]);
    for (const issue of errors.flat()) expect(issue.message, JSON.stringify(issue)).toMatch(CHINESE);
    expect(JSON.stringify(rows)).not.toMatch(/Too small|Invalid input|expected string/);
    expect(await x.writeCounts()).toEqual(before);
  });

  it('多种字段形状错误（日期格式、字典外编码）与行校验错误一起收齐', async () => {
    const x = await importWorld(database().db, '16b');
    const ok = await x.dept('收齐字段部门');
    const response = await x.preview([
      x.row(1, ok.code, { employeeNo: 'H0001', entryDate: '2023/03/01' }),
      x.row(2, ok.code, { employeeNo: 'H0002', exitReasonCode: 'NOPE' }),
      x.row(3, ok.code, { employeeNo: 'H0003' }),
    ]);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as { rows: ErrorRow[]; summary: { failed: number } };
    expect(body.rows.map((r) => [r.rowNo, r.ok])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
    expect(body.rows[0]!.errors![0]).toMatchObject({ field: 'entryDate' });
    expect(body.rows[1]!.errors![0]).toMatchObject({ field: 'exitReasonCode' });
    for (const issue of body.rows.flatMap((r) => r.errors ?? [])) expect(issue.message).toMatch(CHINESE);
  });
});

describe('AC-DM-30-17 设计 §2.2 的 null 请求形状（P2-2）', () => {
  const nulls = {
    positionCode: null,
    postCode: null,
    exitTypeCode: null,
    exitReasonCode: null,
    exitDestinationCode: null,
    addToBlacklist: null,
    blacklistReason: null,
    blacklistExpiryDate: null,
    blacklistNote: null,
  };

  it('可选字段为 null：preview 200 全部 ok，import 201，等同未填', async () => {
    const x = await importWorld(database().db, '17');
    const d = await x.dept('空值形状部门');
    const rows = [x.row(1, d.code, nulls)];
    const preview = await x.preview(rows);
    expect(preview.status, await preview.clone().text()).toBe(200);
    expect(((await preview.json()) as { rows: ErrorRow[] }).rows[0]!.ok).toBe(true);
    const body = await x.created(rows);
    expect(await x.exitRowOf(body.rows[0]!.exitBusinessId)).toMatchObject({ exitTypeCode: null });
    expect(await x.q(x.sql`SELECT 1 FROM employment_blacklist WHERE tenant_id=${x.tenantId}`)).toHaveLength(0);
  });

  it('未知字段仍然 400（strict 不放宽）', async () => {
    const x = await importWorld(database().db, '17b');
    const d = await x.dept('未知字段部门');
    const response = await x.preview([x.row(1, d.code, { surprise: 1 })]);
    expect(response.status).toBe(400);
  });
});

async function capacity(x: ImportWorld, orgId: string) {
  const api = tenantApi(x.db, { clock: () => new Date('2026-11-05T01:00:00Z') });
  const post = async (path: string, body: object) => {
    const response = await api.request('POST', `/api/tenant/establishment${path}`, {
      user: x.session.user.id,
      tenant: x.tenantId,
      ifMatch: 0,
      body,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string };
  };
  const scheme = await post('/schemes', {
    name: `隐藏编制方案${orgId.slice(0, 6)}`,
    periodType: 'annual',
    maintenanceMode: 'local',
    startDate: '2022-01-01',
  });
  await post('/capacities', {
    orgId,
    schemeId: scheme.id,
    periodStart: '2025-01-01',
    localCapacity: 1,
    strictControl: false,
  });
  const employee = await x.session.employee('在编合成员工');
  const hire = await x.session.business(
    employee.id,
    { kind: 'hire', mode: 'direct', effectiveDate: '2024-01-01', fields: { departmentId: orgId } },
    employee.revision,
  );
  expect(hire.status).toBe('effective');
}

describe('AC-DM-30-18 隐藏编制提示只记在对应行（P2-3）', () => {
  it('行 A 不超编、行 B 在不可见编制上超编：只有 B 留确认审计；响应不泄露编制明细', async () => {
    const x = await importWorld(database().db, '18');
    const dA = await x.dept('隐藏编制-未超编');
    const dB = await x.dept('隐藏编制-超编');
    await capacity(x, dB.id);
    const authorize = () => true;
    const request = x.restricted(authorize, undefined, [...FIELDS]);
    registerScopeProvider(authorize, {
      scope: async (query) =>
        query.objectCode === MODULE_OBJECTS.establishment.code
          ? {
              ...EMPTY_SCOPE,
              hasDataPermission: true,
              terms: [
                {
                  dimension: 'organization',
                  orgIds: [dA.id],
                  personIds: [],
                  personQuery: { kind: 'organization', tenantId: x.tenantId, asOf: H },
                },
              ],
            }
          : ALL,
      authorize: async () => true,
      fields: async () => FIELDS,
    });
    const rows = [x.row(1, dA.code, { employeeNo: 'H0001' }), x.row(2, dB.code, { employeeNo: 'H0002' })];
    const key = `dm30-${uniqueSuffix()}`;
    const blocked = await request('POST', '/exits/import', { body: { rows }, idempotencyKey: `${key}-a` });
    expect(blocked.status).toBe(409);
    const blockedText = await blocked.text();
    expect(blockedText).not.toContain('capacityId');
    expect(blockedText).not.toContain('peak');
    const confirmed = await request('POST', '/exits/import', {
      body: { rows, confirmed: true },
      idempotencyKey: `${key}-b`,
    });
    expect(confirmed.status, await confirmed.clone().text()).toBe(201);
    const audits = await x.q<{ rowNo: number; hiddenCount: number }>(x.sql`SELECT (after->>'rowNo')::int AS "rowNo",
      (after->>'hiddenCount')::int AS "hiddenCount" FROM audit_events
      WHERE tenant_id=${x.tenantId} AND action=${CONFIRMED} ORDER BY 1`);
    expect(audits).toEqual([{ rowNo: 2, hiddenCount: 1 }]);
    expect(JSON.stringify(audits)).not.toContain('capacityId');
  });
});
