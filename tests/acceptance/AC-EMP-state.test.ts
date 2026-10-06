import { randomUUID } from 'node:crypto';
import type { Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { installApprovalFallbacks } from './AC-APV-support.js';
import { EMP_TODAY, employmentSession, type EmploymentBusiness, type EmploymentSession } from './AC-EMP-support.js';

const testDb = useTestDb();

async function hired(db: Db, label: string, timezone?: string) {
  const session = await employmentSession(db, label, { timezone });
  // R1-T07：提交申请须匹配已发布流程（DEC-017）；本文件只验证任职状态机，安装兜底流程。
  await installApprovalFallbacks(db, session.tenant.id, session.user.id);
  const department = await session.org('状态验收部门');
  const employee = await session.employee();
  const hire = await session.business(
    employee.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: EMP_TODAY,
      fields: { departmentId: department.id, place: '旧地点' },
    },
    employee.revision,
  );
  expect(hire).toMatchObject({ status: 'effective', record: { isCurrent: true } });
  return { session, employee, hire };
}

async function application(session: EmploymentSession, employeeId: string, effectiveDate: string) {
  const employee = await session.getEmployee(employeeId);
  return session.business(
    employeeId,
    { kind: 'transfer', mode: 'application', effectiveDate, fields: { place: '申请地点' } },
    employee.revision,
  );
}

async function submit(session: EmploymentSession, business: EmploymentBusiness) {
  const response = await session.request('POST', `/businesses/${business.id}/submit`, {
    ifMatch: business.revision,
    body: {},
  });
  expect(response.status).toBe(200);
  return (await response.json()) as EmploymentBusiness;
}

async function transition(
  db: Db,
  session: EmploymentSession,
  business: EmploymentBusiness,
  action: 'approve' | 'activate',
  now: string,
) {
  // 审批与到期操作只由未来 T07/T08 的可信服务调用，验收不增加公开审批 HTTP 接口。
  const service = await import('../../apps/api/src/modules/employment/transitions.js');
  const result = await service.runEmploymentTransition(
    db,
    {
      tenantId: session.tenant.id,
      userId: session.user.id,
      timezone: session.tenant.timezone,
      now: new Date(now),
      commandId: randomUUID(),
      expectedRevision: business.revision,
    },
    { id: business.id, action },
  );
  expect(result.status).toBe(200);
  return result.body as EmploymentBusiness;
}

describe('AC-EMP-01/11 REQ-EMP-004 申请状态与当前任职分离', () => {
  it('DEC-195 迟到审批按批准日立即生成任职，草稿与审批中不增加生效记录', async () => {
    const { db } = testDb();
    const { session, employee, hire } = await hired(db, 'emp-state-past');
    const draft = await application(session, employee.id, '2026-10-02');
    expect(draft).toMatchObject({ status: 'draft', record: null });
    expect(await session.records(employee.id)).toHaveLength(1);
    const reviewing = await submit(session, draft);
    expect(reviewing).toMatchObject({ status: 'in_review', record: null });
    expect(await session.records(employee.id)).toHaveLength(1);

    const effective = await transition(db, session, reviewing, 'approve', '2026-10-03T01:00:00Z');
    expect(effective).toMatchObject({
      status: 'effective',
      revision: reviewing.revision + 1,
      record: { effectiveDate: '2026-10-03', previousRecordId: hire.record!.id, fields: { place: '申请地点' } },
    });
    expect((await session.records(employee.id, '2026-10-02')).find((record) => record.isCurrent)?.id).toBe(hire.id);
    const records = await session.records(employee.id, '2026-10-03');
    expect(records).toHaveLength(2);
    expect(records.filter((record) => record.isCurrent)).toEqual([
      expect.objectContaining({ id: effective.record!.id }),
    ]);
  });

  it('未来审批保持approved且无任职，提前activate拒绝，到生效日才生成一次任职', async () => {
    const { db } = testDb();
    const { session, employee } = await hired(db, 'emp-state-future');
    const reviewing = await submit(session, await application(session, employee.id, '2026-10-05'));
    const approved = await transition(db, session, reviewing, 'approve', '2026-10-03T01:00:00Z');
    expect(approved).toMatchObject({ status: 'approved', record: null });
    expect(await session.records(employee.id)).toHaveLength(1);
    await expect(transition(db, session, approved, 'activate', '2026-10-04T01:00:00Z')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const stored = await session.request('GET', `/businesses/${approved.id}`);
    expect(stored.status).toBe(200);
    expect(await stored.json()).toMatchObject({ status: 'approved', revision: approved.revision, record: null });

    const effective = await transition(db, session, approved, 'activate', '2026-10-05T01:00:00Z');
    expect(effective).toMatchObject({ status: 'effective', record: { effectiveDate: '2026-10-05' } });
    expect(await session.records(employee.id, '2026-10-05')).toHaveLength(2);
  });

  it('未来直接业务保存即effective，最新记录与当前记录不同，到期视图自然切换', async () => {
    const { db } = testDb();
    const { session, employee, hire } = await hired(db, 'emp-state-direct-future');
    const future = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-10', fields: { place: '未来地点' } },
      hire.employeeRevision,
    );
    expect(future).toMatchObject({ status: 'effective', record: { isLatest: true, isCurrent: false } });
    const today = await session.records(employee.id);
    expect(today.filter((record) => record.isCurrent)).toEqual([expect.objectContaining({ id: hire.record!.id })]);
    expect(today.filter((record) => record.isLatest)).toEqual([expect.objectContaining({ id: future.record!.id })]);
    expect((await session.record(hire.record!.id)).stopDate).toBe('2026-10-09');
    const due = await session.records(employee.id, '2026-10-10');
    expect(due.filter((record) => record.isCurrent)).toEqual([expect.objectContaining({ id: future.record!.id })]);
  });

  it.each([
    ['Asia/Shanghai', 'effective', 2],
    ['UTC', 'approved', 1],
  ] as const)('UTC同一时刻审批按租户%s判定本地日期，结果为%s', async (timezone, status, count) => {
    const { db } = testDb();
    const { session, employee } = await hired(db, `emp-state-tz-${status}`, timezone);
    const reviewing = await submit(session, await application(session, employee.id, '2026-10-02'));
    const result = await transition(db, session, reviewing, 'approve', '2026-10-01T16:00:00Z');
    expect(result.status).toBe(status);
    expect(await session.records(employee.id, '2026-10-02')).toHaveLength(count);
    if (status === 'approved') expect(result.record).toBeNull();
  });

  it('审批中撤销返回draft且不生成任职，不移除已有任职', async () => {
    const { db } = testDb();
    const { session, employee, hire } = await hired(db, 'emp-state-withdraw');
    const reviewing = await submit(session, await application(session, employee.id, '2026-10-02'));
    const response = await session.request('POST', `/businesses/${reviewing.id}/withdraw`, {
      ifMatch: reviewing.revision,
      body: {},
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'draft', record: null, revision: reviewing.revision + 1 });
    expect(await session.records(employee.id)).toEqual([
      expect.objectContaining({ id: hire.record!.id, isCurrent: true }),
    ]);
  });

  it('已生效业务不能撤流程，只能删除最新任职并恢复前一条当前记录', async () => {
    const { db } = testDb();
    const { session, employee, hire } = await hired(db, 'emp-state-delete');
    session.setNow('2026-10-03T01:00:00Z');
    const latest = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-02', fields: { place: '待删除地点' } },
      hire.employeeRevision,
    );
    const withdrawn = await session.request('POST', `/businesses/${latest.id}/withdraw`, {
      ifMatch: latest.revision,
      body: {},
    });
    expect(withdrawn.status).toBe(409);
    const deleted = await session.request('DELETE', `/businesses/${latest.id}`, { ifMatch: latest.revision });
    expect(deleted.status).toBe(200);
    expect(await session.records(employee.id, '2026-10-03')).toEqual([
      expect.objectContaining({ id: hire.record!.id, isCurrent: true, isLatest: true, stopDate: '9999-12-31' }),
    ]);
  });
});
