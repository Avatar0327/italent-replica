// F-329（DEC-705）：员工档案按原站三类编辑入口——抬头 / 列表行「编辑人员」、子集逐条新增 / 编辑 / 删除、任职记录「编辑任职」。
// 入口按服务端对象操作 + 按钮 + 可编辑字段显示；回执按真实响应形态与本次提交的 If-Match 核对（F-123 内核）。
// 原站依据：docs/02_业务建模/17 补充「F-329 员工档案的编辑入口」。
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const { profileSections } = await import(resolve('apps/web/src/personnel/model.ts'));
const edit = await import(resolve('apps/web/src/personnel/edit-model.ts'));

type Permission = {
  objectCode: string;
  dataOperations: Record<string, boolean>;
  viewableFields: string[];
  editableFields: string[];
  buttons: { buttonCode: string; level: string }[];
};
const grant = (fields: string[], buttons: [string, string][], ops = ['create', 'update', 'delete']): Permission => ({
  objectCode: 'X',
  dataOperations: Object.fromEntries(ops.map((op) => [op, true])),
  viewableFields: fields,
  editableFields: fields,
  buttons: buttons.map(([buttonCode, level]) => ({ buttonCode, level })),
});
const employee = '30000000-0000-4000-8000-000000000001';
const rowId = '40000000-0000-4000-8000-000000000001';

describe('AC-FE-F329-01 日工资标准不在档案页与编辑表单（DEC-705）', () => {
  it('人员信息分区与「编辑人员」两节都不含日工资标准，也不预埋人员类别（F-323）', () => {
    const shown = profileSections.flatMap((section: { fields: string[] }) => section.fields);
    expect(shown).not.toContain('dailyWageStandard');
    const form = [...edit.personInfoFields, ...edit.personJobFields];
    expect(form).not.toContain('dailyWageStandard');
    expect(form.some((name: string) => /employmentType|staffType|category/i.test(name))).toBe(false);
  });
  it('「编辑人员」按原站分两节：员工信息与任职信息，员工信息首两项是姓名、电子邮件', () => {
    expect(edit.personInfoFields.slice(0, 2)).toEqual(['name', 'email']);
    expect(edit.personInfoFields).toEqual([
      'name',
      'email',
      'workDate',
      'idType',
      'idNumber',
      'birthday',
      'gender',
      'mobilePhone',
    ]);
    expect(edit.personJobFields).toEqual([
      'entryDate',
      'code',
      'expectedRetirementDate',
      'expectedRetirementConfirmed',
      'employeeStatus',
    ]);
  });
});

describe('AC-FE-F329-02 「编辑人员」入口按对象修改权、update 按钮与可编辑字段显示', () => {
  const fields = ['name', 'email', 'mobilePhone', 'code', 'entryDate', 'employeeStatus', 'expectedRetirementDate'];
  it('有 update 操作与详情级 update 按钮时，只返回人员对象可写且有编辑权的字段', () => {
    const editable = edit.personEditable(grant(fields, [['update', 'detail']]));
    // 工号、入职日期、人员状态不是人员对象的可写字段：即使授了编辑权也只读展示
    expect(editable).toEqual(['name', 'email', 'mobilePhone', 'expectedRetirementDate']);
  });
  it('缺对象修改权、缺按钮、按钮级别不对或没有可编辑字段时不显示', () => {
    expect(edit.personEditable(undefined)).toEqual([]);
    expect(edit.personEditable(grant(fields, [['update', 'detail']], ['create']))).toEqual([]);
    expect(edit.personEditable(grant(fields, []))).toEqual([]);
    expect(edit.personEditable(grant(fields, [['update', 'list']]))).toEqual([]);
    expect(edit.personEditable(grant(['code', 'entryDate'], [['update', 'detail']]))).toEqual([]);
    const readOnly = { ...grant(fields, [['update', 'detail']]), editableFields: [] };
    expect(edit.personEditable(readOnly)).toEqual([]);
  });
});

describe('AC-FE-F329-03 子集逐条新增 / 编辑 / 删除按服务端权限显示', () => {
  const fields = ['school', 'major', 'startDate', 'endDate', 'isHighestEducation', 'attachmentId'];
  const all = grant(fields, [
    ['create', 'list'],
    ['update', 'detail'],
    ['delete', 'detail'],
  ]);
  it('新增要 create 操作与列表级 create 按钮；编辑要 update 操作与详情级 update 按钮；附件字段不进表单', () => {
    expect(edit.subsetEditable(all, 'education', 'create')).toEqual([
      'school',
      'major',
      'startDate',
      'endDate',
      'isHighestEducation',
    ]);
    expect(edit.subsetEditable(all, 'education', 'update')).toEqual(edit.subsetEditable(all, 'education', 'create'));
    expect(edit.subsetEditable(grant(fields, [['update', 'detail']]), 'education', 'create')).toEqual([]);
    expect(edit.subsetEditable(grant(fields, [['create', 'list']]), 'education', 'update')).toEqual([]);
    expect(edit.subsetEditable(grant(fields, [['create', 'list']], ['update']), 'education', 'create')).toEqual([]);
  });
  it('本单位经历（任职同步）不能删除，同步字段只读，其余字段仍可编辑', () => {
    const job = grant(
      ['company', 'department', 'startDate', 'responsibilities'],
      [
        ['update', 'detail'],
        ['delete', 'detail'],
      ],
    );
    const synced = { id: rowId, revision: 2, isThisCompany: true };
    expect(edit.subsetEditable(job, 'jobhistory', 'update', synced)).toEqual(['responsibilities']);
    expect(edit.subsetEditable(job, 'jobhistory', 'update', { id: rowId, revision: 2 })).toEqual([
      'company',
      'department',
      'startDate',
      'responsibilities',
    ]);
    expect(edit.canDeleteSubset(job, synced)).toBe(false);
    expect(edit.canDeleteSubset(job, { id: rowId, revision: 2 })).toBe(true);
    expect(edit.canDeleteSubset(grant([], [['update', 'detail']]), { id: rowId, revision: 2 })).toBe(false);
    // 版本被裁剪（无效对象）时入口不显示，避免落到新建槽
    expect(edit.canDeleteSubset(job, { id: rowId })).toBe(false);
  });
});

describe('AC-FE-F329-04 任职记录「编辑任职」按 Employment.Edit 与字段权限显示', () => {
  const p = grant(['departmentId', 'postId', 'place', 'remarks', 'jobNumber'], [['Employment.Edit', 'detail']]);
  const record = { id: rowId, revision: 3, status: 'effective', fields: {} };
  it('只列复刻可编辑的任职字段：工号须与员工 ID 一致、生效日期另走业务，均不进表单', () => {
    expect(edit.recordEditable(p, record)).toEqual(['departmentId', 'postId', 'place', 'remarks']);
  });
  it('缺按钮、缺修改权、版本无效或记录不是生效状态时不显示', () => {
    expect(edit.recordEditable(grant(['place'], [['update', 'detail']]), record)).toEqual([]);
    expect(edit.recordEditable({ ...p, dataOperations: { update: false } }, record)).toEqual([]);
    expect(edit.recordEditable(p, { ...record, revision: undefined })).toEqual([]);
    expect(edit.recordEditable(p, { ...record, status: 'draft' })).toEqual([]);
  });
  it('请求体按后端 normalizeBusinessPatch 形态包在 fields 里', () => {
    expect(edit.recordBody({ place: '合成城市' })).toEqual({ fields: { place: '合成城市' } });
  });
});

describe('AC-FE-F329-05 回执按真实响应形态与本次 If-Match 核对', () => {
  it('人员 PATCH 回执：同一员工、版本恰好 +1；否则判结果未知', () => {
    expect(edit.personReceipt({ id: employee, revision: 3, name: '合成员工' }, { id: employee, revision: 2 })).toEqual({
      id: employee,
    });
    expect(() => edit.personReceipt({ id: employee, revision: 2 }, { id: employee, revision: 2 })).toThrow();
    expect(() => edit.personReceipt({ id: rowId, revision: 3 }, { id: employee, revision: 2 })).toThrow();
    expect(() => edit.personReceipt({ items: [] }, { id: employee, revision: 2 })).toThrow();
  });
  it('子集回执：新增 0 → 1 且带新 id；编辑 n → n+1 且同 id；删除还须 deleted=true', () => {
    expect(edit.subsetReceipt({ id: rowId, revision: 1 }, { revision: 0 })).toEqual({ id: rowId });
    expect(() => edit.subsetReceipt({ revision: 1 }, { revision: 0 })).toThrow();
    expect(edit.subsetReceipt({ id: rowId, revision: 5 }, { id: rowId, revision: 4 })).toEqual({ id: rowId });
    expect(() => edit.subsetReceipt({ id: rowId, revision: 4 }, { id: rowId, revision: 4 })).toThrow();
    expect(() => edit.subsetReceipt({ id: rowId, revision: 5 }, { id: rowId, revision: 4, deleted: true })).toThrow();
    expect(
      edit.subsetReceipt({ id: rowId, revision: 5, deleted: true }, { id: rowId, revision: 4, deleted: true }),
    ).toEqual({ id: rowId });
  });
  it('任职回执：同一记录、版本不低于提交版本（无实际变化时后端不加版本）', () => {
    expect(edit.recordReceipt({ id: rowId, employeeId: employee, revision: 4 }, { id: rowId, revision: 3 })).toEqual({
      id: rowId,
    });
    expect(edit.recordReceipt({ id: rowId, revision: 3 }, { id: rowId, revision: 3 })).toEqual({ id: rowId });
    expect(() => edit.recordReceipt({ id: rowId, revision: 2 }, { id: rowId, revision: 3 })).toThrow();
    expect(() => edit.recordReceipt({ id: employee, revision: 4 }, { id: rowId, revision: 3 })).toThrow();
  });
});
