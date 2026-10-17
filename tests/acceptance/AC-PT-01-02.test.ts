/**
 * AC-PT-01 / AC-PT-02（docs/08_设计/R2-T05_兼职设计.md §4.3 D-5 / D-6，§9 PB-17～19；PT-3a 服务层，HTTP 版随 PT-3b）：
 * 外派 / 借调同时只能有一条未结束（W-616，在途新增申请也占用，A-7）；普通兼职不做重叠 / 重复校验（W-614）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { serviceWorld } from './AC-PT-service-support.js';

const database = useTestDb();
const MESSAGE = '该人员还有未结束的借调/外派/返聘记录，不能再新增';

describe('AC-PT-01 外派 / 借调唯一（D-5）', () => {
  it.each(['expatriate', 'secondment'] as const)(
    'PB-18：已有未结束外派再新增 %s → 409 PART_TIME_EXCLUSIVE_TYPE_EXISTS（原文提示），无写入',
    async (second) => {
      const w = await serviceWorld(database().db, `pt01-${second}`);
      await w.create({ serviceType: 'expatriate', startDate: '2026-09-01', endDate: null });
      const before = await w.writes();
      const error = await w.rejection({ serviceType: second, startDate: '2026-09-10' });
      expect(error.code).toBe('CONFLICT');
      expect(w.reason(error)).toBe('PART_TIME_EXCLUSIVE_TYPE_EXISTS');
      expect(error.message).toBe(MESSAGE);
      expect(await w.writes()).toEqual(before);
    },
  );

  it('PB-18：已有外派再新增普通兼职成功（只限外派 / 借调互斥）', async () => {
    const w = await serviceWorld(database().db, 'pt01-plain');
    await w.create({ serviceType: 'expatriate', endDate: null });
    const created = await w.create({ serviceType: 'part_time', startDate: '2026-09-05' });
    expect(created).toMatchObject({ serviceType: 'part_time', startDate: '2026-09-05', endDate: null });
  });

  it('PB-19：外派已结束（结束日 < 今天）再新增外派成功；结束日 = 今天仍是任职中，仍被拒绝', async () => {
    const w = await serviceWorld(database().db, 'pt01-ended');
    await w.create({ serviceType: 'expatriate', startDate: '2026-08-01', endDate: '2026-09-30' });
    const again = await w.create({ serviceType: 'expatriate', startDate: '2026-10-01', endDate: '2026-10-01' });
    expect(again.serviceType).toBe('expatriate');
    // 刚创建的外派结束日 = 今天（2026-10-01），次日才结束
    expect(w.reason(await w.rejection({ serviceType: 'secondment', startDate: '2026-10-01' }))).toBe(
      'PART_TIME_EXCLUSIVE_TYPE_EXISTS',
    );
  });

  it.each([
    ['draft', true],
    ['in_review', true],
    ['rejected', true],
    ['voided', false],
    ['effective', false],
    ['deleted', false],
  ] as const)('A-7：同员工的外派新增申请处于 %s 时%s占用名额', async (state, blocks) => {
    const w = await serviceWorld(database().db, `pt01-request-${state}`);
    const effectiveRecordId = state === 'effective' ? await w.seedPartTime({ endDate: null }) : undefined;
    await w.seedRequest({ serviceType: 'expatriate', state, effectiveRecordId });
    if (blocks) {
      expect(w.reason(await w.rejection({ serviceType: 'expatriate' }))).toBe('PART_TIME_EXCLUSIVE_TYPE_EXISTS');
    } else {
      expect((await w.create({ serviceType: 'expatriate' })).serviceType).toBe('expatriate');
    }
  });

  it('延长 / 结束申请不占用新增名额（只有新增申请计入）', async () => {
    const w = await serviceWorld(database().db, 'pt01-extend-request');
    const record = await w.seedPartTime({ serviceType: 'expatriate', startDate: '2026-08-01', endDate: '2026-09-20' });
    await w.seedRequest({ requestType: 'extend', recordId: record, serviceType: 'expatriate', state: 'in_review' });
    expect((await w.create({ serviceType: 'expatriate', startDate: '2026-10-01' })).serviceType).toBe('expatriate');
  });
});

describe('AC-PT-02 普通兼职不做重叠 / 重复校验（D-6，W-614）', () => {
  it('PB-17：同员工、同部门、时间重叠的两条普通兼职都成功，期限链各自第 1 期', async () => {
    const w = await serviceWorld(database().db, 'pt02-overlap');
    const first = await w.create({ serviceType: 'part_time', startDate: '2026-09-01', endDate: '2026-12-31' });
    const second = await w.create({ serviceType: 'part_time', startDate: '2026-09-15', endDate: '2026-11-30' });
    expect(first.id).not.toBe(second.id);
    expect(await w.terms(first.id)).toEqual([
      { term_no: 1, end_date: '2026-12-31', source: 'create', source_id: null },
    ]);
    expect(await w.terms(second.id)).toEqual([
      { term_no: 1, end_date: '2026-11-30', source: 'create', source_id: null },
    ]);
  });
});
