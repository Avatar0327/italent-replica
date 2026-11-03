/**
 * FE-R2c3 退休五视图、意向退休日期申请、退休办理 / 申请与退休详情（差距表 B16～B24，R2-T04 设计 §10、§3.2）：前端纯契约。
 * 页面交互另见 apps/web/smoke/AC-FE-R2c3.smoke.spec.ts。
 */
import { describe, expect, it } from 'vitest';
import { MENU_ROUTES } from '../../apps/web/src/foundation/routes.js';
import type { ObjectPermission } from '../../apps/web/src/foundation/permission-model.js';
import {
  acceptIntention,
  acceptRetirement,
  cellValue,
  intentionBody,
  columns,
  confirmationOf,
  entriesFor,
  intentionEntries,
  listPath,
  previewNotices,
  retireBody,
  views,
} from '../../apps/web/src/retirement/model.js';

const employeeId = '30000000-0000-4000-8000-000000000001';
const billId = '70000000-0000-4000-8000-000000000001';
const departmentId = '60000000-0000-4000-8000-000000000001';
const receiverId = '30000000-0000-4000-8000-000000000002';
const subordinateId = '30000000-0000-4000-8000-000000000003';
const permission = (buttons: string[], operations = { create: true, update: true }): ObjectPermission => ({
  objectCode: 'TenantBase.EmploymentRecord',
  dataOperations: operations,
  viewableFields: ['lastWorkDate', 'departmentId', 'intendedDate', 'reason'],
  editableFields: ['lastWorkDate', 'handoverEmployeeId', 'intendedDate', 'reason'],
  buttons: buttons.map((buttonCode) => ({ buttonCode, level: 'detail' })),
});
const all = permission([
  'Employment.Retire',
  'Employment.RetireApproval',
  'Employment.RetireCancel',
  'Employment.RetireIntention',
]);
// 员工行（retirement-views.ts RETIREMENT_PERSON_DEPENDENCIES）与单据行（toRetirementItem）按后端投影
const person = {
  employeeId,
  name: '合成退休人员',
  code: 'RT-DEMO-001',
  departmentId,
  positionId: null,
  expectedRetirementDate: '2026-11-30',
  daysToRetirement: 31,
  earliestRetirementDate: '2026-08-31',
  latestRetirementDate: '2027-02-28',
};
const bill = (status: string, extra: Record<string, unknown> = {}) => ({
  id: billId,
  employeeId,
  code: 'RT-DEMO-001',
  name: '合成退休人员',
  departmentId,
  positionId: null,
  lastWorkDate: '2026-11-30',
  plannedLastWorkDate: '2026-11-30',
  effectiveDate: '2026-12-01',
  status,
  mode: 'application',
  initiator: 'hr',
  initiatorUserId: '20000000-0000-4000-8000-000000000001',
  batchId: null,
  revision: 3,
  createdAt: '2026-10-30T02:00:00.000Z',
  activation: null,
  cancellation: null,
  retireType: 'normal',
  reEmployed: false,
  expectedRetirementDate: '2026-11-30',
  ...extra,
});

describe('AC-FE-R2c3 退休入口与五视图', () => {
  it('任职管理下登记唯一“退休管理”入口（F-125 自注册）', () => {
    expect(MENU_ROUTES.filter((route) => route.id === 'retirements')).toMatchObject([
      { app: 'transfer', label: '退休管理', objectCode: 'TenantBase.EmploymentRecord', path: '/retirements' },
    ]);
  });

  it('B16～B20 五视图原样交服务端 view；即将退休天数只随“即将退休”发送', () => {
    expect(views.map((item) => [item.key, item.label])).toEqual([
      ['upcoming', '即将退休'],
      ['overdue', '过期未退休'],
      ['processing', '退休中'],
      ['completed', '已完成的退休'],
      ['all', '全部退休记录'],
    ]);
    for (const { key } of views) {
      const query = new URL(listPath(key, 2, { asOf: '2026-10-30', upcomingDays: 60 }), 'https://example.com')
        .searchParams;
      expect([query.get('view'), query.get('page'), query.get('pageSize'), query.get('asOf')]).toEqual([
        key,
        '2',
        '30',
        '2026-10-30',
      ]);
      expect(query.get('upcomingDays')).toBe(key === 'upcoming' ? '60' : null);
    }
    expect(new URL(listPath('all', 1, { asOf: '' }), 'https://example.com').searchParams.has('asOf')).toBe(false);
  });

  it('列按后端投影：员工视图用预计退休日期，单据视图用最后工作日与状态', () => {
    expect(columns.upcoming).toContain('expectedRetirementDate');
    expect(columns.overdue).toContain('daysToRetirement');
    expect(columns.processing).toEqual(expect.arrayContaining(['lastWorkDate', 'effectiveDate', 'status']));
    for (const key of ['completed', 'all'] as const) expect(columns[key]).toContain('retireType');
  });

  it('字段被裁剪时单元格显示占位，不拿别的字段拼值', () => {
    const { expectedRetirementDate: _p, daysToRetirement: _d, ...trimmed } = person;
    expect(cellValue(trimmed, 'expectedRetirementDate')).toBe('--');
    expect(cellValue(trimmed, 'daysToRetirement')).toBe('--');
    expect(cellValue(person, 'daysToRetirement')).toBe('31');
    expect(cellValue(bill('in_review'), 'status')).toBe('审批中');
    expect(cellValue(bill('effective'), 'retireType')).toBe('正常退休');
    expect(cellValue(bill('effective', { reEmployed: true }), 'reEmployed')).toBe('是');
    const { retireType: _t, ...noType } = bill('effective');
    expect(cellValue(noType, 'retireType')).toBe('--');
  });
});

describe('AC-FE-R2c3 入口只按视图归属、单据状态与权限快照里的按钮显示', () => {
  it('员工视图：退休办理 / 退休申请 / 意向退休日期申请各看各的按钮与新增操作', () => {
    expect(entriesFor('upcoming', person, all)).toEqual(['retire', 'apply', 'intention']);
    expect(entriesFor('overdue', person, permission(['Employment.Retire']))).toEqual(['retire']);
    expect(entriesFor('upcoming', person, permission(['Employment.RetireApproval']))).toEqual(['apply']);
    expect(entriesFor('upcoming', person, permission([]))).toEqual([]);
    expect(entriesFor('upcoming', person, permission(['Employment.Retire'], { create: false, update: true }))).toEqual(
      [],
    );
    expect(entriesFor('upcoming', { ...person, employeeId: undefined }, all)).toEqual([]);
    // 最后工作日没有编辑权：创建会被字段权拒绝（exit-gate.ts createPayload），办理 / 申请都不出
    expect(entriesFor('upcoming', person, { ...all, editableFields: ['intendedDate'] })).toEqual(['intention']);
    expect(entriesFor('upcoming', person, undefined)).toEqual([]);
  });

  it('单据：草稿 / 驳回可提交，审批中可撤回，审批通过 / 已生效可撤销；已撤销的不再出撤销', () => {
    expect(entriesFor('all', bill('draft'), all)).toEqual(['submit']);
    expect(entriesFor('all', bill('rejected'), all)).toEqual(['submit']);
    expect(entriesFor('processing', bill('in_review'), all)).toEqual(['withdraw']);
    expect(entriesFor('processing', bill('approved', { mode: 'direct' }), all)).toEqual(['cancel']);
    expect(entriesFor('completed', bill('effective'), all)).toEqual(['cancel']);
    expect(entriesFor('all', bill('voided', { cancellation: { id: billId } }), all)).toEqual([]);
    expect(entriesFor('all', bill('effective', { cancellation: { id: billId } }), all)).toEqual([]);
    expect(entriesFor('processing', bill('in_review'), permission(['Employment.RetireCancel']))).toEqual([]);
    expect(entriesFor('completed', bill('effective'), permission(['Employment.RetireApproval']))).toEqual([]);
    // 单据 revision 被裁剪或无效：不能按单据命令提交
    expect(entriesFor('processing', bill('in_review', { revision: undefined }), all)).toEqual([]);
    expect(
      entriesFor(
        'processing',
        bill('in_review'),
        permission(['Employment.RetireApproval'], {
          create: true,
          update: false,
        }),
      ),
    ).toEqual([]);
  });

  it('意向申请：无在途单可新建；草稿 / 驳回可修改与提交；审批中可撤回；按钮与字段编辑权缺一不显示', () => {
    expect(intentionEntries(undefined, all)).toEqual(['create']);
    expect(intentionEntries({ status: 'draft' }, all)).toEqual(['edit', 'submit']);
    expect(intentionEntries({ status: 'rejected' }, all)).toEqual(['edit', 'submit']);
    expect(intentionEntries({ status: 'in_review' }, all)).toEqual(['withdraw']);
    expect(intentionEntries({ status: 'approved' }, all)).toEqual(['create']);
    expect(intentionEntries(undefined, permission(['Employment.Retire']))).toEqual([]);
    expect(intentionEntries({ status: 'draft' }, { ...all, editableFields: [] })).toEqual(['submit']);
  });

  it('第 2 轮 P2-4：意向日期只读时，员工视图入口仍在，已有草稿可提交、审批中可撤回', () => {
    const readonly = { ...all, editableFields: ['lastWorkDate'] };
    expect(entriesFor('upcoming', person, readonly)).toEqual(['retire', 'apply', 'intention']);
    expect(intentionEntries(undefined, readonly)).toEqual([]);
    expect(intentionEntries({ status: 'draft' }, readonly)).toEqual(['submit']);
    expect(intentionEntries({ status: 'in_review' }, readonly)).toEqual(['withdraw']);
    // 只有修改权（无新增）也能进入已有申请；按钮缺失仍不出
    const updateOnly = permission(['Employment.RetireIntention'], { create: false, update: true });
    expect(entriesFor('upcoming', person, updateOnly)).toEqual(['intention']);
    const neither = permission(['Employment.RetireIntention'], { create: false, update: false });
    expect(entriesFor('upcoming', person, neither)).toEqual([]);
    expect(entriesFor('upcoming', person, { ...readonly, buttons: [] })).toEqual([]);
  });
});

describe('AC-FE-R2c3 提交体、确认令牌与回执', () => {
  const values = {
    lastWorkDate: '2026-11-30',
    handoverEmployeeId: receiverId,
    dutyReceiverId: receiverId,
    dutySubordinateIds: [subordinateId],
    transferDepartmentHead: true,
  };

  it('退休办理：职责转交按后端 dutyTransfer 结构，确认令牌放在 exit.pendingTransferAck', () => {
    expect(retireBody(values, 'direct', departmentId, { ack: 'token-1' })).toEqual({
      mode: 'direct',
      lastWorkDate: '2026-11-30',
      exit: {
        handoverEmployeeId: receiverId,
        dutyTransfer: {
          subordinates: [{ employeeId: subordinateId, receiverId, relation: 'direct' }],
          orgRoles: [{ orgId: departmentId, role: 'person_in_charge', receiverId }],
        },
        pendingTransferAck: 'token-1',
      },
    });
    // 没有接收人就不提交职责转交；也没有交接人和令牌时不带 exit
    expect(
      retireBody({ lastWorkDate: '2026-11-30', dutySubordinateIds: [subordinateId] }, 'direct', departmentId),
    ).toEqual({ mode: 'direct', lastWorkDate: '2026-11-30' });
  });

  it('退休申请（B23）没有职责转交区：即使表单残留也不提交 dutyTransfer', () => {
    expect(retireBody(values, 'application', departmentId)).toEqual({
      mode: 'application',
      lastWorkDate: '2026-11-30',
      exit: { handoverEmployeeId: receiverId },
    });
  });

  it('意向申请体只发有编辑权的字段（retirement-intention.ts 严格体），原因清空发 null', () => {
    expect(intentionBody({ intendedDate: '2026-12-31', reason: '' }, ['intendedDate', 'reason'])).toEqual({
      intendedDate: '2026-12-31',
      reason: null,
    });
    expect(intentionBody({ intendedDate: '2026-12-31', reason: '健康原因' }, ['intendedDate'])).toEqual({
      intendedDate: '2026-12-31',
    });
  });

  it('二次确认：在途调动令牌映射为 ack，超编映射为 confirmed，其余 409 是拒绝', () => {
    const ack = {
      status: 409,
      message: '请确认',
      details: { reason: 'EXIT_PENDING_TRANSFER_ACK_REQUIRED', ackToken: 't2' },
    };
    expect(confirmationOf(ack)).toEqual({ message: '请确认', extra: { ack: 't2' } });
    const assessment = { ...ack, details: { reason: 'EXIT_IN_FLIGHT_ASSESSMENT_ACK_REQUIRED', ackToken: 't3' } };
    expect(confirmationOf(assessment)?.extra).toEqual({ ack: 't3' });
    const capacity = { status: 409, message: '超编', details: { reason: 'CONFIRMATION_REQUIRED' } };
    expect(confirmationOf(capacity)?.extra).toEqual({ confirmed: true });
    expect(confirmationOf({ status: 409, details: { reason: 'EXIT_IN_PROGRESS' } })).toBeUndefined();
    expect(confirmationOf({ status: 409, details: { reason: 'EXIT_PENDING_TRANSFER_ACK_REQUIRED' } })).toBeUndefined();
    expect(confirmationOf({ status: 400, details: { reason: 'CONFIRMATION_REQUIRED' } })).toBeUndefined();
  });

  it('预览：阻断项与需提示的警告只取有条目的，件数含不可见件数', () => {
    const preview = {
      lastWorkDate: '2026-11-30',
      effectiveDate: '2026-12-01',
      blockers: [
        { reason: 'EXIT_IN_PROGRESS', items: [{ businessId: billId, effectiveDate: '2026-11-01' }], hiddenCount: 1 },
      ],
      ack: null,
      warnings: [
        { reason: 'EXIT_APPLICATIONS_TO_VOID', items: [], hiddenCount: 0 },
        {
          reason: 'EXIT_FUTURE_TRANSFER_LANDED',
          items: [{ businessId: billId, effectiveDate: '2026-12-02' }],
          hiddenCount: 0,
        },
        { reason: 'EXIT_APPLICATIONS_TOO_MANY', limit: 1000 },
      ],
    };
    expect(previewNotices(preview)).toEqual({
      blockers: [{ reason: 'EXIT_IN_PROGRESS', count: 2 }],
      warnings: [
        { reason: 'EXIT_FUTURE_TRANSFER_LANDED', count: 1 },
        { reason: 'EXIT_APPLICATIONS_TOO_MANY', count: undefined },
      ],
    });
  });

  it('回执按真实返回核对：新建核员工 revision，单据命令核单据 id 与 revision，类型须为退休', () => {
    const receipt = { id: billId, employeeId, kind: 'retirement', revision: 1, employeeRevision: 6, status: 'draft' };
    expect(acceptRetirement(receipt, { employeeId, sent: 5 })).toBe(receipt);
    expect(() => acceptRetirement(receipt, { employeeId, sent: 6 })).toThrow();
    expect(() => acceptRetirement({ ...receipt, kind: 'leave' }, { employeeId, sent: 5 })).toThrow();
    const submitted = { ...receipt, revision: 4, status: 'in_review' };
    expect(acceptRetirement(submitted, { employeeId, sent: 3, id: billId })).toBe(submitted);
    expect(() => acceptRetirement(submitted, { employeeId, sent: 4, id: billId })).toThrow();
    expect(() => acceptRetirement({ ...submitted, id: receiverId }, { employeeId, sent: 3, id: billId })).toThrow();
  });

  it('第 2 轮 P2-1：类型 / 状态 / 员工 revision 按字段权被裁剪时照常接受，字段在但值错误仍拒绝', () => {
    const receipt = { id: billId, employeeId, kind: 'retirement', revision: 4, employeeRevision: 6, status: 'voided' };
    const { kind: _kind, status: _status, employeeRevision: _rev, ...trimmed } = receipt;
    expect(acceptRetirement(trimmed, { employeeId, sent: 3, id: billId })).toBe(trimmed);
    expect(acceptRetirement({ ...trimmed, revision: 1 }, { employeeId, sent: 5 })).toMatchObject({ revision: 1 });
    expect(() => acceptRetirement({ ...trimmed, kind: 'leave' }, { employeeId, sent: 3, id: billId })).toThrow();
    expect(() => acceptRetirement({ ...trimmed, kind: null }, { employeeId, sent: 3, id: billId })).toThrow();
    expect(() => acceptRetirement({ ...trimmed, employeeRevision: 5 }, { employeeId, sent: 5 })).toThrow();
    expect(() => acceptRetirement({ ...trimmed, revision: 3 }, { employeeId, sent: 3, id: billId })).toThrow();
    const { revision: _r, ...noRevision } = trimmed;
    expect(() => acceptRetirement(noRevision, { employeeId, sent: 3, id: billId })).toThrow();
    const view = { id: billId, employeeId, intendedDate: '2026-12-31', revision: 1 };
    expect(acceptIntention(view, { employeeId })).toBe(view);
    expect(acceptIntention({ ...view, revision: 2 }, { employeeId, id: billId, sent: 1 })).toMatchObject({
      revision: 2,
    });
    expect(() => acceptIntention({ ...view, status: 'unknown' }, { employeeId })).toThrow();
    expect(() => acceptIntention({ ...view, status: null }, { employeeId })).toThrow();
  });

  it('意向回执（intentionView）：同员工、revision 前进；新建时 revision 不与员工 revision 比较', () => {
    const view = { id: billId, employeeId, status: 'draft', intendedDate: '2026-12-31', reason: null, revision: 1 };
    expect(acceptIntention(view, { employeeId })).toBe(view);
    expect(() => acceptIntention({ ...view, employeeId: receiverId }, { employeeId })).toThrow();
    expect(acceptIntention({ ...view, revision: 2 }, { employeeId, id: billId, sent: 1 })).toMatchObject({
      revision: 2,
    });
    expect(() => acceptIntention({ ...view, revision: 1 }, { employeeId, id: billId, sent: 1 })).toThrow();
    expect(() => acceptIntention({ ...view, status: 'unknown' }, { employeeId })).toThrow();
  });
});
