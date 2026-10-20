/**
 * FE-R2d3 实习四视图与实习转正 / 结束实习表单（差距表 B34～B41，补证 R2d / R2f1，DEC-593）：前端纯契约。
 * 页面交互另见 apps/web/smoke/AC-FE-R2d3.smoke.spec.ts。
 */
import { describe, expect, it } from 'vitest';
import { MENU_ROUTES } from '../../apps/web/src/foundation/routes.js';
import type { ObjectPermission } from '../../apps/web/src/foundation/permission-model.js';
import { m } from '../../apps/web/src/intern/messages.js';
import {
  acceptBusiness,
  allowedFilters,
  cellValue,
  columns,
  confirmationOf,
  editableFields,
  entriesFor,
  formFields,
  listPath,
  openingValues,
  terminateOpening,
  regularizeBody,
  terminateBody,
  validateRegularize,
  views,
} from '../../apps/web/src/intern/model.js';

const employeeId = '30000000-0000-4000-8000-000000000001';
const applicationId = '70000000-0000-4000-8000-000000000001';
const permission = (buttons: string[], operations = { create: true, update: true }): ObjectPermission => ({
  objectCode: 'TenantBase.EmploymentRecord',
  dataOperations: operations,
  viewableFields: ['effectiveDate', 'departmentId', 'positionId', 'directManagerId'],
  editableFields: ['effectiveDate', 'departmentId', 'directManagerId'],
  buttons: buttons.map((buttonCode) => ({ buttonCode, level: 'detail' })),
});
const all = permission([
  'Employment.Create',
  'Employment.Dimission',
  'Employment.Submit',
  'Employment.Withdraw',
  'Employment.Revoke',
]);

describe('AC-FE-R2d3 实习生入口与四视图', () => {
  it('任职管理下登记唯一“实习生”入口（F-125 自注册）', () => {
    expect(MENU_ROUTES.filter((route) => route.id === 'interns')).toMatchObject([
      { app: 'transfer', label: '实习生', objectCode: 'TenantBase.EmploymentRecord', path: '/interns' },
    ]);
  });

  it('B34～B37 四视图原样交服务端 view，默认每页 30', () => {
    expect(views.map((item) => [item.key, item.label])).toEqual([
      ['interning', '实习中'],
      ['converting', '实习转正中'],
      ['converted', '已转正'],
      ['left', '已离职'],
    ]);
    for (const { key } of views) {
      const query = new URL(listPath(key, 2), 'https://example.com').searchParams;
      expect([query.get('view'), query.get('page'), query.get('pageSize')]).toEqual([key, '2', '30']);
    }
  });

  it('不可见的筛选字段不进请求（关键字须姓名 + 工号可见，部门须部门可见）', () => {
    const filters = { keyword: '合成', departmentId: '60000000-0000-4000-8000-000000000001' };
    expect(allowedFilters(filters, (key) => key === 'departmentId')).toEqual({ departmentId: filters.departmentId });
    expect(allowedFilters({ keyword: '' }, () => true)).toEqual({});
    const query = new URL(listPath('interning', 1, filters), 'https://example.com').searchParams;
    expect([query.get('keyword'), query.get('departmentId')]).toEqual([filters.keyword, filters.departmentId]);
  });

  it('被裁剪的字段显示占位，不拿别的字段拼值；状态、试用期按后端形状取', () => {
    expect(cellValue({ id: 'r' }, 'name')).toBe('--');
    expect(cellValue({ id: 'r', state: 'in_review' }, 'state')).toBe('审批中');
    expect(cellValue({ id: 'r', employeeStatus: 2 }, 'employeeStatus')).toBe('试用');
    const probation = { startDate: '2026-10-16', months: 1, endDate: '2026-11-15' };
    expect(
      ['probationStartDate', 'probationMonths', 'probationEndDate'].map((key) =>
        cellValue({ id: 'r', probation }, key),
      ),
    ).toEqual(['2026-10-16', '1', '2026-11-15']);
    expect(cellValue({ id: 'r', probation: null }, 'probationMonths')).toBe('--');
    expect(columns.converted).toContain('probationEndDate');
    expect(columns.left).toContain('lastWorkDate');
  });
});

describe('AC-FE-R2d3 详情三个入口按服务端视图、状态与权限快照显示（B41）', () => {
  const interning = { id: 'record', employeeId, revision: 1 };
  const converting = { id: applicationId, employeeId, revision: 3, state: 'in_review' };

  it('实习中：实习转正 / 结束实习', () => {
    expect(entriesFor('interning', interning, all)).toEqual(['regularize', 'terminate']);
  });
  it('DEC-647：任何视图、任何权限组合都不出“实习转正申请”入口（F-285 后补）', () => {
    for (const { key } of views)
      for (const row of [interning, converting]) expect(entriesFor(key, row, all) as string[]).not.toContain('apply');
  });
  it('实习转正中：可直接转正、结束实习，审批中的申请可撤回 / 撤销，不能再发起申请', () => {
    expect(entriesFor('converting', converting, all)).toEqual(['regularize', 'terminate', 'withdraw', 'revoke']);
    expect(entriesFor('converting', { ...converting, state: 'approved' }, all)).toEqual(['regularize', 'terminate']);
  });
  it('已转正、已离职、无按钮、无新增操作、员工 id 被裁剪：不显示入口', () => {
    expect(entriesFor('converted', interning, all)).toEqual([]);
    expect(entriesFor('left', interning, all)).toEqual([]);
    expect(entriesFor('interning', interning, permission([]))).toEqual([]);
    expect(
      entriesFor('interning', interning, permission(['Employment.Create'], { create: false, update: true })),
    ).toEqual([]);
    expect(entriesFor('interning', { id: 'record' }, all)).toEqual([]);
    expect(entriesFor('interning', interning, undefined)).toEqual([]);
  });
  it('结束实习只看离职直接办理按钮（Employment.Dimission）', () => {
    expect(entriesFor('interning', interning, permission(['Employment.Dimission']))).toEqual(['terminate']);
  });
});

describe('AC-FE-R2d3 请求体与本地校验（补证 R2f1 五区）', () => {
  const values = {
    effectiveDate: '2026-10-16',
    departmentId: 'dept',
    positionId: null,
    directManagerId: 'manager',
    dottedManagerId: '',
    probation: true,
    probationMonths: 1,
    probationEndDate: '2026-11-15',
  };
  it('直接转正：严格体，空的可选项不发，合同 / 工号 / 入职日期不出现', () => {
    expect(regularizeBody(values)).toEqual({
      effectiveDate: '2026-10-16',
      departmentId: 'dept',
      directManagerId: 'manager',
      probation: true,
      probationMonths: 1,
      probationEndDate: '2026-11-15',
    });
    expect(regularizeBody({ ...values, probation: false })).toEqual({
      effectiveDate: '2026-10-16',
      departmentId: 'dept',
      directManagerId: 'manager',
      probation: false,
    });
  });
  it('结束实习：只有实习结束日期；离职同步取消待入职默认关、只在打开时发送', () => {
    expect(terminateBody({ endDate: '2026-10-31', cancelPendingEntry: false })).toEqual({ endDate: '2026-10-31' });
    expect(terminateBody({ endDate: '2026-10-31', cancelPendingEntry: true })).toEqual({
      endDate: '2026-10-31',
      cancelPendingEntry: true,
    });
  });
  it('可写字段：任职字段按字段权限，试用期控制项随新增操作；必填缺失或无写权时提交前拒绝', () => {
    const editable = editableFields(formFields, all);
    expect(editable).toEqual([
      'effectiveDate',
      'departmentId',
      'directManagerId',
      'probation',
      'probationMonths',
      'probationEndDate',
    ]);
    expect(() => validateRegularize({ ...values, probationEndDate: null }, editable)).toThrow('预计试用结束日期');
    expect(() => validateRegularize(values, ['effectiveDate'])).toThrow(m.denied);
    expect(() => validateRegularize(values, editable)).not.toThrow();
  });
});

describe('AC-FE-R2d3 回执与二次确认按真实接口形状', () => {
  it('新建类回执：同一员工、同一业务类型，员工 revision 须大于实际提交的 revision', () => {
    const receipt = { id: 'b', employeeId, kind: 'intern_regularization', revision: 1, employeeRevision: 6 };
    expect(acceptBusiness(receipt, { employeeId, kind: 'intern_regularization', sent: 5 })).toBe(receipt);
    expect(() => acceptBusiness(receipt, { employeeId, kind: 'intern_regularization', sent: 6 })).toThrow();
    expect(() =>
      acceptBusiness({ ...receipt, kind: 'leave' }, { employeeId, kind: 'intern_regularization', sent: 5 }),
    ).toThrow();
    expect(() =>
      acceptBusiness({ ...receipt, employeeId: 'other' }, { employeeId, kind: 'intern_regularization', sent: 5 }),
    ).toThrow();
  });
  it('单据命令回执：单据 id 相同、单据 revision 大于提交的 revision', () => {
    const receipt = { id: applicationId, employeeId, kind: 'intern_regularization', revision: 4 };
    const expected = { employeeId, kind: 'intern_regularization', sent: 3, id: applicationId };
    expect(acceptBusiness(receipt, expected)).toBe(receipt);
    expect(() => acceptBusiness({ ...receipt, revision: 3 }, expected)).toThrow();
    expect(() => acceptBusiness({ ...receipt, id: 'other' }, expected)).toThrow();
  });
  it('CONFIRMATION_REQUIRED → confirmed；有审批通过的待入职时显示取消待入职开关；离职令牌 → pendingTransferAck', () => {
    const conflict = (details: object) => ({ status: 409, message: '已超出设定编制，确认后继续保存', details });
    expect(
      confirmationOf(conflict({ reason: 'CONFIRMATION_REQUIRED', warnings: [{ reason: 'ESTABLISHMENT_EXCEEDED' }] })),
    ).toEqual({ message: '已超出设定编制，确认后继续保存', extra: { confirmed: true }, pendingEntry: false });
    const pending = conflict({ reason: 'CONFIRMATION_REQUIRED', warnings: [{ state: 'approved' }], hiddenCount: 0 });
    expect(confirmationOf(pending)?.pendingEntry).toBe(true);
    expect(
      confirmationOf(conflict({ reason: 'EXIT_PENDING_TRANSFER_ACK_REQUIRED', ackToken: 'token' }))?.extra,
    ).toEqual({ pendingTransferAck: 'token' });
    expect(confirmationOf(conflict({ reason: 'NOT_INTERN' }))).toBeUndefined();
    expect(confirmationOf({ status: 400, details: { reason: 'CONFIRMATION_REQUIRED' } })).toBeUndefined();
  });
});

describe('AC-FE-R2d3 打开基线与 409 重读同源（第 1 轮 P2-1）', () => {
  it('部门 / 职位 / 汇报关系取当前主职任职投影，转正日期为空，直接转正默认有试用期', () => {
    const record = { fields: { departmentId: 'dept', positionId: 'pos', directManagerId: 'mgr', levelId: 'lv' } };
    expect(openingValues(record)).toEqual({
      effectiveDate: null,
      departmentId: 'dept',
      positionId: 'pos',
      directManagerId: 'mgr',
      dottedManagerId: null,
      probation: true,
      probationMonths: null,
      probationEndDate: null,
    });
  });
  it('字段被裁剪（缺键）或没有当前任职：投影为空，不拿列表行或别的字段补值', () => {
    expect(openingValues({ fields: {} })).toMatchObject({ departmentId: null, directManagerId: null });
    expect(openingValues()).toMatchObject({ departmentId: null });
    expect(terminateOpening()).toEqual({ endDate: null, cancelPendingEntry: false });
  });
});
