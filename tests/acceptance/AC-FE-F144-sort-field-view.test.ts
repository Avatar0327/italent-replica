import { describe, expect, it } from 'vitest';
import { listQuery } from '../../apps/web/src/contracts/model.js';

// F-144：已选的“编号”排序在编号不可查看后不能继续发给后端（切换身份 / 权限收回后残留的草稿筛选）。
describe('AC-FE-F144 合同列表编号排序按字段查看权', () => {
  it('编号不可查看：sort=number 连同 order 不进请求参数；其他排序键照常', () => {
    const viewable = ['name', 'endDate'];
    expect(listQuery('all', { sort: 'number', order: 'desc' }, viewable)).toEqual({});
    expect(listQuery('all', { sort: 'endDate', order: 'desc' }, viewable)).toEqual({ sort: 'endDate', order: 'desc' });
  });
  it('编号可查看：sort=number 照常发送', () => {
    expect(listQuery('all', { sort: 'number', order: 'asc' }, ['number'])).toEqual({ sort: 'number', order: 'asc' });
  });
});
