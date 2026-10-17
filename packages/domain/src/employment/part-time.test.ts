/**
 * BE-7 PT-2 兼职纯函数（docs/08_设计/R2-T05_兼职设计.md §1.2 / §4.3 D-5 / §4.3A / §4.6 / §4.7 / §6.1，PB-06）：
 * 区间、任职状态、视图归属、外派借调唯一、主职周期边界、离职 / 调动的结束日。SQL 镜像的逐点等价见 AC-PT-span-sql。
 */
import { describe, expect, it } from 'vitest';
import {
  exclusivePartTimeConflict,
  inPartTimeView,
  isEmptyPartTimeSpan,
  isPartTimeCurrent,
  PART_TIME_EXPIRING_DAYS,
  PART_TIME_RECORD_VIEWS,
  partTimeBoundaryViolation,
  partTimeCutoffEnd,
  partTimeExitEndDate,
  partTimeServiceStatus,
  partTimeTransferEndDate,
  partTimeViews,
  type PartTimeBoundaryInput,
} from './part-time.js';

const span = (startDate: string, endDate: string | null) => ({ startDate, endDate });

describe('PB-06 任职状态与视图归属（§1.2 / §6.1）', () => {
  const closed = span('2026-10-10', '2026-10-20');

  it.each([
    ['开始日前一天', '2026-10-09', 'serving', false, ['not_started', 'all']],
    ['开始日', '2026-10-10', 'serving', true, ['ongoing', 'expiring', 'all']],
    ['结束日', '2026-10-20', 'serving', true, ['ongoing', 'expiring', 'all']],
    ['结束日次日', '2026-10-21', 'ended', false, ['ended', 'all']],
  ] as const)('有结束日：%s', (_label, today, status, current, views) => {
    expect(partTimeServiceStatus(closed, today)).toBe(status);
    expect(isPartTimeCurrent(closed, today)).toBe(current);
    expect(partTimeViews(closed, today)).toEqual(views);
  });

  it('空区间（end = start − 1）任何一天都是“任职结束”、只在已结束视图', () => {
    const empty = span('2026-10-20', '2026-10-19');
    expect(isEmptyPartTimeSpan(empty)).toBe(true);
    for (const today of ['2026-10-01', '2026-10-19', '2026-10-20', '2026-11-01']) {
      expect(partTimeServiceStatus(empty, today)).toBe('ended');
      expect(isPartTimeCurrent(empty, today)).toBe(false);
      expect(partTimeViews(empty, today)).toEqual(['ended', 'all']);
    }
  });

  it('无结束日：开始后一直兼职中，不进即将到期；未来开始仍“任职中”（W-612）', () => {
    const open = span('2026-10-10', null);
    expect(isEmptyPartTimeSpan(open)).toBe(false);
    expect(partTimeServiceStatus(open, '2026-10-01')).toBe('serving');
    expect(partTimeViews(open, '2026-10-01')).toEqual(['not_started', 'all']);
    expect(partTimeViews(open, '2099-12-31')).toEqual(['ongoing', 'all']);
  });

  it('当天开始当天结束：兼职中且即将到期（W-613）；结束日 10-31 在 11-01 起任职结束（AC-PT-03）', () => {
    expect(partTimeViews(span('2026-10-01', '2026-10-01'), '2026-10-01')).toEqual(['ongoing', 'expiring', 'all']);
    const october = span('2026-10-01', '2026-10-31');
    expect(partTimeServiceStatus(october, '2026-10-31')).toBe('serving');
    expect(partTimeServiceStatus(october, '2026-11-01')).toBe('ended');
  });

  it('即将到期取 [today, today + days]，默认 30 天，含第 30 天、不含第 31 天', () => {
    expect(PART_TIME_EXPIRING_DAYS).toEqual({ default: 30, min: 1, max: 365 });
    expect(inPartTimeView('expiring', span('2026-09-01', '2026-10-31'), '2026-10-01')).toBe(true);
    expect(inPartTimeView('expiring', span('2026-09-01', '2026-11-01'), '2026-10-01')).toBe(false);
    expect(inPartTimeView('expiring', span('2026-09-01', '2026-11-01'), '2026-10-01', 31)).toBe(true);
    // 未开始的不算即将到期（即将到期 ⊂ 兼职中）
    expect(inPartTimeView('expiring', span('2026-10-05', '2026-10-06'), '2026-10-01')).toBe(false);
  });

  it('视图之间：除“全部”外，兼职中 / 未开始 / 已结束两两互斥且覆盖全部记录', () => {
    expect(PART_TIME_RECORD_VIEWS).toEqual(['ongoing', 'expiring', 'not_started', 'ended', 'all']);
    const spans = [span('2026-10-01', null), span('2026-10-05', '2026-10-04'), span('2026-09-01', '2026-09-30')];
    for (const s of spans)
      for (const today of ['2026-09-30', '2026-10-01', '2026-10-04', '2026-10-05']) {
        const hits = (['ongoing', 'not_started', 'ended'] as const).filter((v) => inPartTimeView(v, s, today));
        expect(hits).toHaveLength(1);
        expect(hits[0] === 'ended').toBe(partTimeServiceStatus(s, today) === 'ended');
      }
  });
});

describe('D-5 外派 / 借调唯一（§4.3，W-616，A-7）', () => {
  const today = '2026-10-01';
  const expatriate = { serviceType: 'expatriate', ...span('2026-09-01', null) };

  it('已有未结束外派：再新增外派或借调冲突，新增普通兼职不冲突', () => {
    expect(exclusivePartTimeConflict({ serviceType: 'expatriate', records: [expatriate], pending: [], today })).toBe(
      true,
    );
    expect(exclusivePartTimeConflict({ serviceType: 'secondment', records: [expatriate], pending: [], today })).toBe(
      true,
    );
    expect(exclusivePartTimeConflict({ serviceType: 'part_time', records: [expatriate], pending: [], today })).toBe(
      false,
    );
  });

  it('未开始的外派也算未结束；已结束（结束日早于今天）或空区间的不算', () => {
    const future = { serviceType: 'secondment', ...span('2026-12-01', null) };
    const ended = { serviceType: 'expatriate', ...span('2026-01-01', '2026-09-30') };
    const empty = { serviceType: 'expatriate', ...span('2026-12-01', '2026-11-30') };
    const input = (records: (typeof future)[]) => ({ serviceType: 'expatriate', records, pending: [], today });
    expect(exclusivePartTimeConflict(input([future]))).toBe(true);
    expect(exclusivePartTimeConflict(input([ended, empty]))).toBe(false);
  });

  it('普通兼职记录不占用唯一性；在途的外派 / 借调新增申请占用（复刻从严）', () => {
    const plain = { serviceType: 'part_time', ...span('2026-09-01', null) };
    expect(exclusivePartTimeConflict({ serviceType: 'expatriate', records: [plain], pending: [], today })).toBe(false);
    expect(exclusivePartTimeConflict({ serviceType: 'expatriate', records: [], pending: ['part_time'], today })).toBe(
      false,
    );
    expect(exclusivePartTimeConflict({ serviceType: 'expatriate', records: [], pending: ['secondment'], today })).toBe(
      true,
    );
  });
});

describe('§4.3A 主职周期边界 partTimeBoundaryViolation', () => {
  const primary = { staffId: 'staff-1', kind: 'hire', employeeStatus: 3 };
  const base: PartTimeBoundaryInput = {
    ...span('2026-10-01', null),
    primary,
    exitEffectiveDate: null,
    pendingExitPlannedDate: null,
  };
  const check = (input: Partial<PartTimeBoundaryInput>) => partTimeBoundaryViolation({ ...base, ...input });
  const ok = { violation: null, warnings: [] };

  it('B-1：开始日主职须在职（试用 / 正式 / 非正式），否则 PART_TIME_PRIMARY_NOT_ACTIVE', () => {
    for (const employeeStatus of [2, 3, 12]) expect(check({ primary: { ...primary, employeeStatus } })).toEqual(ok);
    const notActive = { violation: { reason: 'PART_TIME_PRIMARY_NOT_ACTIVE' }, warnings: [] };
    for (const employeeStatus of [1, 4, 5, 6, 8])
      expect(check({ primary: { ...primary, employeeStatus } })).toEqual(notActive);
    expect(check({ primary: null })).toEqual(notActive);
    expect(check({ primary: { ...primary, kind: 'leave' } })).toEqual(notActive);
    expect(check({ primary: { ...primary, kind: 'retirement' } })).toEqual(notActive);
    // 已有兼职记录：开始日主职须仍是记录所属周期
    expect(check({ recordStaffId: 'staff-1' })).toEqual(ok);
    expect(check({ recordStaffId: 'staff-0' })).toEqual(notActive);
  });

  it('B-2（PB-58）：已生效离职 E = 10-16（L = 10-15）时结束日必须非空且 ≤ L', () => {
    const exited = { exitEffectiveDate: '2026-10-16' };
    const beyond = { violation: { reason: 'PART_TIME_BEYOND_EXIT', lastWorkDate: '2026-10-15' }, warnings: [] };
    expect(check({ ...exited, endDate: null })).toEqual(beyond);
    expect(check({ ...exited, endDate: '2026-10-20' })).toEqual(beyond);
    expect(check({ ...exited, endDate: '2026-10-16' })).toEqual(beyond);
    expect(check({ ...exited, endDate: '2026-10-15' })).toEqual(ok);
  });

  it('B-3 / B-4（PB-22）：未落地离职 Lp = 10-15；开始日晚于 Lp 拒绝，区间跨过 Lp 只提示', () => {
    const pending = { pendingExitPlannedDate: '2026-10-16' };
    expect(check({ ...pending, startDate: '2026-10-16' })).toEqual({
      violation: { reason: 'PART_TIME_AFTER_EXIT', lastWorkDate: '2026-10-15' },
      warnings: [],
    });
    const spans = { violation: null, warnings: ['PART_TIME_SPANS_PENDING_EXIT'] };
    expect(check({ ...pending, startDate: '2026-10-07', endDate: null })).toEqual(spans);
    expect(check({ ...pending, startDate: '2026-10-07', endDate: '2026-10-16' })).toEqual(spans);
    expect(check({ ...pending, startDate: '2026-10-07', endDate: '2026-10-15' })).toEqual(ok);
    expect(check({ ...pending, startDate: '2026-10-15', endDate: '2026-10-15' })).toEqual(ok);
  });

  it('规则次序：主职不在职先于离职边界；已生效边界先于未落地提示', () => {
    expect(check({ primary: null, exitEffectiveDate: '2026-10-16' }).violation?.reason).toBe(
      'PART_TIME_PRIMARY_NOT_ACTIVE',
    );
    expect(check({ exitEffectiveDate: '2026-10-16', pendingExitPlannedDate: '2026-10-11' })).toEqual({
      violation: { reason: 'PART_TIME_BEYOND_EXIT', lastWorkDate: '2026-10-15' },
      warnings: [],
    });
  });
});

describe('离职 / 调动结束兼职（§4.6 / §4.7，S3～S7）', () => {
  it('结束日 = 实际生效日 − 1（含跨月、跨年）', () => {
    expect(partTimeTransferEndDate('2026-10-13')).toBe('2026-10-12');
    expect(partTimeExitEndDate('2026-11-01')).toBe('2026-10-31');
    expect(partTimeExitEndDate('2027-01-01')).toBe('2026-12-31');
  });

  it('系统缩短：已在截止日前结束不追加；开始晚于截止日写空区间；否则结束于截止日', () => {
    expect(partTimeCutoffEnd(span('2026-09-01', '2026-10-05'), '2026-10-12')).toBeNull();
    expect(partTimeCutoffEnd(span('2026-09-01', '2026-10-12'), '2026-10-12')).toBeNull();
    expect(partTimeCutoffEnd(span('2026-10-20', null), '2026-10-12')).toBe('2026-10-19');
    expect(partTimeCutoffEnd(span('2026-09-01', null), '2026-10-12')).toBe('2026-10-12');
    expect(partTimeCutoffEnd(span('2026-10-10', '2026-10-31'), '2026-10-15')).toBe('2026-10-15');
    expect(partTimeCutoffEnd(span('2026-10-12', null), '2026-10-12')).toBe('2026-10-12');
    // 已是空区间：不再追加
    expect(partTimeCutoffEnd(span('2026-10-20', '2026-10-19'), '2026-10-12')).toBeNull();
  });
});
