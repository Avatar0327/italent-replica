import { describe, expect, it } from 'vitest';
import { retireBody } from './model.js';
import { acceptRehire, rehireApplicationAccess, rehireBlockers } from './rehire-model.js';
import { retirementEditFields, retirementPatch } from './RetirementEdit.js';

describe('AC-FE-R2c3c 退休同时返聘', () => {
  const input = {
    lastWorkDate: '2026-10-25',
    reEmployed: true,
    rehireEmployType: 'internal',
    rehireRemarks: '合成返聘计划',
  };

  it('退休专用创建请求携带返聘计划，服务端决定返聘日', () => {
    expect(retireBody(input, 'direct', undefined)).toEqual({
      mode: 'direct',
      lastWorkDate: '2026-10-25',
      reEmployed: true,
      rehire: { fields: { employType: 'internal', remarks: '合成返聘计划' } },
    });
  });

  it('取消同时返聘后，旧返聘输入不进入普通退休请求', () => {
    expect(retireBody({ ...input, reEmployed: false }, 'application', undefined)).toEqual({
      mode: 'application',
      lastWorkDate: '2026-10-25',
    });
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
