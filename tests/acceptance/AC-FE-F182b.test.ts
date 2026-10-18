import { describe, expect, it } from 'vitest';
import { matchesFilters, ownPlans } from '../../apps/web/src/idp/model.js';
import type { PlanSummary } from '../../apps/web/src/idp/types.js';

const rows: PlanSummary[] = [
  { id: 'p-a', employeeId: 'self', tutorEmployeeId: 'tutor-a', status: 'running' },
  { id: 'p-b', employeeId: 'self', tutorEmployeeId: 'tutor-b', status: 'ended' },
  { id: 'p-null', employeeId: 'self', tutorEmployeeId: null, status: 'running' },
  { id: 'p-trimmed', employeeId: 'self', status: 'running' },
  { id: 'p-other', employeeId: 'other', tutorEmployeeId: 'tutor-a', status: 'running' },
];

describe('AC-FE-F182b 我的发展计划指导人筛选', () => {
  it('未筛选时保留本人 null / 被裁剪行，明确筛选后只保留指定指导人，清空恢复', () => {
    const mine = ownPlans(rows, 'self');
    expect(mine.filter((row) => matchesFilters(row, {})).map((row) => row.id)).toEqual([
      'p-a',
      'p-b',
      'p-null',
      'p-trimmed',
    ]);
    expect(mine.filter((row) => matchesFilters(row, { tutorEmployeeId: 'tutor-a' })).map((row) => row.id)).toEqual([
      'p-a',
    ]);
    expect(mine.filter((row) => matchesFilters(row, { tutorEmployeeId: undefined }))).toEqual(mine);
  });

  it('指导人与状态条件取交集，不扩大本人计划范围', () => {
    const filters = { tutorEmployeeId: 'tutor-b', status: 'running' as const };
    expect(ownPlans(rows, 'self').filter((row) => matchesFilters(row, filters))).toEqual([]);
    expect(ownPlans(rows).filter((row) => matchesFilters(row, {}))).toEqual([]);
  });
});
