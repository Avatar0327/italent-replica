import { describe, expect, it } from 'vitest';
import { value, columnKeys, width } from '../../apps/web/src/contracts/model.js';
import { previewContracts } from '../../apps/web/src/demo-stubs/contracts.js';

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
  it('保留人员字段，支持姓名、人员、类型组合；未匹配为空', () => {
    expect(previewContracts({ employeeId: '合成甲' }, 'missing').map((row) => row.id)).toEqual(['demo-contract-a']);
    expect(
      previewContracts({ name: '合成甲', employeeId: '合成甲', typeId: ['demo-labor'] }, 'missing')[0]?.employeeId,
    ).toBe('合成甲');
    expect(previewContracts({ employeeId: '不存在' }, 'missing')).toEqual([]);
  });
  it('全部视图保留电子协议签署记录列及取证宽度', () => {
    expect(columnKeys('all')).toContain('signatureRecords');
    expect(width('signatureRecords', 'all')).toBe(179);
  });
});
