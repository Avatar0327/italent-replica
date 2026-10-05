import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { runEmploymentTransition } from '../../apps/api/src/modules/employment/transitions.js';
import { employmentSession, type EmploymentBusiness, type EmploymentSession } from './AC-EMP-support.js';

const testDb = useTestDb();

async function sameDayFixture(label: string) {
  const session = await employmentSession(testDb().db, label);
  const org = await session.org('原部门', { establishedOn: '2026-01-01' });
  const nextOrg = await session.org('调入部门', { establishedOn: '2026-01-01' });
  const employee = await session.employee('同日多业务合成员工');
  const hire = await session.business(
    employee.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-09-01',
      fields: { employType: 'internal', departmentId: org.id, place: '入职地点' },
    },
    employee.revision,
  );
  return { session, org, nextOrg, employee, hire };
}

async function createdBusiness(response: Response): Promise<EmploymentBusiness> {
  expect(response.status).toBe(201);
  return (await response.json()) as EmploymentBusiness;
}

async function trusted(
  session: EmploymentSession,
  business: EmploymentBusiness,
  action: 'submit' | 'approve',
  now = '2026-10-01T01:00:00Z',
): Promise<EmploymentBusiness> {
  const result = await runEmploymentTransition(
    testDb().db,
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

describe('AC-EMP-13 DEC-108 同一任职周期同一生效日允许多条主职业务（页面、接口）', () => {
  it('已有 D 日转正时再办 D 日调动：不返回 409，按操作先后排序，D 当天当前取调动，变更前取同日转正', async () => {
    const { session, org, nextOrg, employee, hire } = await sameDayFixture('emp13-regularization-transfer');
    const regularized = await session.business(
      employee.id,
      { kind: 'regularization', mode: 'direct', effectiveDate: '2026-09-20', fields: { place: '转正地点' } },
      hire.employeeRevision,
    );
    const transferred = await createdBusiness(
      await session.request('POST', `/employees/${employee.id}/businesses`, {
        ifMatch: regularized.employeeRevision,
        body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-20', fields: { departmentId: nextOrg.id } },
      }),
    );
    // 未填写的字段继承插入点前一条（DEC-041），同日时即同日在前的转正
    expect(transferred.record).toMatchObject({
      previousRecordId: regularized.id,
      fields: { departmentId: nextOrg.id, place: '转正地点' },
      before: { fields: { departmentId: org.id, place: '转正地点' } },
    });
    const onDay = await session.records(employee.id, '2026-09-20');
    expect(onDay.map((record) => record.id)).toEqual([hire.id, regularized.id, transferred.id]);
    expect(onDay.filter((record) => record.isCurrent).map((record) => record.id)).toEqual([transferred.id]);
    // 被同日后操作覆盖的转正当天不再生效，结束日按“后一条开始日前一天”表示
    expect(onDay.find((record) => record.id === regularized.id)).toMatchObject({
      isCurrent: false,
      isLatest: false,
      stopDate: '2026-09-19',
    });
    expect(onDay.find((record) => record.id === hire.id)).toMatchObject({ stopDate: '2026-09-19' });
    expect(onDay.find((record) => record.id === transferred.id)).toMatchObject({
      isLatest: true,
      stopDate: '9999-12-31',
    });
    expect(await session.getEmployee(employee.id)).toMatchObject({ status: 'employed' });
  });

  it('同日同类型的第二条调动也允许（只有导入要求异动类型不同），当天当前取最后一次操作', async () => {
    const { session, employee, hire } = await sameDayFixture('emp13-repeated-transfer');
    const first = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-20', fields: { place: '第一次调动地点' } },
      hire.employeeRevision,
    );
    const second = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-20', fields: { remarks: '第二次调动' } },
      first.employeeRevision,
    );
    const third = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-20', fields: { place: '第三次调动地点' } },
      second.employeeRevision,
    );
    expect(second.record).toMatchObject({
      previousRecordId: first.id,
      fields: { place: '第一次调动地点', remarks: '第二次调动' },
    });
    expect(third.record).toMatchObject({ previousRecordId: second.id, fields: { remarks: '第二次调动' } });
    const records = await session.records(employee.id);
    expect(records.map((record) => record.id)).toEqual([hire.id, first.id, second.id, third.id]);
    expect(records.filter((record) => record.isCurrent).map((record) => record.id)).toEqual([third.id]);
    expect(records.filter((record) => record.isLatest).map((record) => record.id)).toEqual([third.id]);
  });

  it('同日申请审批通过后生效时排在已有同日记录之后', async () => {
    const { session, employee, hire } = await sameDayFixture('emp13-application-after-direct');
    const draft = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'application', effectiveDate: '2026-09-20', fields: { place: '申请地点' } },
      hire.employeeRevision,
    );
    const direct = await session.business(
      employee.id,
      { kind: 'regularization', mode: 'direct', effectiveDate: '2026-09-20', fields: { remarks: '直接转正' } },
      draft.employeeRevision,
    );
    const approved = await trusted(session, await trusted(session, draft, 'submit'), 'approve');
    expect(approved.status).toBe('effective');
    expect(approved.record).toMatchObject({
      previousRecordId: direct.id,
      fields: { place: '申请地点' },
      before: { fields: { remarks: '直接转正' } },
    });
    const records = await session.records(employee.id);
    expect(records.map((record) => record.id)).toEqual([hire.id, direct.id, draft.id]);
    expect(records.filter((record) => record.isCurrent).map((record) => record.id)).toEqual([draft.id]);
  });
});

describe('AC-EMP-14 DEC-108 导入同一员工同一生效日的多条主职业务', () => {
  function create(kind: string, effectiveDate: string, fields: Record<string, unknown> = {}) {
    return { operation: 'create', business: { kind, mode: 'direct', effectiveDate, fields } };
  }

  it('两条异动类型不同：导入成功并按导入顺序排序，当天当前取后导入的一条', async () => {
    const { session, employee, hire } = await sameDayFixture('emp14-distinct-kinds');
    const response = await session.request('POST', `/employees/${employee.id}/import`, {
      ifMatch: hire.employeeRevision,
      body: {
        items: [
          create('regularization', '2026-09-20', { place: '导入转正地点' }),
          create('transfer', '2026-09-20', { remarks: '导入调动' }),
        ],
      },
    });
    expect(response.status).toBe(200);
    const imported = ((await response.json()) as { items: EmploymentBusiness[] }).items;
    expect(imported.map((item) => item.kind)).toEqual(['regularization', 'transfer']);
    const records = await session.records(employee.id);
    expect(records.map((record) => record.id)).toEqual([hire.id, imported[0]!.id, imported[1]!.id]);
    expect(records.filter((record) => record.isCurrent).map((record) => record.id)).toEqual([imported[1]!.id]);
    expect(imported[1]!.record).toMatchObject({
      previousRecordId: imported[0]!.id,
      fields: { place: '导入转正地点', remarks: '导入调动' },
    });
  });

  it('两条异动类型相同：整批不落库，返回出错行与原因；导入预览同样拒绝', async () => {
    const { session, employee, hire } = await sameDayFixture('emp14-duplicate-kinds');
    const beforeRecords = await session.records(employee.id);
    const body = {
      items: [
        create('transfer', '2026-09-10', { place: '其他日期' }),
        create('transfer', '2026-09-20', { place: '第一条' }),
        create('transfer', '2026-09-20', { place: '同日同类型' }),
      ],
    };
    const rejected = await session.request('POST', `/employees/${employee.id}/import`, {
      ifMatch: hire.employeeRevision,
      body,
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      error: {
        code: 'VALIDATION_FAILED',
        details: {
          reason: 'IMPORT_SAME_DAY_TRANSITION_DUPLICATE',
          rows: [{ index: 2, duplicateOf: 1, effectiveDate: '2026-09-20', kind: 'transfer' }],
        },
      },
    });
    expect(await session.records(employee.id)).toEqual(beforeRecords);
    expect((await session.getEmployee(employee.id)).revision).toBe(hire.employeeRevision);
    const preview = await session.request('POST', `/employees/${employee.id}/import/forward-update-preview`, {
      body,
    });
    expect(preview.status).toBe(400);
    expect(await preview.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', details: { reason: 'IMPORT_SAME_DAY_TRANSITION_DUPLICATE' } },
    });
  });
});
