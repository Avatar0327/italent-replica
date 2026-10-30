import { describe, expect, it } from 'vitest';
import type { ObjectPermission } from '../foundation/permission-model.js';
import { DirectError } from '../part-time/direct-api.js';
import * as model from './model.js';

const buttons = [
  'Employment.Edit',
  'Employment.Create',
  'Employment.Submit',
  'Employment.Withdraw',
  'Employment.Revoke',
];
const permission: ObjectPermission = {
  objectCode: model.object,
  dataOperations: { create: true, update: true },
  buttons: buttons.map((buttonCode) => ({ buttonCode, level: 'detail' })),
  viewableFields: [],
  editableFields: [],
};
const without = (code: string): ObjectPermission => ({
  ...permission,
  buttons: permission.buttons.filter((item) => item.buttonCode !== code),
});
// 形状照 probation-views 行（probation-routes.ts）：id 为当前主职任职记录，revision 为员工 revision，控制项总在
const row: model.Row = {
  id: '40000000-0000-4000-8000-000000000001',
  employeeId: '10000000-0000-4000-8000-000000000001',
  code: 'SYN-001',
  name: '合成员工甲',
  departmentId: '20000000-0000-4000-8000-000000000001',
  employeeStatus: 2,
  revision: 4,
  hasProbation: true,
  startDate: '2026-08-01',
  months: 3,
  expectedEndDate: '2026-10-31',
  regularizationDate: null,
  regularizationBusinessId: null,
  regularizationState: null,
  regularizationMode: null,
  probationResult: null,
  assessmentId: null,
  assessmentType: null,
};
const reviewing = {
  ...row,
  regularizationState: 'in_review',
  regularizationBusinessId: 'b1',
  regularizationMode: 'application',
};

describe('AC-FE-R2c1 ① 视图、筛选与裁剪', () => {
  it('列表请求带视图、页码与每页 15 条（补证 B5），空筛选不进请求', () => {
    const query = new URL(model.listPath('regularized', 2, { keyword: '', postId: 'p1' }), 'http://x').searchParams;
    expect(Object.fromEntries(query)).toEqual({ view: 'regularized', page: '2', pageSize: '15', postId: 'p1' });
  });
  it('筛选字段不可见时不进请求；预计结束日区间是控制项', () => {
    const filters = { keyword: '甲', departmentId: 'd1', postId: 'p1', expectedEndFrom: '2026-10-01' };
    expect(model.allowedFilters(filters, (key) => key !== 'departmentId' && key !== 'keyword')).toEqual({
      postId: 'p1',
      expectedEndFrom: '2026-10-01',
    });
  });
  it('被裁剪的字段显示占位，不借用别的字段；状态与方式按字典显示', () => {
    const { name: _name, code: _code, ...trimmed } = row;
    expect(model.cellValue(trimmed, 'name')).toBe('--');
    expect(model.cellValue(trimmed, 'code')).toBe('--');
    expect(model.cellValue(reviewing, 'regularizationState')).toBe('审批中');
    expect(model.cellValue(reviewing, 'regularizationMode')).toBe('转正申请');
    expect(model.cellValue(row, 'hasProbation')).toBe('是');
  });
  it('“已转正”列序按补证 B5', () => {
    expect(model.columns.regularized).toEqual([
      'name',
      'code',
      'departmentId',
      'organizationId',
      'postId',
      'startDate',
      'regularizationDate',
      'regularizationState',
    ]);
  });
});

describe('AC-FE-R2c1 ② 入口只按视图、状态与权限显示', () => {
  it('即将到期 / 全部：编辑、转正、申请；缺按钮或数据操作即隐藏', () => {
    for (const view of ['expiring', 'all'] as const)
      expect(model.entriesFor(view, row, permission)).toEqual(['edit', 'regularize', 'apply']);
    expect(model.entriesFor('expiring', row, without('Employment.Edit'))).toEqual(['regularize', 'apply']);
    expect(model.entriesFor('expiring', row, without('Employment.Create'))).toEqual(['edit']);
    expect(model.entriesFor('expiring', row, without('Employment.Submit'))).toEqual(['edit', 'regularize']);
    expect(
      model.entriesFor('expiring', row, { ...permission, dataOperations: { create: true, update: false } }),
    ).toEqual(['regularize']);
    expect(model.entriesFor('expiring', row, undefined)).toEqual([]);
  });
  it('有转正业务或无试用期不能再转正（PB-R9）；revision 被裁剪时没有任何写入口', () => {
    expect(model.entriesFor('all', { ...row, regularizationState: 'approved' }, permission)).toEqual(['edit']);
    expect(model.entriesFor('all', { ...row, hasProbation: false }, permission)).toEqual(['edit']);
    expect(model.entriesFor('all', { ...row, revision: undefined }, permission)).toEqual([]);
  });
  it('转正审批中只给审批中申请的撤回 / 撤销；考核中只读打开考核；已转正只可编辑', () => {
    expect(model.entriesFor('in_review', reviewing, permission)).toEqual(['withdraw', 'revoke']);
    expect(model.entriesFor('in_review', reviewing, without('Employment.Revoke'))).toEqual(['withdraw']);
    expect(model.entriesFor('in_review', { ...reviewing, regularizationBusinessId: null }, permission)).toEqual([]);
    expect(model.entriesFor('assessing', { ...row, assessmentId: 'a1' }, permission)).toEqual(['assessment']);
    expect(model.entriesFor('assessing', row, permission)).toEqual([]);
    expect(model.entriesFor('regularized', { ...row, regularizationState: 'effective' }, permission)).toEqual(['edit']);
  });
});

describe('AC-FE-R2c1 ③ 提交体与回执按真实接口形状', () => {
  it('编辑试用期：无试用期只发是否与转正日期；推算预计结束日，改为无时清空', () => {
    const values = {
      hasProbation: false,
      startDate: '2026-08-01',
      months: 3,
      expectedEndDate: '',
      regularizationDate: '',
    };
    expect(model.adjustBody(values)).toEqual({ hasProbation: false, regularizationDate: null });
    expect(model.adjustChanges({ months: 2 }, { hasProbation: true, startDate: '2026-08-01', months: 2 })).toEqual({
      expectedEndDate: '2026-09-30',
    });
    expect(model.adjustChanges({ hasProbation: false }, {})).toEqual({
      startDate: null,
      months: null,
      expectedEndDate: null,
    });
  });
  it.each([
    [{ hasProbation: undefined }, 'hasProbation'],
    [{ hasProbation: true, startDate: '', expectedEndDate: '2026-10-31' }, 'startDate'],
    [{ hasProbation: true, startDate: '2026-08-01', expectedEndDate: '2026-10-31', months: 7 }, 'months'],
    [{ hasProbation: true, startDate: '2026-08-01', expectedEndDate: '2026-07-31' }, 'expectedEndDate'],
  ])('编辑试用期本地校验 %o → %s', (values, field) => {
    expect(() => model.validateAdjust(values)).toThrow(
      expect.objectContaining({ fieldErrors: [expect.objectContaining({ name: [field] })] }),
    );
  });
  it('编辑回执要求同一员工、revision 前进且不带任职记录', () => {
    const receipt = { employeeId: row.employeeId, revision: 5, hasProbation: true };
    expect(model.acceptAdjust(receipt, row.employeeId!, 4)).toBe(5);
    expect(() => model.acceptAdjust({ ...receipt, revision: 4 }, row.employeeId!, 4)).toThrow();
    expect(() => model.acceptAdjust({ ...receipt, records: [] }, row.employeeId!, 4)).toThrow();
  });
  it('直接转正：不填日期不发键，员工 revision 逐人在 items 里', () => {
    expect(
      model.regularizationsBody({ effectiveDate: '', probationResult: 'pass' }, [{ employeeId: 'e1', revision: 3 }]),
    ).toEqual({
      mode: 'direct',
      probationResult: 'pass',
      items: [{ employeeId: 'e1', revision: 3 }],
    });
    expect(() => model.validateRegularize({ effectiveDate: '', probationResult: 'pass' })).toThrow();
    expect(() => model.validateRegularize({ effectiveDate: '', probationResult: 'pass' }, false)).not.toThrow();
    expect(() => model.validateRegularize({ effectiveDate: '2026-11-01', probationResult: null })).toThrow();
  });
  const succeeded = (employeeId: string): model.ReceiptItem => ({
    employeeId,
    status: 'succeeded',
    businessId: `b-${employeeId}`,
    effectiveDate: '2026-11-01',
    businessStatus: 'approved',
    error: null,
  });
  const failed = (employeeId: string, code = 'REVISION_CONFLICT'): model.ReceiptItem => ({
    employeeId,
    status: 'failed',
    businessId: null,
    effectiveDate: null,
    businessStatus: null,
    error: { code, message: '数据已被修改', details: { reason: 'X' } },
  });
  const pinned = [
    { employeeId: 'e1', revision: 1 },
    { employeeId: 'e2', revision: 2 },
  ];
  it('批量回执逐人同序；部分成功返回失败清单，乱序或缺单据 ID 判为回执不符', () => {
    const receipt = { total: 2, succeeded: 1, failed: 1, items: [succeeded('e1'), failed('e2')] };
    expect(model.acceptRegularizations(receipt, pinned).failed.map((item) => item.employeeId)).toEqual(['e2']);
    expect(() => model.acceptRegularizations({ ...receipt, items: [failed('e2'), succeeded('e1')] }, pinned)).toThrow(
      '回执与原单不符',
    );
    expect(() =>
      model.acceptRegularizations(
        { ...receipt, items: [{ ...succeeded('e1'), businessId: null }, failed('e2')] },
        pinned,
      ),
    ).toThrow('回执与原单不符');
  });
  it('单人失败按该人错误码抛出：REVISION_CONFLICT 走 409 冲突恢复，其余按拒绝', () => {
    const one = [pinned[0]!];
    const conflict = () => model.acceptRegularizations({ total: 1, items: [failed('e1')] }, one);
    expect(conflict).toThrow(DirectError);
    expect(conflict).toThrow(expect.objectContaining({ status: 409, code: 'REVISION_CONFLICT' }));
    const rejected = () => model.acceptRegularizations({ total: 1, items: [failed('e1', 'VALIDATION_FAILED')] }, one);
    expect(rejected).toThrow(expect.objectContaining({ status: 400, details: { reason: 'X' } }));
  });
  it('批量入口只选一人也按逐人回执：版本冲突列为这一人的失败，不抛给内核（P2-2）', () => {
    const one = [pinned[0]!];
    expect(model.regularizationReceipt({ total: 1, items: [failed('e1')] }, one)).toEqual({
      succeeded: [],
      failed: [failed('e1')],
    });
    expect(() => model.regularizationReceipt({ total: 2, items: [failed('e1')] }, one)).toThrow('回执与原单不符');
  });
});

describe('AC-FE-R2c1 ④ 写后去向', () => {
  it('直接转正（审批通过 / 生效）进已转正，申请提交进转正审批中', () => {
    expect(model.destinationOf('approved')).toBe('regularized');
    expect(model.destinationOf('effective')).toBe('regularized');
    expect(model.destinationOf('in_review')).toBe('in_review');
    expect(model.destinationOf('draft')).toBeUndefined();
  });
});
