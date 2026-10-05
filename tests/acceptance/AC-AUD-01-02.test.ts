/**
 * AC-AUD-01 / 02（docs/02_业务建模/20 §5 第 1、2 条，DEC-019；REQ-AUD-001 R1、R2）：
 * 组织员工的单条编辑进入统一的字段级数据变更日志，格式「字段:从【旧】修改为【新】」，带操作人、时间、
 * 来源动作、来源页面、终端、IP、TraceID；删除任职记录时日志保留被删记录的完整快照。
 */
import { insertAuditEvent, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { employmentSession, EMP_TODAY } from './AC-EMP-support.js';
import { auditApi, SOURCE_HEADERS } from './AC-AUD-support.js';

const testDb = useTestDb();
const NOW = `${EMP_TODAY}T01:00:00.000Z`;

async function hiredWorld(label: string) {
  const { db } = testDb();
  const session = await employmentSession(db, label);
  const departmentA = await session.org('合成部门甲', { establishedOn: '2026-01-01' });
  const departmentB = await session.org('合成部门乙', { establishedOn: '2026-01-01' });
  const employee = await session.employee('审计员工');
  const hire = await session.business(
    employee.id,
    { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { departmentId: departmentA.id } },
    employee.revision,
  );
  const as = { user: session.user.id, tenant: session.tenant.id };
  return { db, session, departmentA, departmentB, employee, hire, as, audit: auditApi(db, NOW) };
}

describe('AC-AUD-01 编辑员工部门：字段级数据变更日志', () => {
  it('日志出现「部门:从【A】修改为【B】」，含操作人、时间、IP、来源页面、终端与 TraceID', async () => {
    const w = await hiredWorld('aud01-edit');
    const edited = await w.session.request('PATCH', `/records/${w.hire.id}`, {
      ifMatch: w.hire.revision,
      body: { fields: { departmentId: w.departmentB.id } },
      headers: SOURCE_HEADERS,
    });
    expect(edited.status, await edited.clone().text()).toBe(200);

    const { items } = await w.audit.dataChanges(w.as, {
      objectType: 'employment-record',
      objectId: w.hire.id,
      operation: 'update',
    });
    expect(items).toHaveLength(1);
    const log = items[0]!;
    expect(log).toMatchObject({
      operation: 'update',
      operationLabel: '编辑',
      app: '组织员工',
      objectType: 'employment-record',
      objectLabel: '任职记录',
      objectId: w.hire.id,
      occurredAt: NOW,
      operator: { userId: w.session.user.id, name: w.session.user.displayName },
      ip: '203.0.113.7',
      terminal: SOURCE_HEADERS['user-agent'],
      clientVersion: '2026.10.1',
      sourcePage: '员工档案/任职记录',
      sourcePageType: '表单页',
      sourceAction: '编辑',
      traceId: 'trace-aud-01',
    });
    expect(log.content).toContain('部门:从【合成部门甲】修改为【合成部门乙】');
    expect(log.changes).toContainEqual(
      expect.objectContaining({
        field: 'departmentId',
        label: '部门',
        from: w.departmentA.id,
        to: w.departmentB.id,
        fromText: '合成部门甲',
        toText: '合成部门乙',
      }),
    );
    // 未改动的字段不进变更内容
    expect(log.changes.map((change) => change.field)).not.toContain('place');
  });

  it('按字段筛选；没有来源请求头时来源列为空，TraceID 由服务端生成并回写响应头', async () => {
    const w = await hiredWorld('aud01-filter');
    const edited = await w.session.request('PATCH', `/records/${w.hire.id}`, {
      ifMatch: w.hire.revision,
      body: { fields: { place: '合成新地点' } },
    });
    expect(edited.status).toBe(200);
    const traceId = edited.headers.get('x-trace-id');
    expect(traceId).toMatch(/^[0-9a-f-]{36}$/);

    const byPlace = await w.audit.dataChanges(w.as, { objectId: w.hire.id, field: 'place' });
    expect(byPlace.items).toHaveLength(1);
    expect(byPlace.items[0]).toMatchObject({ sourcePage: null, ip: null, traceId });
    expect(byPlace.items[0]!.content).toBe('工作地点:从【】修改为【合成新地点】');
    const byDepartment = await w.audit.dataChanges(w.as, { objectId: w.hire.id, field: 'departmentId' });
    expect(byDepartment.items.filter((item) => item.operation === 'update')).toEqual([]);
  });

  it('组织与员工信息的新增同样进入数据变更日志（DEC-019 覆盖组织员工）', async () => {
    const w = await hiredWorld('aud01-coverage');
    const organizations = await w.audit.dataChanges(w.as, { objectId: w.departmentA.id });
    expect(organizations.items).toContainEqual(
      expect.objectContaining({ operation: 'create', objectType: 'organization', objectLabel: '组织单元' }),
    );
    const employees = await w.audit.dataChanges(w.as, { objectId: w.employee.id, operation: 'create' });
    expect(employees.items).toContainEqual(
      expect.objectContaining({ objectType: 'employment_employee', objectLabel: '员工信息' }),
    );
  });
});

describe('AC-AUD-02 删除任职记录：日志保留被删记录快照', () => {
  it('删除一条有效任职记录后，数据变更日志有「删除」记录，详情带完整快照', async () => {
    const w = await hiredWorld('aud02-delete');
    const transfer = await w.session.business(
      w.employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-20',
        fields: { departmentId: w.departmentB.id, place: '待删地点' },
      },
      w.hire.employeeRevision,
    );
    const deleted = await w.session.request('DELETE', `/businesses/${transfer.id}`, { ifMatch: transfer.revision });
    expect(deleted.status, await deleted.clone().text()).toBe(200);

    const { items } = await w.audit.dataChanges(w.as, { objectId: transfer.id, operation: 'delete' });
    const recordLog = items.find((item) => item.objectType === 'employment-record');
    expect(recordLog).toMatchObject({ operationLabel: '删除', objectLabel: '任职记录' });
    const detail = await w.audit.dataChange(w.as, recordLog!.id);
    expect(detail.snapshot).toMatchObject({
      id: transfer.id,
      employeeId: w.employee.id,
      startDate: '2026-09-20',
      departmentId: w.departmentB.id,
      place: '待删地点',
    });
    expect(detail.after).toBeNull();
    // 删除记录的变更内容逐字段写出被删值（新值为空）
    expect(recordLog!.content).toContain('工作地点:从【待删地点】修改为【】');
  });
});

describe('P2-5 引用名称按审计时点（租户时区）取有效版本，同日多版本取最新', () => {
  it('同日改名两次、次日再改名：编辑任职时冻结的是审计当天最后一个版本的名称', async () => {
    const w = await hiredWorld('aud01-same-day-name');
    const api = auditApi(w.db, NOW).api;
    const as = { user: w.session.user.id, tenant: w.session.tenant.id };
    let revision = w.departmentB.revision;
    for (const [name, effectiveDate] of [
      ['旧部门名', '2026-10-01'],
      ['新部门名', '2026-10-01'],
      ['明日部门名', '2026-10-02'],
    ] as const) {
      const renamed = await api.request('PATCH', `/api/tenant/org/organizations/${w.departmentB.id}`, {
        ...as,
        ifMatch: revision,
        body: { name, effectiveDate },
      });
      expect(renamed.status, await renamed.clone().text()).toBe(200);
      revision = ((await renamed.json()) as { revision: number }).revision;
    }
    const edited = await w.session.request('PATCH', `/records/${w.hire.id}`, {
      ifMatch: w.hire.revision,
      body: { fields: { departmentId: w.departmentB.id } },
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    const { items } = await w.audit.dataChanges(w.as, { objectId: w.hire.id, action: 'employment.record.edit' });
    expect(items[0]!.content).toContain('部门:从【合成部门甲】修改为【新部门名】');
  });
});

describe('P2-4 对象 UUID 大小写不影响写入与查询', () => {
  it('统一入口写入大写对象 ID 时按小写保存；大写、小写查询结果一致；非 UUID 复合标识保持原样', async () => {
    const w = await hiredWorld('aud01-uuid-case');
    const upper = w.hire.id.toUpperCase();
    await withTenant(w.db, w.session.tenant.id, (tx) =>
      insertAuditEvent(tx, {
        tenantId: w.session.tenant.id,
        actorUserId: w.session.user.id,
        action: 'employment.record.edit',
        objectType: 'employment-record',
        objectId: upper,
        before: { place: '大写前' },
        after: { place: '大写后' },
        occurredAt: new Date(NOW),
      }),
    );
    const lower = await w.audit.dataChanges(w.as, { objectId: w.hire.id, field: 'place' });
    const shouted = await w.audit.dataChanges(w.as, { objectId: upper, field: 'place' });
    expect(lower.items.map((item) => item.id)).toEqual(shouted.items.map((item) => item.id));
    expect(lower.items).toContainEqual(expect.objectContaining({ objectId: w.hire.id }));
    await withTenant(w.db, w.session.tenant.id, (tx) =>
      insertAuditEvent(tx, {
        tenantId: w.session.tenant.id,
        actorUserId: w.session.user.id,
        action: 'license_seat.release',
        objectType: 'license_seat',
        objectId: 'PA:AbC',
        before: { seat: 1 },
        after: null,
      }),
    );
    const composite = await withTenant(w.db, w.session.tenant.id, (tx) =>
      tx.execute(sql`SELECT object_id FROM audit_events WHERE action='license_seat.release'`),
    );
    expect(JSON.stringify(composite)).toContain('PA:AbC');
  });
});
