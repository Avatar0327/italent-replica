import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { personnelSession } from './AC-SUB-support.js';
import { computeTenure } from '../../packages/domain/src/personnel/tenure.js';

const database = useTestDb();
describe('AC-EMP-12 / 17 §1 人员主档', () => {
  it('扩展已有员工，标准字段独立版本，排除演示/待定字段', async () => {
    const s = await personnelSession(database().db);
    const path = `/employees/${s.employee.id}`;
    expect((await s.request('GET', path)).status).toBe(200);
    const body = {
      mobilePhone: 'SYNTHETIC-001',
      birthday: '2000-10-02',
      allowToLoginIn: false,
      isRehire: true,
      rehireType: 'merge',
      expectedRetirementDate: '2060-01-01',
    };
    const changed = await s.request('PATCH', path, { ifMatch: 0, body });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ id: s.employee.id, ...body, revision: 1, age: 25 });
    expect((await s.request('PATCH', path, { ifMatch: 0, body })).status).toBe(409);
    expect((await s.request('PATCH', path, { ifMatch: 1, body: { passportNumber: 'SKIP' } })).status).toBe(400);
    const history = await s.request('GET', `${path}/history`);
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ items: [expect.objectContaining(body)] });
  });

  it('同当前值的全部历史区间累计，小数截断，当前周期隔离', () => {
    const rows = [
      { staffId: 'old', startDate: '2010-01-01', stopDate: '2020-01-01', postId: 'A', levelId: null, positionId: null },
      {
        staffId: 'current',
        startDate: '2020-01-01',
        stopDate: '2021-12-31',
        postId: 'A',
        levelId: null,
        positionId: null,
      },
      {
        staffId: 'current',
        startDate: '2021-12-31',
        stopDate: '2022-12-31',
        postId: 'B',
        levelId: null,
        positionId: null,
      },
      { staffId: 'current', startDate: '2022-12-31', stopDate: null, postId: 'A', levelId: null, positionId: null },
    ];
    expect(computeTenure(rows, '2023-07-02')).toMatchObject({
      currentJobPostInYears: '2.5',
      accumulateJobPostInYears: '2.5013',
      currentJobLevelInYears: null,
      accumulatePositionInYears: null,
    });
  });

  it('离职区间终止，未来记录不参与当前值选择，空值不当作任职属性', () => {
    expect(
      computeTenure(
        [
          {
            staffId: 'a',
            startDate: '2021-01-01',
            stopDate: '2022-01-01',
            postId: 'A',
            levelId: null,
            positionId: null,
          },
          { staffId: 'b', startDate: '2030-01-01', stopDate: null, postId: 'B', levelId: null, positionId: null },
        ],
        '2026-10-01',
      ),
    ).toMatchObject({ currentJobPostInYears: '1.0', accumulateJobPostInYears: '1.0000' });
  });
});

it('AC-EMP-12 HTTP 从真实任职版本链计算 A→B→A；主档日期从有效周期派生', async () => {
  const s = await personnelSession(database().db);
  const post = async (code: string) => {
    const r = await s.api.request('POST', '/api/tenant/job/posts', {
      ...s.as,
      ifMatch: 0,
      body: { name: code, code, startDate: '2020-01-01' },
    });
    expect(r.status, await r.clone().text()).toBe(201);
    return ((await r.json()) as { id: string }).id;
  };
  const a = await post('POST_A');
  const b = await post('POST_B');
  const hire = await s.business(
    s.employee.id,
    { kind: 'hire', mode: 'direct', effectiveDate: '2020-01-01', fields: { postId: a } },
    1,
  );
  const change = await s.business(
    s.employee.id,
    { kind: 'transfer', mode: 'direct', effectiveDate: '2021-12-31', fields: { postId: b } },
    hire.employeeRevision,
  );
  await s.business(
    s.employee.id,
    { kind: 'transfer', mode: 'direct', effectiveDate: '2022-12-31', fields: { postId: a } },
    change.employeeRevision,
  );
  const tenure = await s.request('GET', `/employees/${s.employee.id}/tenure?asOf=2023-07-02`);
  expect(tenure.status).toBe(200);
  expect(await tenure.json()).toMatchObject({ currentJobPostInYears: '2.5', accumulateJobPostInYears: '2.5013' });
  expect(await (await s.request('GET', `/employees/${s.employee.id}`)).json()).toMatchObject({
    firstEntryDate: '2020-01-01',
    latestEntryDate: '2020-01-01',
    entryDate: '2020-01-01',
  });
});

it('显示姓名派生自姓名及其他语言姓名，客户端不能覆盖派生字段', async () => {
  const s = await personnelSession(database().db);
  const path = `/employees/${s.employee.id}`;
  const r = await s.request('PATCH', path, { ifMatch: 0, body: { name: '合成人员', engName: 'Synthetic' } });
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ displayName: '合成人员（Synthetic）' });
  expect(await s.getEmployee(s.employee.id)).toMatchObject({ name: '合成人员' });
  expect((await s.request('PATCH', path, { ifMatch: 1, body: { displayName: '绕过派生' } })).status).toBe(400);
});
