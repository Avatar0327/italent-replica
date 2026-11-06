/**
 * AC-DM-30-01～05：历史离职人员导入的基本结果与区间 / 整批校验（F-139a，设计 §4～§6、§12）。
 * 真 DB + HTTP；读写租户数据一律走 withTenant（app_owner 普通角色可过，DEC-568）。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { withLoginEmail } from './AC-EMP-support.js';
import { E, H, L, importWorld, type ErrorRow } from './AC-DM-30-support.js';

const database = useTestDb();

describe('AC-DM-30-01 两行合法数据 import', () => {
  it('建档、入职、离职三步落库，无账号 / 合同 / 试用期，离职单 mode=import', async () => {
    const x = await importWorld(database().db, '01');
    const d = await x.dept('历史部门');
    const body = await x.created([x.row(1, d.code), x.row(2, d.code)]);
    expect(body.rows.map((r) => r.rowNo)).toEqual([1, 2]);
    expect(body.batchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await x.employeeCount()).toBe(2);
    for (const item of body.rows) {
      const businesses = await x.businessesOf(item.employeeId);
      expect(businesses.map((b) => [b.kind, b.effectiveDate, b.state])).toEqual([
        ['hire', H, 'effective'],
        ['leave', E, 'effective'],
      ]);
      expect(await x.statesOf(item.exitBusinessId)).toEqual(['approved', 'effective']);
      expect(await x.exitRowOf(item.exitBusinessId)).toMatchObject({
        mode: 'import',
        initiator: 'hr',
        preReleaseDate: E,
        exitTypeCode: 'voluntary',
      });
      expect((await x.timelineOf(item.employeeId)).map((t) => t.startDate)).toEqual([H, E]);
      const [status] = await x.q<{ status: number }>(x.sql`SELECT employee_status AS status FROM employment_records
        WHERE tenant_id=${x.tenantId} AND employee_id=${item.employeeId}::uuid ORDER BY start_date DESC LIMIT 1`);
      expect(status?.status).toBe(8);
      expect(
        await x.q(x.sql`SELECT 1 FROM permission_user_person_links WHERE tenant_id=${x.tenantId}
          AND employee_id=${item.employeeId}::uuid`),
      ).toHaveLength(0);
      expect(
        await x.q(x.sql`SELECT 1 FROM contract_records WHERE tenant_id=${x.tenantId}
          AND employee_id=${item.employeeId}::uuid`),
      ).toHaveLength(0);
    }
    expect(await x.auditCount('employment.exit.imported')).toBe(2);
  });
});

describe('AC-DM-30-02 P1：部门在 L 之后停用', () => {
  it('导入放行；通用 hire 入口仍 400；导入人员不挡后续停用', async () => {
    const x = await importWorld(database().db, '02');
    const d = await x.dept('已停用部门');
    await x.disable(d.id, '2025-08-01');
    await x.created([x.row(1, d.code)]);
    const employee = await x.session.employee('通用入职对照');
    const generic = await x.session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: employee.revision,
      body: withLoginEmail(employee.id, {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: H,
        fields: { departmentId: d.id },
      }),
    });
    expect(generic.status).toBe(400);
    expect((await x.errorOf(generic)).details?.reason).toBe('EMPLOYMENT_DEPARTMENT_DISABLED');
    // D2：历史人员 [H, L] 不算在职，不应阻止之后把部门停用日定在 L+1 之后
    const d2 = await x.dept('后停用部门');
    await x.created([x.row(2, d2.code, { employeeNo: 'H0099' })]);
    expect(await x.disable(d2.id, '2025-09-01')).toBeGreaterThan(0);
  });
});

describe('AC-DM-30-03 端点：停用日 = E；stop_date = L 且无接续版本', () => {
  it.each([
    ['停用日恰为 E', async (x: Awaited<ReturnType<typeof importWorld>>, id: string) => x.disable(id, E)],
    [
      'stop_date = L 且无接续版本',
      async (x: Awaited<ReturnType<typeof importWorld>>, id: string) => x.stopAfter(id, L),
    ],
  ])('%s：导入成功', async (_name, prepare) => {
    const x = await importWorld(database().db, `03-${_name.length}`);
    const d = await x.dept('端点部门');
    await prepare(x, d.id);
    await x.created([x.row(1, d.code)]);
  });
});

describe('AC-DM-30-04 R1～R3：段内停用 / 短暂停用 / H 落在停用期内', () => {
  it('整批 400 IMPORT_ROWS_INVALID，逐行原因带 disabledOn，同批合法行零写入', async () => {
    const x = await importWorld(database().db, '04');
    const ok = await x.dept('合法部门');
    const r1 = await x.dept('段内停用');
    await x.disable(r1.id, '2024-06-01');
    const before = await x.writeCounts();
    const response = await x.importRows([x.row(1, ok.code), x.row(2, r1.code)]);
    expect(response.status).toBe(400);
    const error = await x.errorOf(response);
    expect(error.code).toBe('IMPORT_ROWS_INVALID');
    const rows = error.details!.rows as ErrorRow[];
    expect(rows.map((r) => r.rowNo)).toEqual([2]);
    expect(rows[0]!.errors![0]).toMatchObject({ reason: 'EMPLOYMENT_DEPARTMENT_DISABLED', disabledOn: '2024-06-01' });
    expect(await x.writeCounts()).toEqual(before);
  });

  it('R3：H 落在停用期内，提示为入职日期时为停用状态', async () => {
    const x = await importWorld(database().db, '04b');
    const d = await x.dept('入职日已停用');
    await x.disable(d.id, '2023-01-01');
    const response = await x.importRows([x.row(1, d.code)]);
    expect(response.status).toBe(400);
    const [row] = (await x.errorOf(response)).details!.rows as ErrorRow[];
    expect(row!.errors![0]!.message).toMatch(/在入职日期（.+）时为停用状态/);
  });
});

describe('AC-DM-30-05 R4～R8：收齐全部行错误，零写入', () => {
  it('设立日晚于 H、区间倒置、L = 今天、工号已存在、批内重复各自给出原因码，按 rowNo 升序', async () => {
    const x = await importWorld(database().db, '05');
    const late = await x.dept('晚设立', { establishedOn: '2024-01-01' });
    const ok = await x.dept('正常部门');
    await x.created([x.row(1, ok.code, { employeeNo: 'H0500' })]);
    const before = await x.writeCounts();
    const rows = [
      x.row(1, late.code, { employeeNo: 'H0001' }),
      x.row(2, ok.code, { employeeNo: 'H0002', entryDate: '2025-07-01', lastWorkDate: '2025-06-30' }),
      x.row(3, ok.code, { employeeNo: 'H0003', lastWorkDate: '2026-11-05' }),
      x.row(4, ok.code, { employeeNo: 'H0500' }),
      x.row(5, ok.code, { employeeNo: 'H0005' }),
      x.row(6, ok.code, { employeeNo: 'H0005' }),
    ];
    const response = await x.importRows(rows);
    expect(response.status).toBe(400);
    const error = await x.errorOf(response);
    expect(error.code).toBe('IMPORT_ROWS_INVALID');
    const got = (error.details!.rows as ErrorRow[]).map((r) => [r.rowNo, r.errors!.map((e) => e.reason)]);
    expect(got).toEqual([
      [1, ['ENTRY_BEFORE_DEPARTMENT_FOUNDED']],
      [2, ['EXIT_IMPORT_RANGE_INVERTED']],
      [3, ['EXIT_IMPORT_NOT_HISTORICAL']],
      [4, ['EMPLOYEE_NO_EXISTS']],
      [5, ['DUPLICATE_IN_BATCH']],
      [6, ['DUPLICATE_IN_BATCH']],
    ]);
    expect(await x.writeCounts()).toEqual(before);
  });
});
