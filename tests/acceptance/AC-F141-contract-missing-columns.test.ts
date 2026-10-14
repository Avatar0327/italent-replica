/**
 * F-141 ⑥（DEC-500）：合同“入职缺失”视图的行是人员，不是合同。人员列（姓名、邮箱、工号、入职日期、部门、职位、职务）
 * 不能被“合同对象字段清单”过滤掉；其他视图仍按合同对象的可见字段裁剪。
 */
import { describe, expect, it } from 'vitest';
import { columnKeys, visibleColumnKeys } from '../../apps/web/src/contracts/model.js';

describe('AC-F141-contract-missing-columns 入职缺失人员列（DEC-500⑥）', () => {
  it('入职缺失：合同对象可见字段为空，人员列也照常显示', () => {
    expect(visibleColumnKeys('missing', [], false)).toEqual(columnKeys('missing'));
    expect(visibleColumnKeys('missing', ['number'], false)).toEqual(columnKeys('missing'));
  });

  it('其他视图仍按合同对象可见字段裁剪；演示数据不裁剪', () => {
    expect(visibleColumnKeys('valid', [], false)).toEqual([]);
    expect(visibleColumnKeys('valid', ['name', 'number'], false)).toEqual(['name', 'number']);
    expect(visibleColumnKeys('all', ['status'], false)).toEqual(['status']);
    expect(visibleColumnKeys('valid', [], true)).toEqual(columnKeys('valid'));
  });
});
