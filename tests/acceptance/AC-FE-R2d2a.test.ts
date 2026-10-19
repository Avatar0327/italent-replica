import { describe, expect, it } from 'vitest';
import { newCommand } from '../../apps/web/src/foundation/client.js';
import {
  directBody,
  directValues,
  recordReceipt,
  batchReceipt,
  validateDirect,
  validateBatch,
  errorLines,
} from '../../apps/web/src/part-time/direct-model.js';

const row = {
  id: 'record-a',
  employeeId: 'employee-a',
  revision: 3,
  kind: 'part_time',
  serviceType: 'part_time',
  effectiveDate: '2026-10-01',
  endDate: '2026-10-31',
  fields: { departmentId: 'department-a', directManagerId: 'manager-a' },
};
describe('AC-FE-R2d2a 直接维护契约', () => {
  it('新增字段映射到真实 DTO，负责人和下属永不发送', () => {
    expect(directBody({ ...directValues(row), isDepartmentHead: true, addedSubordinateIds: ['person'] }, true)).toEqual(
      {
        partTimeType: 'part_time',
        startDate: '2026-10-01',
        endDate: '2026-10-31',
        fields: { departmentId: 'department-a', directManagerId: 'manager-a' },
      },
    );
  });
  it('租户自定义字段按 custom:id 投影，false 不丢失且只发送显式字段', () => {
    expect(directValues({ customFields: { a: false, b: 0 } })).toMatchObject({ 'custom:a': false, 'custom:b': 0 });
    expect(directBody({ 'custom:a': false, 'custom:b': null }, false)).toEqual({ customFields: { a: false, b: null } });
  });
  it('编辑不发送任职类型、开始日、员工和未给出的字段', () => {
    expect(
      directBody({ departmentId: 'department-b', effectiveDate: '2020-01-01', serviceType: 'secondment' }, false),
    ).toEqual({ fields: { departmentId: 'department-b' } });
  });
  it('新增缺必填、结束早于开始、编辑清空已有结束日均在发送前拒绝', () => {
    expect(() => validateDirect({}, true, {})).toThrow();
    expect(() => validateDirect({ ...directValues(row), endDate: '2026-09-30' }, true, {})).toThrow('结束日期');
    expect(() => validateDirect({ endDate: null }, false, directValues(row))).toThrow('清空');
    expect(() => validateDirect({ departmentId: 'department-b' }, false, directValues(row))).not.toThrow();
  });
  it('编辑回执按实际命令 revision 校验，允许后端无变化回执', () => {
    const command = newCommand({}, 5);
    expect(() => recordReceipt({ ...row, revision: 4 }, row.id, command)).toThrow();
    expect(recordReceipt({ ...row, revision: 5 }, row.id, command).id).toBe(row.id);
    expect(() => recordReceipt({ ...row, id: 'other', revision: 6 }, row.id, command)).toThrow();
    expect(() => recordReceipt({ record: row }, row.id, command)).toThrow();
  });
  it('批量成功必须逐条对应 ID 和提交版本，不能用 total 冒充确认', () => {
    const items = [{ recordId: row.id, revision: 3 }];
    const receipt = { total: 1, succeeded: 1, failed: 0, batchId: 'batch-a', items: [{ ...row, revision: 4 }] };
    expect(batchReceipt(receipt, items).length).toBe(1);
    // trimEmploymentResponse 不把 batchId 作为协议元数据保留；有字段权配置时它可以缺席。
    expect(batchReceipt({ ...receipt, batchId: undefined }, items).length).toBe(1);
    expect(() => batchReceipt({ ...receipt, items: [row] }, items)).toThrow();
    expect(() => batchReceipt({ ...receipt, items: [{ ...row, id: 'other', revision: 4 }] }, items)).toThrow();
    expect(() => batchReceipt({ ...receipt, items: [] }, items)).toThrow();
  });
  it('批量 1～200 条，版本和结束日不可缺少', () => {
    expect(() => validateBatch([], '2026-10-20')).toThrow();
    expect(() =>
      validateBatch(
        Array.from({ length: 201 }, (_, i) => ({ ...row, id: String(i) })),
        '2026-10-20',
      ),
    ).toThrow();
    expect(() => validateBatch([{ ...row, revision: undefined }], '2026-10-20')).toThrow();
    expect(() => validateBatch([row], null)).toThrow();
    expect(() => validateBatch([row], '2026-10-20')).not.toThrow();
  });
  it('错误明细逐条显示版本与中文原因，隐藏条目只显示件数', () => {
    expect(errorLines({ items: [{ recordId: row.id, expected: 3, actual: 4 }], hiddenCount: 2 })).toEqual([
      'record-a：版本 3 → 4',
      '另有 2 条记录不可见',
    ]);
    expect(errorLines({ items: [{ recordId: row.id, reason: 'PART_TIME_END_BEFORE_START' }] })[0]).toContain(
      '结束日期不能早于开始日期',
    );
  });
});
