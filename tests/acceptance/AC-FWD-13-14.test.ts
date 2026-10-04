import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { EmploymentBusinessInput } from '../../apps/api/src/modules/employment/types.js';
import type { EmploymentBusiness, EmploymentSession } from './AC-EMP-support.js';
import { forwardFixture, forwardJobApi, preview, type ForwardPreview } from './AC-FWD-support.js';

const testDb = useTestDb();

interface FieldChange {
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
}

interface WholeRecordSkip {
  readonly businessId: string;
  readonly staffId: string;
  readonly status: string;
  readonly effectiveDate: string;
  readonly reason: string;
  readonly fields: readonly FieldChange[];
}

type PreviewWithSkips = ForwardPreview & { readonly wholeRecordSkips: readonly WholeRecordSkip[] };

async function previewWithSkips(session: EmploymentSession, employeeId: string, input: EmploymentBusinessInput) {
  return (await preview(session, employeeId, input)) as PreviewWithSkips;
}

async function hiredManager(session: EmploymentSession, name: string): Promise<string> {
  const manager = await session.employee(name);
  await session.business(
    manager.id,
    { kind: 'hire', mode: 'direct', effectiveDate: '2026-01-01', fields: { employType: 'internal' } },
    manager.revision,
  );
  return manager.id;
}

describe('AC-FWD-13 DEC-108 后续记录按“生效日 + 同日操作先后”依次处理', () => {
  it('D 日先转正后调动、D+30 还有记录：补录 D-10 改部门，三条依次值匹配更新，不因同日多条报错', async () => {
    const { session, employee, org, nextOrg, hired } = await forwardFixture(testDb().db, 'fwd13-same-day-targets');
    const regularized = await session.business(
      employee.id,
      { kind: 'regularization', mode: 'direct', effectiveDate: '2026-09-20' },
      hired.employeeRevision,
    );
    const transferred = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-20', fields: { place: '同日调动地点' } },
      regularized.employeeRevision,
    );
    const later = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-20', fields: { remarks: 'D+30 记录' } },
      transferred.employeeRevision,
    );
    const input = {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-09-10',
      fields: { departmentId: nextOrg.id },
    } as const;
    const plan = await preview(session, employee.id, input);
    expect(plan.changes.map((change) => change.businessId)).toEqual([regularized.id, transferred.id, later.id]);
    for (const change of plan.changes) {
      expect(change.fields).toEqual([{ field: 'departmentId', before: org.id, after: nextOrg.id }]);
    }
    await session.business(employee.id, input, later.employeeRevision);
    for (const id of [regularized.id, transferred.id, later.id]) {
      expect((await session.record(id)).fields.departmentId).toBe(nextOrg.id);
    }
    expect((await session.record(transferred.id)).fields.place).toBe('同日调动地点');
  });

  it('编辑同日在前的未来记录时，同日在后的记录按时间轴顺序属于后续记录', async () => {
    const { session, employee, org, nextOrg, hired } = await forwardFixture(testDb().db, 'fwd13-edit-same-day');
    const regularized = await session.business(
      employee.id,
      { kind: 'regularization', mode: 'direct', effectiveDate: '2026-10-20' },
      hired.employeeRevision,
    );
    const transferred = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-20', fields: { place: '同日调动地点' } },
      regularized.employeeRevision,
    );
    expect((await session.record(transferred.id)).fields.departmentId).toBe(org.id);
    const previewed = await session.request('POST', `/records/${regularized.id}/forward-update-preview`, {
      body: { fields: { departmentId: nextOrg.id } },
    });
    expect(previewed.status).toBe(200);
    expect(((await previewed.json()) as ForwardPreview).changes.map((change) => change.businessId)).toEqual([
      transferred.id,
    ]);
    const current = (await (
      await session.request('GET', `/businesses/${regularized.id}`)
    ).json()) as EmploymentBusiness;
    const edited = await session.request('PATCH', `/records/${regularized.id}`, {
      ifMatch: current.revision,
      body: { fields: { departmentId: nextOrg.id } },
    });
    expect(edited.status).toBe(200);
    expect((await session.record(transferred.id)).fields).toMatchObject({
      departmentId: nextOrg.id,
      place: '同日调动地点',
    });
    expect((await session.record(hired.id)).fields.departmentId).toBe(org.id);
  });
});

describe('AC-FWD-14 DEC-120 规则②整条跳过的后续记录在预览中单独提醒', () => {
  it('照搬 W-413 数据：9-25 记录因职位不等于变动前值整条跳过，预览列出本可同步的直线经理，提交后整条不变', async () => {
    const { db } = testDb();
    const { session, employee, org, nextOrg, hired } = await forwardFixture(db, 'fwd14-rule-two-reminder');
    const jobs = forwardJobApi(db, session);
    const post = await jobs.create('posts');
    const positionB = await jobs.create('positions', { orgId: org.id, postId: post.id });
    const positionC = await jobs.create('positions', { orgId: nextOrg.id, postId: post.id });
    const managerA = await hiredManager(session, '原直线经理');
    const managerB = await hiredManager(session, '新直线经理');
    const baseline = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-02', fields: { directManagerId: managerA } },
      hired.employeeRevision,
    );
    const matching = await session.business(
      employee.id,
      { kind: 'regularization', mode: 'direct', effectiveDate: '2026-09-20' },
      baseline.employeeRevision,
    );
    const mismatched = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-25', fields: { positionId: positionB.id } },
      matching.employeeRevision,
    );
    const input = {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-09-11',
      fields: { departmentId: nextOrg.id, positionId: positionC.id, directManagerId: managerB },
    } as const;
    const plan = await previewWithSkips(session, employee.id, input);
    expect(plan.changes).toEqual([
      expect.objectContaining({
        businessId: matching.id,
        fields: [
          { field: 'departmentId', before: org.id, after: nextOrg.id },
          { field: 'positionId', before: null, after: positionC.id },
          { field: 'directManagerId', before: managerA, after: managerB },
        ],
      }),
    ]);
    expect(plan.wholeRecordSkips).toEqual([
      {
        businessId: mismatched.id,
        staffId: hired.record!.staffId,
        status: 'effective',
        effectiveDate: '2026-09-25',
        reason: 'DEPARTMENT_POSITION_MISMATCH',
        fields: [{ field: 'directManagerId', before: managerA, after: managerB }],
      },
    ]);
    await session.business(employee.id, input, mismatched.employeeRevision);
    expect((await session.record(mismatched.id)).fields).toMatchObject({
      departmentId: org.id,
      positionId: positionB.id,
      directManagerId: managerA,
    });
    expect((await session.record(matching.id)).fields).toMatchObject({
      departmentId: nextOrg.id,
      positionId: positionC.id,
      directManagerId: managerB,
    });
  });

  it('部门、职位未同时变化时不标出整条跳过；没有本可同步字段的整条跳过记录也单独列出', async () => {
    const { db } = testDb();
    const { session, employee, org, nextOrg, hired } = await forwardFixture(db, 'fwd14-no-reminder');
    const jobs = forwardJobApi(db, session);
    const post = await jobs.create('posts');
    const positionB = await jobs.create('positions', { orgId: org.id, postId: post.id });
    const positionC = await jobs.create('positions', { orgId: nextOrg.id, postId: post.id });
    const mismatched = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-25', fields: { positionId: positionB.id } },
      hired.employeeRevision,
    );
    const placeOnly = await previewWithSkips(session, employee.id, {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-09-11',
      fields: { place: '新地点' },
    });
    expect(placeOnly.wholeRecordSkips).toEqual([]);
    expect(placeOnly.changes.map((change) => change.businessId)).toEqual([mismatched.id]);
    const coupled = await previewWithSkips(session, employee.id, {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-09-11',
      fields: { departmentId: nextOrg.id, positionId: positionC.id },
    });
    expect(coupled.changes).toEqual([]);
    expect(coupled.wholeRecordSkips).toEqual([
      expect.objectContaining({ businessId: mismatched.id, reason: 'DEPARTMENT_POSITION_MISMATCH', fields: [] }),
    ]);
  });
});
