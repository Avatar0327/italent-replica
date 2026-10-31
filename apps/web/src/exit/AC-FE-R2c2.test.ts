import { describe, expect, it } from 'vitest';
import type { ObjectPermission } from '../foundation/permission-model.js';
import * as model from './exit-model.js';

const buttons = [
  ['Employment.Dimission', 'detail'],
  ['Employment.DimissionApproval', 'detail'],
  ['Employment.DimissionEdit', 'detail'],
  ['Employment.DimissionCancel', 'detail'],
  ['EmploymentRecrdDetailDimissionHandoverApproval', 'detail'],
  ['Employment.HandoverReSubmit', 'detail'],
  ['BatchDimissionHandoverApproval', 'list'],
];
const permission: ObjectPermission = {
  objectCode: model.object,
  dataOperations: { create: true, update: true },
  buttons: buttons.map(([buttonCode, level]) => ({ buttonCode: buttonCode!, level: level! })),
  viewableFields: [...model.formFields],
  editableFields: [...model.formFields],
};
const without = (code: string): ObjectPermission => ({
  ...permission,
  buttons: permission.buttons.filter((button) => button.buttonCode !== code),
});
// 形态对照 exit-routes.ts trimExit + rowActions
const row: model.Row = {
  id: 'exit-1',
  employeeId: 'employee-1',
  name: '合成员工',
  code: 'EX-001',
  lastWorkDate: '2026-11-30',
  effectiveDate: '2026-12-01',
  exitTypeCode: 'voluntary',
  exitTypeName: '主动离职',
  status: 'in_review',
  mode: 'application',
  revision: 3,
  activation: null,
  rowActions: [],
};
// 形态对照 exit-preview.ts previewExit
const preview = (warnings: model.Preview['warnings'], ack: model.Preview['ack'] = null): model.Preview => ({
  lastWorkDate: '2026-11-30',
  blockers: [],
  ack,
  warnings,
});

describe('AC-FE-R2c2 列表投影与筛选', () => {
  it('三视图各按自己的 view 读，筛选只带可见项', () => {
    expect(model.listPath('completed', 2, { keyword: '合成' })).toBe(
      '/api/tenant/employment/exits?view=completed&page=2&pageSize=30&keyword=%E5%90%88%E6%88%90',
    );
    const filters = model.allowedFilters({ keyword: '合成', departmentId: 'dept' }, (key) => key === 'departmentId');
    expect(filters).toEqual({ departmentId: 'dept' });
    expect(model.allowedFilters({ keyword: '  ', departmentId: '' }, () => true)).toEqual({ keyword: '  ' });
  });
  it('被裁剪的字段显示占位，不拿名称或别的字段拼值', () => {
    expect(model.cellValue(row, 'exitTypeCode')).toBe('主动离职');
    const { exitTypeCode: _code, ...trimmed } = row;
    expect(model.cellValue({ ...trimmed, exitTypeName: '主动离职' }, 'exitTypeCode')).toBe('—');
    expect(model.cellValue(row, 'reasonCode')).toBe('—');
    expect(model.cellValue(row, 'status')).toBe('审批中');
    expect(model.cellValue(row, 'mode')).toBe('离职申请');
  });
});

describe('AC-FE-R2c2 入口只按服务端动作 / 权限快照显示', () => {
  it('工具栏：新增操作 + 对应按钮', () => {
    expect(model.createEntries(permission)).toEqual(['application', 'direct']);
    expect(model.createEntries(without('Employment.Dimission'))).toEqual(['application']);
    expect(model.createEntries({ ...permission, dataOperations: { create: false, update: true } })).toEqual([]);
  });
  it('详情编辑 / 撤销：按状态、按钮与修改操作；状态被裁剪时不给', () => {
    expect(model.detailEntries(row, permission)).toEqual(['edit', 'cancel']);
    expect(model.detailEntries({ ...row, status: 'cancelled' }, permission)).toEqual([]);
    expect(model.detailEntries({ ...row, status: undefined }, permission)).toEqual([]);
    expect(model.detailEntries(row, without('Employment.DimissionCancel'))).toEqual(['edit']);
    expect(model.detailEntries({ ...row, revision: undefined }, permission)).toEqual([]);
  });
  it('行内发起交接只认 rowActions；批量按列表级按钮且只取带行动作的行', () => {
    const actionable = { ...row, rowActions: ['EmploymentRecrdLineOpDimissionHandoverApproval'] };
    expect(model.rowEntries(row, permission)).toEqual([]);
    expect(model.rowEntries(actionable, permission)).toEqual(['handover']);
    expect(model.batchHandoverRows([row, actionable], permission)).toEqual([actionable]);
    expect(model.batchHandoverRows([actionable], without('BatchDimissionHandoverApproval'))).toEqual([]);
  });
  it('交接：未发起且单据在审时首次发起；未发起成功 / 已终止时重新提交', () => {
    const none = { status: 'not_started', request: null };
    expect(model.handoverEntries(row, none, permission)).toEqual(['submit']);
    expect(model.handoverEntries({ ...row, status: 'draft' }, none, permission)).toEqual([]);
    const request = { id: 'h-1', status: 'not_launched', revision: 1, items: [] };
    expect(model.handoverEntries(row, { status: 'not_launched', request }, permission)).toEqual(['resubmit']);
    const running = { status: 'in_progress', request: { ...request, status: 'in_progress' } };
    expect(model.handoverEntries(row, running, permission)).toEqual([]);
    expect(model.handoverEntries(row, none, without('EmploymentRecrdDetailDimissionHandoverApproval'))).toEqual([]);
  });
});

describe('AC-FE-R2c2-F240 在途申请超上限', () => {
  it('提示含上限数；后端不给令牌，没有“确认并提交”，也不带令牌', () => {
    const notice = model.previewNotice(preview([{ reason: 'EXIT_APPLICATIONS_TOO_MANY', limit: 1000 }]));
    expect(notice.messages.join()).toContain('1000');
    expect(notice.tooMany).toBe(true);
    expect(notice.label).not.toBe('确认并提交');
    expect(notice.ackToken).toBeUndefined();
    expect(model.createBody({ lastWorkDate: '2026-11-30' }, 'direct')).toEqual({
      mode: 'direct',
      lastWorkDate: '2026-11-30',
      fields: {},
      exit: {},
    });
  });
  it('超上限同时出现令牌也不走确认路径（以超限为准）', () => {
    const notice = model.previewNotice(
      preview([{ reason: 'EXIT_APPLICATIONS_TOO_MANY', limit: 1000 }], { ackToken: 'token' }),
    );
    expect(notice.label).toBe('继续提交');
    expect(notice.ackToken).toBeUndefined();
  });
  it('有令牌时“确认并提交”，令牌只放 exit.pendingTransferAck', () => {
    const notice = model.previewNotice(
      preview(
        [
          { reason: 'EXIT_APPLICATIONS_TO_VOID', items: [{}, {}], hiddenCount: 1 },
          { reason: 'EXIT_FUTURE_TRANSFER_LANDED', items: [], hiddenCount: 0 },
        ],
        { ackToken: 'token' },
      ),
    );
    expect(notice).toMatchObject({ label: '确认并提交', ackToken: 'token', tooMany: false });
    expect(notice.messages).toEqual(['离职生效时将作废 3 条在途任职申请']);
    const body = model.createBody({ lastWorkDate: '2026-11-30' }, 'application', { pendingTransferAck: 'token' });
    expect(body).not.toHaveProperty('pendingTransferAck');
    expect(body.exit).toEqual({ pendingTransferAck: 'token' });
  });
  it('详情 activation 与命令 409 的 activationFailure 是同一码时显示原因，有上限就带上', () => {
    expect(
      model.activationNotice({ ...row, activation: { status: 'failed', reason: 'EXIT_APPLICATIONS_TOO_MANY' } }),
    ).toBe('生效失败：在途任职申请过多，请先处理后再办理离职');
    expect(
      model.activationNotice({ activationFailure: { reason: 'EXIT_APPLICATIONS_TOO_MANY', detail: { limit: 1000 } } }),
    ).toContain('1000');
    expect(model.activationNotice({ ...row, activation: { status: 'failed', reason: 'OTHER' } })).toBeUndefined();
  });
  it('blockers 挡提交并显示原因', () => {
    const notice = model.previewNotice({ ...preview([]), blockers: [{ reason: 'EXIT_IN_PROGRESS' }] });
    expect(notice.blockers).toEqual(['该员工已有在途的离职单']);
  });
});

describe('AC-FE-R2c2 请求体与回执校验（真实返回形状）', () => {
  it('加黑默认否；选“是”才发加黑三项，有效截止日期空 = 永久不发', () => {
    const values = {
      lastWorkDate: '2026-11-30',
      reasonCode: 'personal',
      addToBlacklist: false,
      blacklistReason: 'other',
    };
    expect(model.createBody(values, 'direct').exit).toEqual({ reasonCode: 'personal', addToBlacklist: false });
    const black = { ...values, addToBlacklist: true, blacklistExpiryDate: null, blacklistNote: '说明' };
    expect(model.createBody(black, 'direct').exit).toEqual({
      reasonCode: 'personal',
      addToBlacklist: true,
      blacklistReason: 'other',
      blacklistNote: '说明',
    });
    expect(() => model.validateExit({ ...black, blacklistReason: null }, model.formFields)).toThrow('加黑原因');
    expect(() => model.validateExit({ lastWorkDate: null }, model.formFields)).toThrow('最后工作日');
    expect(() => model.validateExit(values, ['reasonCode'])).toThrow('没有该字段的编辑权限');
  });
  it('改期只发修改的字段，确认项在顶层', () => {
    expect(model.patchBody({ lastWorkDate: '2026-12-15' }, { confirmed: true })).toEqual({
      lastWorkDate: '2026-12-15',
      confirmed: true,
    });
    // 已加黑的单清空有效截止日期 = 改为永久（接口接受 null）；未改加黑时不发 addToBlacklist
    expect(model.patchBody({ blacklistExpiryDate: null }, {}, { addToBlacklist: true })).toEqual({
      blacklistExpiryDate: null,
    });
    const baseline = { lastWorkDate: '2026-11-30', reasonCode: 'personal', addToBlacklist: false };
    expect(() => model.validateExit({ ...baseline, reasonCode: null }, model.formFields, baseline)).toThrow('不能清空');
    expect(() => model.validateExit({ ...baseline, lastWorkDate: null }, model.formFields, baseline)).toThrow(
      '最后工作日',
    );
    expect(() => model.validateExit(baseline, model.formFields, baseline)).not.toThrow();
  });
  it('新建回执核员工 revision 前进；单据回执核 id 与 revision', () => {
    const created = { id: 'exit-9', employeeId: 'employee-1', kind: 'leave', revision: 1, employeeRevision: 6 };
    expect(model.acceptExit(created, { employeeId: 'employee-1', sent: 5 })).toEqual({ id: 'exit-9', revision: 6 });
    expect(() => model.acceptExit(created, { employeeId: 'employee-1', sent: 6 })).toThrow();
    expect(() => model.acceptExit({ ...created, kind: 'retirement' }, { employeeId: 'employee-1', sent: 5 })).toThrow();
    const patched = { id: 'exit-1', employeeId: 'employee-1', kind: 'leave', revision: 4 };
    expect(model.acceptExit(patched, { id: 'exit-1', sent: 3 })).toEqual({ id: 'exit-1', revision: 4 });
    expect(() => model.acceptExit(patched, { id: 'exit-2', sent: 3 })).toThrow();
  });
  it('交接回执：首次发起离职 revision 不变；重新提交交接单 revision 前进', () => {
    const launched = { exitRequestId: 'exit-1', requestId: 'h-1', outcome: 'launched', revision: 3 };
    expect(model.acceptHandoverSubmit(launched, { id: 'exit-1', sent: 3 }).outcome).toBe('launched');
    expect(() => model.acceptHandoverSubmit(launched, { id: 'exit-1', sent: 2 })).toThrow();
    const resubmitted = { requestId: 'h-1', status: 'in_progress', revision: 2, approvalInstanceId: 'a-1' };
    expect(model.acceptResubmit(resubmitted, { id: 'h-1', sent: 1 })).toEqual({ status: 'in_progress' });
    expect(() => model.acceptResubmit(resubmitted, { id: 'h-1', sent: 2 })).toThrow();
  });
  it('批量交接：逐人回执与提交的单一一对应，失败原因原样保留', () => {
    const raw = {
      items: [
        { exitRequestId: 'b', outcome: 'failed', reason: 'REVISION_CONFLICT' },
        { exitRequestId: 'a', outcome: 'launched', requestId: 'h-a', revision: 3 },
      ],
    };
    expect(model.parseBatchReceipts(raw, ['a', 'b']).map((item) => [item.exitRequestId, item.reason])).toEqual([
      ['a', undefined],
      ['b', 'REVISION_CONFLICT'],
    ]);
    expect(() => model.parseBatchReceipts(raw, ['a'])).toThrow();
    expect(() => model.parseBatchReceipts({ items: [raw.items[0], raw.items[0]] }, ['a', 'b'])).toThrow();
  });
  it('预览回执须是本次最后工作日', () => {
    expect(() => model.parsePreview(preview([]), '2026-12-01')).toThrow();
    expect(model.parsePreview(preview([]), '2026-11-30').ack).toBeNull();
  });
});
