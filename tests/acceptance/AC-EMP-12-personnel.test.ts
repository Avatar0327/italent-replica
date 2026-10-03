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
