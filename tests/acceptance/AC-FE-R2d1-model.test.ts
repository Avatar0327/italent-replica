import { describe, expect, it } from 'vitest';
import {
  allowedFilters,
  cellValue,
  columnKeys,
  columnWidth,
  listPath,
  rangeInvalid,
  views,
} from '../../apps/web/src/part-time/model.js';

describe('AC-FE-R2d1 列表只读契约', () => {
  it('首次请求显式 ongoing、30，六视图均原样交服务端', () => {
    expect(listPath()).toBe('/api/tenant/employment/part-times?view=ongoing&page=1&pageSize=30');
    for (const { key } of views) {
      const params = new URL(listPath(key, 2, {}, 7), 'https://example.com').searchParams;
      expect(params.get('view')).toBe(key);
      expect(params.get('page')).toBe('2');
      expect(params.get('days')).toBe(key === 'expiring' ? '7' : null);
      expect(params.has('sort')).toBe(false);
    }
  });
  it('只把有查看权的筛选发到接口，部门未选时不传含下级', () => {
    const filters = {
      keyword: '姓名',
      departmentId: 'dept',
      includeChildren: 'false',
      serviceType: 'part_time',
      directManagerId: 'manager',
      startFrom: '2026-01-01',
      endTo: '2026-12-31',
    };
    expect(allowedFilters(filters, (key) => key === 'serviceType')).toEqual({ serviceType: 'part_time' });
    expect(listPath('ongoing', 1, { includeChildren: 'false' })).not.toContain('includeChildren');
    const path = listPath('all', 3, filters);
    for (const [key, value] of Object.entries(filters))
      expect(new URL(path, 'https://example.com').searchParams.get(key)).toBe(value);
  });
  it('两个日期区间均校验，单边与同日有效', () => {
    expect(rangeInvalid({ startFrom: '2026-02-01', startTo: '2026-01-01' })).toBe(true);
    expect(rangeInvalid({ endFrom: '2026-02-01', endTo: '2026-01-01' })).toBe(true);
    expect(rangeInvalid({ startFrom: '2026-02-01' })).toBe(false);
    expect(rangeInvalid({ endFrom: '2026-02-01', endTo: '2026-02-01' })).toBe(false);
  });
  it('缺键保留空值，不能从日期自行推算视图；记录审批状态恒生效', () => {
    const row = { id: 'record' };
    for (const { key } of views) {
      for (const column of columnKeys(key)) {
        expect(cellValue(row, column, key)).toBe(column === 'approvalStatus' && key !== 'in_approval' ? '生效' : '--');
      }
    }
    expect(cellValue({ ...row, partTimeView: ['ongoing', 'all'] }, 'current', 'all')).toBe('是');
    expect(cellValue({ ...row, partTimeView: ['not_started', 'all'] }, 'current', 'all')).toBe('否');
  });
  it('字段来自嵌套 DTO，不用未知后补列数据冒充已确认字段', () => {
    const row = {
      id: 'record',
      employee: { name: 'add', code: 'effective' },
      fields: { positionId: 'position' },
      pendingKind: 'extend',
      institution: '机构',
      kind: 'end',
      status: 'approved',
    };
    expect(cellValue(row, 'name', 'ongoing')).toBe('add');
    expect(cellValue(row, 'code', 'ongoing')).toBe('effective');
    expect(cellValue(row, 'positionId', 'ongoing')).toBe('position');
    expect(cellValue(row, 'institution', 'ongoing')).toBe('--');
    expect(cellValue(row, 'pendingKind', 'expiring')).toBe('延长');
    expect(cellValue(row, 'kind', 'in_approval')).toBe('结束');
    expect(cellValue(row, 'approvalStatus', 'in_approval')).toBe('审批通过');
  });
  it('默认职位职级与列宽保留取证口径', () => {
    expect(columnKeys('ongoing').slice(-2)).toEqual(['positionId', 'levelId']);
    expect(columnWidth('ended', 'operation')).toBe(84);
    expect(columnWidth('ongoing', 'operation')).toBe(164);
    expect(columnWidth('expiring', 'pendingStatus')).toBe(172);
    expect(columnWidth('not_started', 'effectiveDate')).toBe(112.73);
  });
});
