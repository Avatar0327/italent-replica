import { executableButtons, MODULE_OBJECTS, ObjectCatalog, resolveObjectPermission } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { retireBody } from './model.js';
import { planFields } from './RehirePlan.js';
import { retirementObjectGrant } from './retirement-permission.test-support.js';
import { acceptRehire, rehireApplicationAccess, rehireBlockers } from './rehire-model.js';
import { retirementEditFields, retirementPatch } from './RetirementEdit.js';

describe('AC-FE-R2c3c 退休同时返聘', () => {
  const input = {
    lastWorkDate: '2026-10-25',
    reEmployed: true,
    rehireEmployType: 'internal',
    rehireRemarks: '合成返聘计划',
    rehireProbation: true,
    rehireProbationMonths: 3,
    rehireProbationEndDate: '2027-01-26',
  };

  it('退休专用创建请求携带返聘计划，服务端决定返聘日', () => {
    expect(retireBody(input, 'direct', undefined)).toEqual({
      mode: 'direct',
      lastWorkDate: '2026-10-25',
      reEmployed: true,
      rehire: {
        fields: { employType: 'internal', remarks: '合成返聘计划' },
        entry: { probation: true, probationMonths: 3, probationEndDate: '2027-01-26' },
      },
    });
  });

  it('取消同时返聘后，旧返聘输入不进入普通退休请求', () => {
    expect(retireBody({ ...input, reEmployed: false }, 'application', undefined)).toEqual({
      mode: 'application',
      lastWorkDate: '2026-10-25',
    });
  });
});

describe('AC-FE-R2c3c r2 真实目录下的返聘计划权限', () => {
  const definition = MODULE_OBJECTS.employmentRecord;
  const catalog = new ObjectCatalog([definition]);
  const grant = retirementObjectGrant(definition);

  function permission(input: typeof grant) {
    const objectCode = definition.code;
    const resolved = resolveObjectPermission(
      objectCode,
      [{ objectCode, profileApps: [definition.application], ...input }],
      catalog,
    )!;
    const { dataOperations, viewableFields, editableFields } = resolved.effective;
    return {
      objectCode,
      dataOperations,
      viewableFields: [...viewableFields],
      editableFields: [...editableFields],
      buttons: executableButtons(resolved.definition, resolved.effective),
    };
  }

  it('允许创建时，试用期控制项可用且普通任职字段仍按字段编辑权', () => {
    const input = permission({
      ...grant,
      fields: grant.fields.map((field) => (field.fieldCode === 'remarks' ? { ...field, edit: false } : field)),
    });
    const systemFields = ['probation', 'probationMonths', 'probationEndDate'];
    expect(systemFields.filter((field) => input.editableFields.includes(field))).toEqual([]);
    expect(planFields(input).filter((field) => field.startsWith('rehireProbation'))).toEqual([
      'rehireProbation',
      'rehireProbationMonths',
      'rehireProbationEndDate',
    ]);
    expect(planFields(input)).not.toContain('rehireRemarks');
  });

  it('缺少对象新增、Employment.Create 或返聘标识查看权时，计划输入保持关闭', () => {
    for (const input of [
      { ...grant, dataOperations: { ...grant.dataOperations, create: false } },
      { ...grant, buttons: grant.buttons.filter((button) => button.buttonCode !== 'Employment.Create') },
      { ...grant, fields: grant.fields.filter((field) => field.fieldCode !== 'reEmployed') },
    ])
      expect(planFields(permission(input))).toEqual([]);
  });
});

describe('AC-FE-R2c3c 返聘申请权限与回执', () => {
  const fields = ['effectiveDate', 'kind', 'mode', 'handoverEmployeeId'] as const;
  const permission = {
    objectCode: 'TenantBase.EmploymentRecord',
    dataOperations: { read: true, create: true, update: false },
    viewableFields: fields,
    editableFields: fields,
    buttons: ['Employment.Create', 'Employment.Edit', 'Employment.Preview', 'Employment.RetireEdit'].map(
      (buttonCode) => ({ buttonCode, level: 'detail' }),
    ),
  };
  const result = { id: '申请单', employeeId: '员工', kind: 'retire_rehire', mode: 'application', revision: 3 };

  it('新增和改期按各自对象操作授权，预览不授写权', () => {
    expect(rehireApplicationAccess(permission)).toEqual({ preview: true, create: true, edit: false });
    expect(retirementEditFields(permission)).toEqual([]);
    const update = { ...permission, dataOperations: { read: true, update: true } };
    expect(rehireApplicationAccess(update)).toEqual({ preview: true, create: false, edit: true });
    expect(retirementEditFields(update)).toEqual(['handoverEmployeeId']);
  });

  it('改期回执必须是本员工原单且 revision 前进', () => {
    expect(acceptRehire(result, '员工', '申请单', 2)).toEqual(result);
    expect(() => acceptRehire(result, '员工', '申请单', 3)).toThrow();
    expect(() => acceptRehire(result, '另一员工', '申请单', 2)).toThrow();
    expect(() => acceptRehire(result, '员工', '另一申请', 2)).toThrow();
  });

  it('同时返聘预览优先展示真实规则原因', () => {
    expect(rehireBlockers({ blockers: [{ reason: 'RETIREMENT_REHIRE_INVALID', message: '目标部门不可用' }] })).toEqual([
      '目标部门不可用',
    ]);
    expect(rehireBlockers({ blockers: [] })).toEqual([]);
  });
});

it('AC-FE-R2c3c 退休编辑只投影修改过且可写的现有 PATCH 字段', () => {
  const values = {
    handoverEmployeeId: '合成交接人',
    lastWorkDate: '2026-10-26',
    effectiveDate: '2026-10-27',
    reEmployed: true,
    rehire: { fields: { remarks: '不要发送' } },
    dutyTransfer: { subordinates: [] },
    dutyTransferTiming: 'business_effective',
  };
  const before = { dutyTransferTiming: 'business_effective' };
  expect(retirementPatch(values, before, Object.keys(values))).toEqual({ handoverEmployeeId: '合成交接人' });
  expect(retirementPatch(values, before, ['dutyTransferTiming'])).toEqual({});
});

it('AC-EN-F538-FE-01 退休编辑仅在职责计划有编辑权且变动时提交，清空发 null', () => {
  const first = {
    subordinates: [{ employeeId: 'ZZ_F538_下属', receiverId: 'ZZ_F538_原接收人', relation: 'direct' }],
    orgRoles: [],
  };
  const next = {
    ...first,
    subordinates: first.subordinates.map((item) => ({ ...item, receiverId: 'ZZ_F538_新接收人' })),
  };
  const writable = ['dutyTransfer'];
  const baseline = { dutyTransfer: first };
  expect(retirementPatch({ dutyTransfer: next }, baseline, writable)).toEqual({ dutyTransfer: next });
  expect(retirementPatch({ dutyTransfer: null }, baseline, writable)).toEqual({ dutyTransfer: null });
  expect(retirementPatch(baseline, baseline, writable)).toEqual({});
  expect(retirementPatch({ dutyTransfer: next }, baseline, [])).toEqual({});
});
