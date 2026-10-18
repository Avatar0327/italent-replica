/// <reference lib="dom" />
// @vitest-environment happy-dom
// F-153（DEC-511）：调动暂存按人一份——重选同一人自动带出、可清除，不再按单号累积暂存单列表。
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { beginHrWrite, finishHrWrite, readHrSession } from '../../apps/web/src/transfer/hr-session.js';
import {
  applyPendingDraft,
  catalogType,
  clearDraft,
  draftTransferType,
  editableLinkage,
  linkageFromOptions,
  parseDraft,
  restoreDraft,
} from '../../apps/web/src/transfer/draft-restore.js';
import { emptyLinkage } from '../../apps/web/src/transfer/linkage-api.js';
import { text } from '../../apps/web/src/transfer/messages.js';
import type { TransferFormModel, TransferPreview } from '../../apps/web/src/transfer/types.js';

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const scope = JSON.stringify(['tenant', 'identity']);
const employee = '30000000-0000-4000-8000-000000000001';
const draftId = '60000000-0000-4000-8000-000000000001';
// GET /api/tenant/employment/businesses/:id 的真实形状（read-model.ts）：fields 为完整预置字段快照，不含调动元数据。
const business = {
  id: draftId,
  employeeId: employee,
  revision: 1,
  employeeRevision: 4,
  status: 'draft',
  kind: 'transfer',
  changeType: 'position_adjustment',
  mode: 'application',
  formId: 'hr',
  effectiveDate: '2026-10-20',
  fields: { place: '暂存工作地', departmentId: 'dept-a', positionId: null },
  customFields: { remark: '暂存备注' },
  employeeStatus: 'employed',
  entryStatus: null,
  record: null,
  activation: null,
};
// GET /transfers/:id/linkage：options 只含可见的联动项，被隐藏的项不出现。
const linkage = {
  businessId: draftId,
  revision: 1,
  options: { adjustSalary: true, onTrial: { months: 3, startDate: '2026-10-21' } },
  executedAt: null,
  contract: null,
  salaryReminder: null,
};
const preview: TransferPreview = {
  employeeRevision: 4,
  allowDirectTransfer: false,
  form: {
    id: 'hr',
    name: '调动申请',
    isStandard: true,
    excludedAutofillFields: [],
    fieldModes: {
      'preset:place': 'editable',
      'preset:departmentId': 'readonly',
      'preset:positionId': 'editable',
      'custom:remark': 'editable',
    },
    customFields: [{ id: 'remark', name: '备注', valueType: 'text' }],
  },
  fields: { place: '当前工作地', departmentId: 'dept-b', positionId: '' },
  customFields: { remark: '' },
  before: { fields: { place: '原工作地' }, customFields: {} },
};
const model: TransferFormModel = {
  initiator: 'hr',
  employees: [],
  departments: [],
  catalog: {
    today: '2026-10-12',
    types: [
      { code: 'transfer', name: '部门间调动', formId: 'hr' },
      { code: 'inner', name: '部门内调动', formId: 'inner' },
    ],
    reasons: [],
  },
  employeeId: employee,
  effectiveDate: '2026-10-12',
  transferTypeCode: 'inner',
  reasonCode: '',
  withEstablishment: false,
  fields: {},
  customFields: {},
  preview: null,
  linkage: emptyLinkage,
};

it('AC-FE-F153-01 F-181b 会话只保留 processing，直接丢弃旧草稿索引', () => {
  sessionStorage.setItem(`italent.transfer.l2:${scope}`, JSON.stringify({ processing: false, drafts: { invalid: 3 } }));
  expect(readHrSession(scope)).toEqual({ processing: false });
  beginHrWrite(scope);
  expect(readHrSession(scope).processing).toBe(true);
  finishHrWrite(scope);
  expect(JSON.parse(sessionStorage.getItem(`italent.transfer.l2:${scope}`)!)).toEqual({ processing: false });
});

it('AC-FE-F153-02 读取暂存按真实接口形状核对：单号、人员、revision、联动版本不符一律视为读取失败', () => {
  const parsed = parseDraft(draftId, employee, business, linkage);
  expect(parsed).toMatchObject({
    id: draftId,
    employeeId: employee,
    effectiveDate: '2026-10-20',
    formId: 'hr',
    fields: business.fields,
    customFields: business.customFields,
  });
  expect(() => parseDraft(draftId, employee, { ...business, id: 'other' }, linkage)).toThrow();
  expect(() => parseDraft(draftId, 'other-employee', business, linkage)).toThrow();
  expect(() => parseDraft(draftId, employee, { ...business, revision: '1' }, linkage)).toThrow();
  expect(() => parseDraft(draftId, employee, { ...business, fields: null }, linkage)).toThrow();
  expect(() => parseDraft(draftId, employee, business, { ...linkage, businessId: 'other' })).toThrow();
  expect(() => parseDraft(draftId, employee, business, { ...linkage, revision: 2 })).toThrow();
});

it.each(['in_review', 'approved', 'effective', 'void'])('AC-FE-F153-02 已不是草稿（%s）时不带出', (status) => {
  expect(parseDraft(draftId, employee, { ...business, status }, linkage)).toBeNull();
});

it('AC-FE-F153-03 联动选项还原为表单草稿；被隐藏（未返回）的项保持默认', () => {
  expect(linkageFromOptions(null)).toEqual(emptyLinkage);
  expect(linkageFromOptions({})).toEqual(emptyLinkage);
  expect(
    linkageFromOptions({
      contract: { targetId: 'contract-1', fields: { termMonths: 12, endDate: null } },
      adjustSalary: true,
      onTrial: { months: 3 },
      handover: { handoverPersonId: 'person-h' },
      dutyTransfer: {
        subordinates: [
          { employeeId: 'sub-1', receiverId: 'receiver', relation: 'direct' },
          { employeeId: 'sub-2', receiverId: 'receiver', relation: 'direct' },
        ],
        orgRoles: [{ orgId: 'dept-a', role: 'person_in_charge', receiverId: 'receiver' }],
      },
    }),
  ).toEqual({
    changeContract: true,
    contractTargetId: 'contract-1',
    contractFields: { termMonths: 12, endDate: null },
    adjustSalary: true,
    onTrialMonths: 3,
    onTrialStartDate: '',
    handoverPersonId: 'person-h',
    dutyReceiverId: 'receiver',
    dutySubordinateIds: ['sub-1', 'sub-2'],
    transferDepartmentHead: true,
  });
  // 表单只能表达一个接收人；多个接收人无法如实带出，按读取失败处理而不是只带出一部分。
  expect(() =>
    linkageFromOptions({
      dutyTransfer: {
        subordinates: [
          { employeeId: 'sub-1', receiverId: 'receiver-1', relation: 'direct' },
          { employeeId: 'sub-2', receiverId: 'receiver-2', relation: 'direct' },
        ],
        orgRoles: [],
      },
    }),
  ).toThrow();
});

it('AC-FE-F153-04 DEC-467 异动类型取服务端元数据类型，缺键不从唯一表单推断', () => {
  const parsed = parseDraft(draftId, employee, business, linkage)!;
  expect(draftTransferType(model.catalog, parsed)).toBeUndefined();
  const typed = parseDraft(draftId, employee, business, linkage, 'transfer')!;
  expect(typed.transferTypeCode).toBe('transfer');
  expect(draftTransferType(model.catalog, typed)).toBe('transfer');
  // 元数据是类型的唯一来源，内容接口不提供调动类型。
  expect(parseDraft(draftId, employee, { ...business, transferTypeCode: 'inner' }, linkage, 'transfer')).toMatchObject({
    transferTypeCode: 'transfer',
  });
});

it('AC-FE-F153-04 #350 P2-1 多个类型共用一个表单：按记下的类型还原；取不到或与表单不符时不默认', () => {
  const shared = {
    ...model.catalog,
    types: [
      { code: 'place', name: '工作地调整', formId: 'hr' },
      { code: 'inner', name: '部门内调岗', formId: 'hr' },
    ],
  };
  const parse = (storedType?: string) => parseDraft(draftId, employee, business, linkage, storedType)!;
  expect(draftTransferType(shared, parse('place'))).toBe('place');
  expect(draftTransferType(shared, parse('inner'))).toBe('inner');
  expect(draftTransferType(shared, parse())).toBeUndefined();
  // 记下的类型已不在目录里，或与单据表单不符：不退回目录第一项。
  expect(draftTransferType(shared, parse('transfer'))).toBeUndefined();
  expect(draftTransferType(model.catalog, parse('inner'))).toBeUndefined();
  expect(draftTransferType(model.catalog, { ...parse(), formId: 'position_adjustment' })).toBeUndefined();
});

it('AC-FE-F153-04 #350 P2-1 类型无法确定时留空并要求确认；目录刷新不把它默认成第一项', () => {
  const shared = {
    ...model.catalog,
    types: [
      { code: 'place', name: '工作地调整', formId: 'hr' },
      { code: 'inner', name: '部门内调岗', formId: 'hr' },
    ],
  };
  const restored = restoreDraft({ ...model, catalog: shared }, parseDraft(draftId, employee, business, linkage)!);
  expect(restored).toMatchObject({ transferTypeCode: '', typeConfirmation: true, preview: null });
  expect(catalogType(restored, shared)).toEqual({ transferTypeCode: '', typeConfirmation: true });
  const typed = restoreDraft({ ...model, catalog: shared }, parseDraft(draftId, employee, business, linkage, 'place')!);
  expect(typed).toMatchObject({ transferTypeCode: 'place', typeConfirmation: false });
  expect(catalogType({ ...model, transferTypeCode: 'gone' }, shared)).toEqual({
    transferTypeCode: 'place',
    typeConfirmation: false,
  });
  expect(clearDraft(restored)).toMatchObject({ transferTypeCode: 'place', typeConfirmation: false });
});

it('AC-FE-F153-05 带出时只回填“当前可编辑且与预览不同”的字段，只读与未改字段取预览', () => {
  const parsed = parseDraft(draftId, employee, business, linkage, 'transfer')!;
  const restored = restoreDraft(model, parsed);
  expect(restored).toMatchObject({
    effectiveDate: '2026-10-20',
    transferTypeCode: 'transfer',
    preview: null,
    fields: {},
    linkage: { ...emptyLinkage, adjustSalary: true, onTrialMonths: 3, onTrialStartDate: '2026-10-21' },
  });
  const applied = applyPendingDraft({ ...restored, preview });
  expect(applied.fields).toEqual({ place: '暂存工作地' });
  expect(applied.customFields).toEqual({ remark: '暂存备注' });
  expect(applied.pendingDraft).toBeUndefined();
  expect(applyPendingDraft(applied)).toBe(applied);
});

it('AC-FE-F153-05 日期与类型未变且预览已到时立即回填；换人后不把上一人的暂存套到新人', () => {
  const parsed = parseDraft(draftId, employee, { ...business, effectiveDate: '2026-10-12' }, linkage, 'transfer')!;
  const current = { ...model, transferTypeCode: 'transfer', preview };
  expect(restoreDraft(current, parsed).fields).toEqual({ place: '暂存工作地' });
  expect(restoreDraft({ ...current, employeeId: 'other-employee' }, parsed)).toEqual({
    ...current,
    employeeId: 'other-employee',
  });
  const pending = restoreDraft(model, parsed);
  const switched = applyPendingDraft({ ...pending, employeeId: 'other-employee', preview });
  expect(switched.fields).toEqual({});
  expect(switched.pendingDraft).toBeUndefined();
});

it('AC-FE-F153-06 点击清除恢复为空白表单：日期取租户当天、默认类型，保留所选人员', () => {
  const parsed = parseDraft(draftId, employee, business, linkage, 'transfer')!;
  const applied = applyPendingDraft({ ...restoreDraft(model, parsed), preview });
  const cleared = clearDraft({ ...applied, reasonCode: 'reason', withEstablishment: true });
  expect(cleared).toMatchObject({
    employeeId: employee,
    effectiveDate: '2026-10-12',
    transferTypeCode: 'transfer',
    reasonCode: '',
    withEstablishment: false,
    fields: {},
    customFields: {},
    linkage: emptyLinkage,
  });
  expect(cleared.pendingDraft).toBeUndefined();
});

it('AC-FE-F153-05 联动只带出当前可编辑的项：只读或隐藏的项保持默认，不替用户重提', () => {
  const parsed = parseDraft(draftId, employee, business, linkage, 'transfer')!;
  const gated = { ...model.catalog, editableFields: ['effectiveDate', 'onTrialMonths'] };
  expect(restoreDraft({ ...model, catalog: gated }, parsed).linkage).toEqual({ ...emptyLinkage, onTrialMonths: 3 });
  expect(editableLinkage({ ...model.catalog, editableFields: ['isChangeContract'] }, parsed.linkage)).toEqual(
    emptyLinkage,
  );
  expect(editableLinkage(model.catalog, parsed.linkage)).toBe(parsed.linkage);
});

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { useHrWrite } = await import(resolve('apps/web/src/transfer/useHrWrite.ts'));
// POST /transfers/employees/:id 的真实回执（transfer/service.ts createTransfer）：业务单 + 调动元数据；
// 新建业务单推进员工版本（write-service createEmploymentBusiness → bumpEmploymentEmployee），提交再推进一次。
const submitted = { ...business, revision: 2, status: 'in_review', initiator: 'hr', transferTypeCode: 'transfer' };
it.each([
  ['有效回执：员工版本已推进过发出的 5', 6, true],
  ['陈旧回执：员工版本 4 没有推进过发出的 5', 4, false],
])('AC-FE-F153-07 #350 第 2 轮 P2-2 %s', async (_name, employeeRevision, accepted) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  finishHrWrite(scope);
  const root = createRoot(document.createElement('div'));
  let state!: ReturnType<typeof useHrWrite>;
  function Probe() {
    state = useHrWrite(scope);
    return null;
  }
  try {
    await act(() => root.render(h(Probe)));
    const send = async () => ({ ...submitted, employeeRevision });
    let failure: unknown;
    await act(() =>
      state.run(send, { employeeId: employee, transferTypeCode: 'transfer', revision: 5 }).catch((cause: unknown) => {
        failure = cause;
      }),
    );
    if (accepted) {
      expect(failure).toBeUndefined();
      expect(state.result).toMatchObject({ id: draftId, status: 'in_review', employeeRevision: 6 });
      expect(readHrSession(scope).processing).toBe(false);
      return;
    }
    // 失配不是本次写入的结果：不报成功，保持处理中锁定（结果未知，DEC-464）。
    expect(failure).toMatchObject({ message: text.unknown });
    expect(state.result).toBeNull();
    expect(readHrSession(scope).processing).toBe(true);
  } finally {
    await act(() => root.unmount());
  }
});
