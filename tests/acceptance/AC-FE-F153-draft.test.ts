/// <reference lib="dom" />
// @vitest-environment happy-dom
// F-153（DEC-511）：调动暂存按人一份——重选同一人自动带出、可清除，不再按单号累积暂存单列表。
import { afterEach, expect, it } from 'vitest';
import {
  beginHrWrite,
  finishHrWrite,
  forgetHrDraft,
  hrDraftOf,
  readHrSession,
} from '../../apps/web/src/transfer/hr-session.js';
import {
  applyPendingDraft,
  clearDraft,
  draftTransferType,
  editableLinkage,
  linkageFromOptions,
  parseDraft,
  restoreDraft,
} from '../../apps/web/src/transfer/draft-restore.js';
import { emptyLinkage } from '../../apps/web/src/transfer/linkage-api.js';
import type { TransferFormModel, TransferPreview } from '../../apps/web/src/transfer/types.js';

afterEach(() => sessionStorage.clear());

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

it('AC-FE-F153-01 DEC-511 暂存按人只记一份：同一人再暂存替换旧单，提交后不再带出，按租户 / 身份隔离', () => {
  beginHrWrite(scope);
  finishHrWrite(scope, { employeeId: employee, draftId: 'draft-a' });
  beginHrWrite(scope);
  finishHrWrite(scope, { employeeId: employee, draftId: draftId });
  beginHrWrite(scope);
  finishHrWrite(scope, { employeeId: 'other-employee', draftId: 'draft-c' });
  expect(readHrSession(scope)).toEqual({
    processing: false,
    drafts: { [employee]: draftId, 'other-employee': 'draft-c' },
  });
  expect(hrDraftOf(scope, employee)).toBe(draftId);
  expect(hrDraftOf(JSON.stringify(['tenant', 'other']), employee)).toBeUndefined();
  beginHrWrite(scope);
  finishHrWrite(scope, { employeeId: employee });
  expect(hrDraftOf(scope, employee)).toBeUndefined();
  forgetHrDraft(scope, 'other-employee');
  expect(readHrSession(scope)).toEqual({ processing: false, drafts: {} });
});

it('AC-FE-F153-01 被拒（无回执）不改按人索引；旧版按单号数组的会话不锁表单、不带出', () => {
  beginHrWrite(scope);
  finishHrWrite(scope, { employeeId: employee, draftId });
  beginHrWrite(scope);
  finishHrWrite(scope);
  expect(hrDraftOf(scope, employee)).toBe(draftId);
  sessionStorage.setItem(`italent.transfer.l2:${scope}`, JSON.stringify({ processing: false, drafts: [draftId] }));
  expect(readHrSession(scope)).toEqual({ processing: false, drafts: {} });
  expect(() => beginHrWrite(scope)).not.toThrow();
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

it('AC-FE-F153-04 DEC-467 异动类型取返回的 transferTypeCode，否则按表单唯一对应的类型，不用 changeType', () => {
  const parsed = parseDraft(draftId, employee, business, linkage)!;
  expect(draftTransferType(model.catalog, parsed, 'inner')).toBe('transfer');
  expect(draftTransferType(model.catalog, { ...parsed, transferTypeCode: 'inner' }, 'transfer')).toBe('inner');
  const shared = {
    ...model.catalog,
    types: [...model.catalog.types, { code: 'other', name: '其他调动', formId: 'hr' }],
  };
  expect(draftTransferType(shared, parsed, 'inner')).toBe('inner');
  expect(draftTransferType(model.catalog, { ...parsed, formId: 'position_adjustment' }, 'inner')).toBe('inner');
});

it('AC-FE-F153-05 带出时只回填“当前可编辑且与预览不同”的字段，只读与未改字段取预览', () => {
  const parsed = parseDraft(draftId, employee, business, linkage)!;
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
  const parsed = parseDraft(draftId, employee, { ...business, effectiveDate: '2026-10-12' }, linkage)!;
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
  const parsed = parseDraft(draftId, employee, business, linkage)!;
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
  const parsed = parseDraft(draftId, employee, business, linkage)!;
  const gated = { ...model.catalog, editableFields: ['effectiveDate', 'onTrialMonths'] };
  expect(restoreDraft({ ...model, catalog: gated }, parsed).linkage).toEqual({ ...emptyLinkage, onTrialMonths: 3 });
  expect(editableLinkage({ ...model.catalog, editableFields: ['isChangeContract'] }, parsed.linkage)).toEqual(
    emptyLinkage,
  );
  expect(editableLinkage(model.catalog, parsed.linkage)).toBe(parsed.linkage);
});
