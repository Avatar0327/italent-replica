/** DEC-788：申请入口只消费服务端资格，不用前端状态或日期重算。 */
import { describe, expect, it } from 'vitest';
import type { ObjectPermission } from '../foundation/permission-model.js';
import { entriesFor, object, type Row } from './model.js';

const permission: ObjectPermission = {
  objectCode: object,
  dataOperations: { create: true, update: true },
  buttons: ['Employment.Create', 'Employment.Submit'].map((buttonCode) => ({ buttonCode, level: 'detail' })),
  viewableFields: [],
  editableFields: [],
};
const row: Row = { id: 'record', employeeId: 'employee', revision: 1, hasProbation: true };

describe('AC-FE-F456 服务端资格决定转正申请入口', () => {
  it.each([false, undefined])('服务端未给资格 %s，即使前端看似试用也不出申请按钮', (eligible) => {
    const candidate = { ...row, employeeStatus: 2, canApplyRegularization: eligible };
    expect(entriesFor('all', candidate, permission)).not.toContain('apply');
    expect(entriesFor('expiring', candidate, permission)).not.toContain('apply');
  });
  it('服务端给资格，人员状态被字段裁剪也有申请入口；无提交权仍隐藏', () => {
    const candidate = { ...row, canApplyRegularization: true };
    expect(entriesFor('all', candidate, permission)).toContain('apply');
    expect(entriesFor('all', candidate, { ...permission, dataOperations: { create: true } })).not.toContain('apply');
  });
});
