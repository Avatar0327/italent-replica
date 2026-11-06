/**
 * AC-DM-30-06：历史离职导入的编制评估（设计 §4.4）。严格 / 非严格控编都只提示不拒绝（DEC-258）；
 * 评估区间是各行自己的 [H, E)，批内同部门其他行按“与本行评估窗口求交”后计入（场景 ⑥）。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { withLoginEmail } from './AC-EMP-support.js';
import { E, H, importWorld, type ErrorRow, type ImportWorld } from './AC-DM-30-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const CONFIRMED = 'employment.exit.over_capacity_confirmed';

/** 年度编制方案 + 部门编制（periodStart 决定年度）。 */
async function capacity(x: ImportWorld, orgId: string, periodStart: string, strictControl: boolean) {
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
    name: `导入编制方案${orgId.slice(0, 6)}`,
    periodType: 'annual',
    maintenanceMode: 'local',
    startDate: '2022-01-01',
  });
  return post('/capacities', { orgId, schemeId: scheme.id, periodStart, localCapacity: 1, strictControl });
}

/** 在编的现有人员：普通入职（单人不超上限）。 */
async function occupant(x: ImportWorld, departmentId: string, effectiveDate: string) {
  const employee = await x.session.employee('在编合成员工');
  const hire = await x.session.business(
    employee.id,
    { kind: 'hire', mode: 'direct', effectiveDate, fields: { departmentId } },
    employee.revision,
  );
  expect(hire.status).toBe('effective');
}

const warningsOf = async (response: Response) =>
  ((await response.json()) as { rows: ErrorRow[] }).rows.map((r) => r.warnings ?? []);

describe.each([
  ['严格控编', true],
  ['非严格控编', false],
])('AC-DM-30-06 ①② %s：只提示不拒绝（DEC-258）', (_name, strict) => {
  it('preview 带警告；import 无 confirmed → 409 零写入；带 confirmed → 201 并留确认审计', async () => {
    const x = await importWorld(database().db, `06-${strict}`);
    const d = await x.dept('超编部门');
    const cap = await capacity(x, d.id, '2025-01-01', strict);
    await occupant(x, d.id, '2024-01-01');
    const rows = [x.row(1, d.code)];
    const preview = await x.preview(rows);
    expect(preview.status, await preview.clone().text()).toBe(200);
    expect(await warningsOf(preview)).toEqual([
      [
        {
          reason: 'ESTABLISHMENT_EXCEEDED',
          capacityId: cap.id,
          departmentId: d.id,
          positionId: null,
          from: H,
          to: E,
          peak: 2,
          limit: 1,
        },
      ],
    ]);
    const before = await x.writeCounts();
    const blocked = await x.importRows(rows);
    expect(blocked.status).toBe(409);
    const error = await x.errorOf(blocked);
    expect(error.details).toMatchObject({ reason: 'CONFIRMATION_REQUIRED' });
    expect((error.details!.rows as ErrorRow[])[0]!.warnings![0]).toMatchObject({
      reason: 'ESTABLISHMENT_EXCEEDED',
      capacityId: cap.id,
      departmentId: d.id,
      from: H,
      to: E,
      peak: 2,
      limit: 1,
    });
    expect(await x.writeCounts()).toEqual(before);
    const body = await x.created(rows, { confirmed: true });
    const audits = await x.q<{ after: Record<string, unknown> }>(
      x.sql`SELECT after FROM audit_events WHERE tenant_id=${x.tenantId} AND action=${CONFIRMED}`,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after).toMatchObject({ source: 'import', batchId: body.batchId, rowNo: 1 });
  });
});

describe('AC-DM-30-06 ③～⑤', () => {
  it('③ 库里那 1 人在 L 之后才入职，段内人数 0：无警告，无确认审计', async () => {
    const x = await importWorld(database().db, '06-3');
    const d = await x.dept('段后在编');
    await capacity(x, d.id, '2025-01-01', true);
    await occupant(x, d.id, '2025-08-01');
    const rows = [x.row(1, d.code)];
    expect(await warningsOf(await x.preview(rows))).toEqual([[]]);
    await x.created(rows);
    expect(await x.auditCount(CONFIRMED)).toBe(0);
  });

  it('④ 同批两行同部门区间相交：两行都有 peak 2 的警告', async () => {
    const x = await importWorld(database().db, '06-4');
    const d = await x.dept('批内相交');
    await capacity(x, d.id, '2025-01-01', true);
    const warnings = await warningsOf(await x.preview([x.row(1, d.code), x.row(2, d.code)]));
    expect(warnings.map((w) => w.map((item) => item.peak))).toEqual([[2], [2]]);
  });

  it('⑤ 普通 hire 回归：同样设定下通用入职不判编制，无提示', async () => {
    const x = await importWorld(database().db, '06-5');
    const d = await x.dept('普通入职对照');
    await capacity(x, d.id, '2025-01-01', true);
    await occupant(x, d.id, '2024-01-01');
    const employee = await x.session.employee('通用入职合成员工');
    const response = await x.session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: employee.revision,
      body: withLoginEmail(employee.id, {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: H,
        fields: { departmentId: d.id },
      }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    expect(JSON.stringify(await response.json())).not.toContain('ESTABLISHMENT_EXCEEDED');
  });
});

describe('AC-DM-30-06 ⑥ 异区间批次', () => {
  it('A 与 B / C 区间不相交：只有 B、C 各有一条 peak 2 的警告和确认审计', async () => {
    const x = await importWorld(database().db, '06-6');
    const d = await x.dept('异区间部门');
    await capacity(x, d.id, '2023-01-01', true);
    const rows = [
      x.row(1, d.code, { entryDate: '2023-03-01', lastWorkDate: '2023-06-30' }),
      x.row(2, d.code, { entryDate: '2023-08-01', lastWorkDate: '2023-09-30' }),
      x.row(3, d.code, { entryDate: '2023-08-01', lastWorkDate: '2023-09-30' }),
    ];
    const warnings = await warningsOf(await x.preview(rows));
    expect(warnings[0]).toEqual([]);
    for (const list of warnings.slice(1))
      expect(list).toEqual([expect.objectContaining({ from: '2023-08-01', to: '2023-10-01', peak: 2, limit: 1 })]);
    await x.created(rows, { confirmed: true });
    const audits = await x.q<{ rowNo: number }>(
      x.sql`SELECT (after->>'rowNo')::int AS "rowNo" FROM audit_events WHERE tenant_id=${x.tenantId}
        AND action=${CONFIRMED} ORDER BY 1`,
    );
    expect(audits.map((a) => a.rowNo)).toEqual([2, 3]);
  });
});
