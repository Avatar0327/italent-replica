import { describe, expect, it } from 'vitest';
import type { ObjectPermission } from '../foundation/permission-model.js';
import { projectFields } from '../foundation/forms/values.js';
import { acceptCreateReceipt, canCreatePerson, createAccess, createBody, validateCreate } from './create-model.js';

const employeeId = '30000000-0000-4000-8000-000000000001';
const businessId = '70000000-0000-4000-8000-000000000001';
const values = {
  name: '合成实习生',
  code: 'SYN-INTERN',
  loginEmail: 'intern@example.com',
  effectiveDate: '2026-10-12',
  departmentId: '60000000-0000-4000-8000-000000000001',
  companyId: '61000000-0000-4000-8000-000000000001',
  typeId: '61000000-0000-4000-8000-000000000002',
  endDate: '2027-10-11',
  idType: 'id_card',
  idNumber: 'SYNTHETIC-CERT',
};
const selected = { candidate: { employeeId, endKind: 'leave' as const }, revision: 25 };
const receipt = {
  id: businessId,
  businessId,
  employeeId,
  revision: 1,
  kind: 'rehire',
  view: 'interning',
  contract: {
    stage: 'formal',
    id: '61000000-0000-4000-8000-000000000003',
    startDate: values.effectiveDate,
    endDate: values.endDate,
    companyId: values.companyId,
  },
};
const permission: ObjectPermission = {
  objectCode: 'TenantBase.Employee',
  dataOperations: { create: true },
  viewableFields: Object.keys(values).concat('employType'),
  editableFields: Object.keys(values).concat('employType'),
  buttons: [
    { buttonCode: 'Employee.Create', level: 'detail' },
    { buttonCode: 'Employment.Create', level: 'detail' },
    { buttonCode: 'create', level: 'list' },
  ],
};

describe('AC-FE-R2d4 B38 / A48 实际新增契约', () => {
  it('新业务版本独立于候选员工版本，不把 1 小于 If-Match 25 误判为未知', () => {
    expect(acceptCreateReceipt(receipt, createBody(values, selected, false), 25)).toEqual(receipt);
  });
  it.each([
    { id: employeeId },
    { employeeId: businessId },
    { revision: NaN },
    { kind: 'retire_rehire' },
    { view: 'converting' },
    { contract: { ...receipt.contract, endDate: null } },
    { contract: { ...receipt.contract, companyId: null } },
    { contract: { ...receipt.contract, id: null } },
    { contract: { ...receipt.contract, stage: 'pending' } },
  ])('错对象、错类型或合同不一致的回执必须保守锁定：%j', (bad) => {
    expect(() => acceptCreateReceipt({ ...receipt, ...bad }, createBody(values, selected, false), 25)).toThrow();
  });
  it('接受服务端 pendingEntry 归属与临时合同形状，不靠客户端日期重算', () => {
    const pending = { ...receipt, view: 'pendingEntry', contract: { ...receipt.contract, id: null, stage: 'pending' } };
    expect(acceptCreateReceipt(pending, createBody(values, selected, true), 25).view).toBe('pendingEntry');
  });
  it('人员无创建按钮、明细未加载或 create=false 时入口默认隐藏', () => {
    expect(canCreatePerson()).toBe(false);
    expect(canCreatePerson({ ...permission, buttons: [] })).toBe(false);
    expect(canCreatePerson({ ...permission, dataOperations: { create: false } })).toBe(false);
    expect(canCreatePerson(permission)).toBe(true);
  });
  it('只读和裁剪字段不进入保存，缺失必填字段编辑权时不可保存', () => {
    const readonly = { ...permission, editableFields: permission.editableFields.filter((k) => k !== 'endDate') };
    const access = createAccess(permission, permission, readonly);
    const editable = Object.keys(values).filter((key) => access.field(key).editable);
    const draft = projectFields(values, editable);
    expect(createBody(draft, undefined, false).contract).not.toHaveProperty('endDate');
    expect(() => validateCreate(draft, editable, false, false)).toThrow();
    expect(createAccess(permission, undefined, permission).allowed).toBe(false);
  });
  it('未来日期丢弃正式合同草稿字段，证件仅用于匹配，重聘不创建第二个人员', () => {
    const body = createBody({ ...values, termType: 'fixed', termMonths: 12 }, selected, true);
    expect(body.contract).toEqual({ companyId: values.companyId, endDate: values.endDate });
    expect(body).toMatchObject({ kind: 'rehire', employeeId, fields: { employType: 'intern' } });
    for (const key of ['idType', 'idNumber', 'name', 'code']) expect(body).not.toHaveProperty(key);
  });
  it.each([undefined, '', '2026-10-11', '2026-10-12'])('合同终止日缺失或不晚于开始日 %s 被阻止', (endDate) => {
    expect(() => validateCreate({ ...values, endDate }, Object.keys(values), false, false)).toThrow();
  });
});
