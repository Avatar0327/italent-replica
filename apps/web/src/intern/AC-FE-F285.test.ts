import { describe, expect, it } from 'vitest';
import type { ObjectPermission } from '../foundation/permission-model.js';
import * as model from './model.js';

const permission: ObjectPermission = {
  objectCode: model.object,
  dataOperations: { create: true, update: true },
  buttons: ['Employment.Create', 'Employment.Submit'].map((buttonCode) => ({ buttonCode, level: 'detail' })),
  viewableFields: [],
  editableFields: [],
};
const row = { id: 'record', employeeId: 'employee', revision: 2, state: 'effective' };
const values = {
  effectiveDate: '2026-10-16',
  departmentId: 'department',
  probation: true,
  probationMonths: 1,
  probationEndDate: '2026-11-15',
};

describe('AC-FE-F285 申请入口与共用试用期校验', () => {
  it('仅实习中、允许状态、创建及提交权限同时具备时显示申请', () => {
    expect(model.entriesFor('interning', row, permission)).toEqual(['regularize', 'apply']);
    for (const view of ['converting', 'converted', 'left'] as const)
      expect(model.entriesFor(view, row, permission)).not.toContain('apply');
    expect(model.entriesFor('interning', { ...row, state: 'in_review' }, permission)).not.toContain('apply');
    expect(model.entriesFor('interning', { ...row, state: undefined }, permission)).not.toContain('apply');
    for (const button of ['Employment.Create', 'Employment.Submit'])
      expect(
        model.entriesFor('interning', row, {
          ...permission,
          buttons: permission.buttons.filter((item) => item.buttonCode !== button),
        }),
      ).not.toContain('apply');
    expect(
      model.entriesFor('interning', row, { ...permission, dataOperations: { create: true, update: false } }),
    ).not.toContain('apply');
  });

  it.each([0, 7, 1.5, '3'])('月数 %s 在进入提交内核前被拦截', (probationMonths) => {
    expect(() => model.validateRegularize({ ...values, probationMonths }, model.formFields)).toThrow();
  });
  it('预计结束日早于转正日被拦截，同日可接受', () => {
    expect(() => model.validateRegularize({ ...values, probationEndDate: '2026-10-15' }, model.formFields)).toThrow();
    expect(() =>
      model.validateRegularize({ ...values, probationEndDate: '2026-10-16' }, model.formFields),
    ).not.toThrow();
  });
  it('是否有试用期必填，选否时不提交残留月数或结束日', () => {
    expect(() => model.validateRegularize({ ...values, probation: undefined }, model.formFields)).toThrow();
    expect(model.regularizeBody({ ...values, probation: false })).toEqual({
      effectiveDate: values.effectiveDate,
      departmentId: values.departmentId,
      probation: false,
    });
  });
});
