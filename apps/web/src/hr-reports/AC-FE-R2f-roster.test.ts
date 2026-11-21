import { describe, expect, it } from 'vitest';
import { ApiError } from '../foundation/client.js';
import { errorText, reportOf, reportUrl, rosterFilters, rosterResultFilters, validRosterFilters } from './model.js';

describe('AC-FE-R2f-11 名册的机器错误码与中文反馈', () => {
  it('响应体过大时提示缩小筛选范围', () => {
    const failure = new ApiError(413, 'PAYLOAD_TOO_LARGE', 'unknown', 'ZZ_FER2F_服务端消息');
    expect(errorText(failure)).toBe('请求内容过大，请缩小筛选范围');
  });

  it('超限必须同时命中状态、错误码与原因', () => {
    const details = { details: { reason: 'EXPORT_ROW_LIMIT' } };
    const failure = new ApiError(422, 'VALIDATION_FAILED', 'fields', 'ZZ_FER2F_服务端消息', details);
    expect(errorText(failure, true)).toBe('导出最多 10000 行，请缩小筛选范围');
    expect(errorText(new ApiError(400, 'VALIDATION_FAILED', 'fields', '', details), true)).toBe(
      '请检查筛选条件和日期范围',
    );
    expect(errorText(new ApiError(422, 'REQUEST_FAILED', 'fields', '', details), true)).toBe('导出失败，请重试');
    expect(errorText(new ApiError(422, 'VALIDATION_FAILED', 'fields', ''), true)).toBe('导出失败，请重试');
  });
});

describe('AC-FE-R2f-06 名册筛选与回执上下文', () => {
  const report = reportOf('roster')!;
  const filters = {
    asOf: '2025-07-01',
    name: 'ZZ_FER2F_甲',
    workDateFrom: '2000-02-29',
    workDateTo: '2020-12-31',
    employeeStatus: '2',
  };
  const result = {
    asOf: '2025-08-01',
    columns: [
      { key: 'employeeName', label: '姓名' },
      { key: 'employeeStatus', label: '人员状态' },
      { key: 'workDate', label: '参加工作日期' },
    ],
  };

  it('使用回执时点与已应用筛选供分页和导出，导出物跨全页', () => {
    const applied = rosterResultFilters(filters, result)!;
    const params = (path: string) => Object.fromEntries(new URL(path, 'http://synthetic.invalid').searchParams);
    expect(params(reportUrl(report, applied, 2))).toEqual({ ...filters, asOf: result.asOf, page: '2', pageSize: '20' });
    expect(params(reportUrl(report, applied, undefined, true))).toEqual({ ...filters, asOf: result.asOf });
  });

  it('撤列清理相应筛选，拒绝导出仍带撤销条件的结果', () => {
    const columns = [{ key: 'backupMail', label: '个人邮箱' }, ...result.columns.slice(0, 2)];
    expect(rosterFilters({ ...filters, email: 'zz_fer2f@example.com', employType: 'intern' }, columns)).toEqual({
      asOf: filters.asOf,
      name: filters.name,
      employeeStatus: '2',
    });
    expect(rosterResultFilters(filters, { ...result, columns })).toBeUndefined();
  });

  it('接受合法历史/未来时点，拒绝无效日期、反序、名册外状态', () => {
    expect(validRosterFilters({ ...filters, asOf: '0001-01-01' })).toBe(true);
    expect(validRosterFilters({ ...filters, asOf: '9999-12-31' })).toBe(true);
    for (const asOf of ['0000-01-01', '2025-02-29', '2025-02-30', '2025-13-01', '2025-2-01'])
      expect(validRosterFilters({ ...filters, asOf }), asOf).toBe(false);
    expect(validRosterFilters({ ...filters, workDateTo: '1999-01-01' })).toBe(false);
    expect(validRosterFilters({ ...filters, employeeStatus: '8' })).toBe(false);
  });
});
