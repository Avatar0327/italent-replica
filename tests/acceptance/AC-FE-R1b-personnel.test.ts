import { describe, expect, it } from 'vitest';
import { employeeQuery, visibleColumns, recordPeriod, displayValue } from '../../apps/web/src/personnel/model.js';

describe('AC-FE-R1b-01 员工筛选与字段可见性', () => {
  it('姓名使用后端精确筛选契约，编码与日期保留原值，不附加不支持的参数', () => {
    const query = new URLSearchParams(
      employeeQuery({ name: '合成员工', code: 'DEMO-001', entryDate: '2026-10-01' }, { page: 2, pageSize: 15 }, [
        'name',
        'code',
        'entryDate',
      ]),
    );
    expect(Object.fromEntries(query)).toEqual({
      page: '2',
      pageSize: '15',
      employeeName: '合成员工',
      code: 'DEMO-001',
      entryDate: '2026-10-01',
    });
  });
  it('未知和撤权字段不参与筛选，空字符串不变为筛选条件', () => {
    expect(
      Object.fromEntries(
        new URLSearchParams(
          employeeQuery({ name: '隐蔽', code: '', employeeStatus: '3' }, { page: 1, pageSize: 15 }, ['code']),
        ),
      ),
    ).toEqual({ page: '1', pageSize: '15' });
  });
  it('列设置与字段权限取交集；权限缺失时为空', () => {
    expect(visibleColumns(['name', 'code', 'gender'], ['name', 'gender'])).toEqual(['name', 'gender']);
    expect(visibleColumns(['name'], [])).toEqual([]);
  });
});

describe('AC-FE-R1b-02 任职日期和字段值', () => {
  it('不使用浏览器日期、不把同日短区间改写为当前，不把已生效等同当前', () => {
    // 原站任职卡片日期写“2023年8月18日”，不写 ISO（#326 第 2 轮 P2-6）
    expect(recordPeriod({ effectiveDate: '2026-10-01', stopDate: '2026-09-30' })).toBe('2026年10月1日 至 2026年9月30日');
    expect(recordPeriod({ effectiveDate: '2026-10-01', stopDate: '9999-12-31' })).toBe('2026年10月1日 至今');
    expect(recordPeriod({})).toBe('— 至 —');
  });
  it('false 和 0 不当作空值；不把未知对象串为业务文本', () => {
    expect(displayValue(false)).toBe('否');
    expect(displayValue(0)).toBe('0');
    expect(displayValue(null)).toBe('—');
    expect(displayValue({ secret: 'value' })).toBe('—');
  });
});

describe('AC-FE-R1b-06 缺失筛选契约使用独立样例', () => {
  it('组合筛选只匹配合成样例，不复用真实列表；清空恢复样例', async () => {
    const { previewFilters, filterExamples } = await import('../../apps/web/src/demo-stubs/personnel.js');
    expect(previewFilters({ gender: '女', department: '示例人事部' }).map((row) => row.id)).toEqual(['sample-c']);
    expect(previewFilters({ company: '不匹配' })).toEqual([]);
    expect(previewFilters({})).toEqual(filterExamples);
  });
});
