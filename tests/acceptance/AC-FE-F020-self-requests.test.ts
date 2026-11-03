/// <reference lib="dom" />
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const model = await import(resolve('apps/web/src/self-service/pages/model.ts'));
const form = {
  employee: { id: 'self', name: '合成本人', revision: 7 },
  dataOperations: { create: false, update: true },
  fieldModes: { lastWorkDate: 'readonly', reasonCode: 'readonly' },
  updateFieldModes: { lastWorkDate: 'editable', reasonCode: 'readonly' },
  values: { reasonCode: 'personal' },
};
describe('AC-FE-F020 本人申请字段与协议', () => {
  it('两个入口只按对应的 detail 按钮显示', () => {
    const buttons = [{ buttonCode: 'Exit.Self', level: 'detail' }];
    expect(model.selfRequestAllowed?.(buttons, 'exit')).toBe(true);
    expect(model.selfRequestAllowed?.(buttons, 'partTime')).toBe(false);
    expect(model.selfRequestAllowed?.([{ buttonCode: 'Exit.Self', level: 'list' }], 'exit')).toBe(false);
  });
  it('DEC-798 修改态使用 updateFieldModes，新建不能借修改权编辑', () => {
    expect(model.selfRequestAccess?.(form, false)).toMatchObject({
      editableFields: [],
      viewableFields: ['lastWorkDate', 'reasonCode'],
    });
    expect(model.selfRequestAccess?.(form, true)).toMatchObject({ editableFields: ['lastWorkDate'] });
    expect(model.selfRequestAccess?.({ ...form, updateFieldModes: { lastWorkDate: 'readonly' } }, true)).toMatchObject({
      editableFields: [],
      viewableFields: ['lastWorkDate'],
    });
  });
  it('隐藏与只读字段不补回载荷，离职去向可清空', () => {
    expect(
      model.selfRequestBody?.(
        'exit',
        { lastWorkDate: '2026-12-01', reasonCode: 'family', whereaboutsCode: null, employeeId: 'other' },
        ['lastWorkDate', 'whereaboutsCode'],
      ),
    ).toEqual({ lastWorkDate: '2026-12-01', whereaboutsCode: '' });
    expect(
      model.selfRequestBody?.(
        'partTime',
        { serviceType: 'part_time', effectiveDate: '2026-12-01', postId: 'hidden', departmentId: 'dept' },
        ['serviceType', 'effectiveDate', 'departmentId'],
      ),
    ).toEqual({ partTimeType: 'part_time', startDate: '2026-12-01', fields: { departmentId: 'dept' } });
  });
  it('离职默认个人原因仅取服务端可见默认值，已有单不重新补默认值', () => {
    expect(model.selfRequestValues?.('exit', form.values)).toMatchObject({ reasonCode: 'personal' });
    expect(model.selfRequestValues?.('exit', {})).toMatchObject({ reasonCode: undefined });
    expect(
      model.selfRequestValues?.('partTime', {
        serviceType: 'secondment',
        effectiveDate: '2026-12-01',
        fields: { departmentId: 'dept' },
      }),
    ).toMatchObject({ serviceType: 'secondment', effectiveDate: '2026-12-01', departmentId: 'dept' });
  });
  it('离职必填和兼职三项必填、非法日期与结束日期边界有明确错误', () => {
    expect(model.selfRequestErrors?.('exit', {})).toEqual(['lastWorkDate']);
    expect(model.selfRequestErrors?.('partTime', {})).toEqual(['serviceType', 'effectiveDate', 'departmentId']);
    expect(model.selfRequestErrors?.('exit', { lastWorkDate: '2026-02-30' })).toEqual(['lastWorkDate']);
    expect(
      model.selfRequestErrors?.('partTime', {
        serviceType: 'expatriate',
        effectiveDate: '2026-12-01',
        departmentId: 'dept',
        endDate: '2026-11-30',
      }),
    ).toEqual(['endDate']);
    expect(model.selfRequestErrors?.('exit', { lastWorkDate: '2026-12-01' })).toEqual([]);
  });
  it('回执按真实协议校验，创建单据版本不与员工版本混用', () => {
    const receipt = { id: 'draft', employeeId: 'self', revision: 1, status: 'draft', kind: 'exit', fields: {} };
    expect(model.acceptSelfRequest?.(receipt, 'self', 7)).toEqual(receipt);
    expect(() => model.acceptSelfRequest?.({ ...receipt, revision: 8 }, 'self', 8, 'draft')).toThrow();
    expect(() => model.acceptSelfRequest?.({ ...receipt, employeeId: 'other' }, 'self', 7)).toThrow();
    expect(model.acceptSelfRequest?.({ ...receipt, revision: 9 }, 'self', 8, 'draft')).toMatchObject({ revision: 9 });
  });
});
