import { describe, expect, it } from 'vitest';
import { value, columnKeys, listQuery, width } from '../../apps/web/src/contracts/model.js';

describe('AC-FE-R2a-05 按字段展示原值与枚举', () => {
  it.each(['code', 'name', 'number', 'employeeId', 'companyId', 'typeId', 'initiatorId', 'rootContractId'])(
    '%s 与枚举重名也保留原值',
    (key) => {
      for (const input of ['fixed', 'task', 'valid', 'approved', 'renew']) expect(value(input, key)).toBe(input);
    },
  );
  it.each(['orgIds', 'personIds', 'skipTypeIds', 'postExitTypeIds', 'indefiniteTypeIds', 'renewalTypeIds'])(
    '%s 的数组元素保留原值',
    (key) => expect(value(['fixed', 'task'], key)).toBe('fixed、task'),
  );
  it.each([
    ['termType', 'fixed', '固定期限'],
    ['termType', 'task', '以完成一定任务为期限'],
    ['status', 'valid', '有效'],
    ['status', 'in_review', '审批中'],
    ['status', 'approved', '已批准未生效'],
    ['status', 'effective', '生效'],
    ['status', 'returned', '已驳回'],
    ['approvalStatus', 'approved', '已批准未生效'],
    ['operation', 'renew', '续签'],
    ['termType', 'valid', 'valid'],
    ['status', 'fixed', 'fixed'],
    ['approvalStatus', 'renew', 'renew'],
    ['operation', 'approved', 'approved'],
    ['status', 'unknown', 'unknown'],
  ])('%s 仅翻译本字段枚举 %s', (key, input, expected) => expect(value(input, key)).toBe(expected));
  it('空值、数字、布尔值保持原展示约定', () => {
    for (const input of [null, undefined, '', [], {}]) expect(value(input, 'number')).toBe('--');
    expect(value(0, 'signingCount')).toBe('0');
    expect(value(false, 'autoRenew')).toBe('否');
  });
});

describe('AC-FE-R2a-06 入职缺失人员筛选', () => {
  // F-127b：入职缺失改由后端筛选（applicableQuery），原合成数据过滤改为核对只发该视图认的参数。
  it('保留人员字段，人员、姓名、组织、类型可组合；其余筛选与非姓名排序不发送', () => {
    expect(
      listQuery('missing', {
        employeeId: 'employee',
        keyword: '合成甲',
        orgId: 'org',
        includeChildren: 'true',
        typeId: 'type-a',
        companyId: 'company',
        status: 'valid',
        effectiveFrom: '2027-01-01',
        sort: 'name',
        order: 'desc',
      }),
    ).toEqual({
      employeeId: 'employee',
      keyword: '合成甲',
      orgId: 'org',
      includeChildren: 'true',
      typeId: 'type-a',
      sort: 'name',
      order: 'desc',
    });
    expect(listQuery('missing', { sort: 'endDate', order: 'desc' })).toEqual({});
  });
  it('全部视图保留电子协议签署记录列及取证宽度', () => {
    expect(columnKeys('all')).toContain('signatureRecords');
    expect(width('signatureRecords', 'all')).toBe(179);
  });
});
