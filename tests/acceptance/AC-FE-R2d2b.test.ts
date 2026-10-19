import { describe, expect, it } from 'vitest';
import { ApiError } from '../../apps/web/src/foundation/client.js';
import { createFormStore } from '../../apps/web/src/foundation/forms/store.js';
import type { ObjectPermission } from '../../apps/web/src/foundation/permission-model.js';
import {
  actionsFor,
  bodyFor,
  requestValues,
  acceptRequest,
  requestError,
  requestFields,
} from '../../apps/web/src/part-time/request-model.js';
import { shorteningNotice } from '../../apps/web/src/part-time/request-confirmation.js';
import { approvalNotice } from '../../apps/web/src/approval/before-approve.js';

const permission: ObjectPermission = {
  objectCode: 'TenantBase.EmploymentRecord',
  dataOperations: { create: true, update: true, delete: true },
  viewableFields: ['serviceType', 'effectiveDate', 'endDate', 'departmentId', 'requestRemark'],
  editableFields: ['serviceType', 'effectiveDate', 'endDate', 'departmentId', 'requestRemark'],
  buttons: ['PartTimeApproval', 'PartTimeExtend', 'PartTimeEnd', 'Submit', 'Withdraw', 'Revoke', 'Delete'].map(
    (name) => ({ buttonCode: `Employment.${name}`, level: 'detail' }),
  ),
};
const row = {
  id: 'request-1',
  revision: 5,
  kind: 'extend',
  status: 'draft',
  serviceType: 'part_time',
  effectiveDate: '2026-09-01',
  endDate: '2026-10-25',
  originalEndDate: '2026-10-31',
  fields: { departmentId: 'department-1' },
  warnings: [],
};

describe('AC-FE-R2d2b 状态与权限交集（D2B-01 澄清）', () => {
  it.each([
    ['draft', ['edit', 'submit', 'delete', 'revoke']],
    ['rejected', ['edit', 'submit', 'delete', 'revoke']],
    ['in_review', ['withdraw', 'revoke']],
    ...['approved', 'effective', 'voided', 'deleted', 'disapproved', undefined].map((state) => [state, []]),
  ])('%s 只显示约定动作', (status, expected) => {
    expect(actionsFor({ ...row, status }, permission)).toEqual(expected);
  });
  it('缺对象、按钮权 fail closed；撤销只需自身按钮，不借用申请按钮', () => {
    expect(actionsFor(row, undefined)).toEqual([]);
    expect(actionsFor(row, { ...permission, buttons: [] })).toEqual([]);
    expect(actionsFor(row, { ...permission, dataOperations: {} })).toEqual([]);
    expect(actionsFor(row, { ...permission, buttons: [{ buttonCode: 'Employment.Revoke', level: 'detail' }] })).toEqual(
      ['revoke'],
    );
  });
  it('新增、延长、结束按各自按钮判，不从 initiator 渠道推用户资格', () => {
    const p = {
      ...permission,
      buttons: permission.buttons.filter((b) => b.buttonCode !== 'Employment.PartTimeExtend'),
    };
    expect(actionsFor({ ...row, initiator: 'hr' }, p)).toEqual(['revoke']);
    expect(actionsFor({ ...row, kind: 'add' }, p)).toContain('submit');
    expect(actionsFor({ ...row, kind: 'end' }, p)).toContain('submit');
  });
});
describe('AC-FE-R2d2b 真实 DTO、F-123 回执与拒绝', () => {
  it('字段平铺走内核，写时恢复真实嵌套；负责人联动不发', () => {
    const values = requestValues(row);
    expect(values).toMatchObject({
      serviceType: 'part_time',
      effectiveDate: '2026-09-01',
      departmentId: 'department-1',
    });
    expect(
      bodyFor('add', 'create', { ...values, employeeId: 'employee-1', isDepartmentHead: true }, true),
    ).toMatchObject({
      requestType: 'add',
      employeeId: 'employee-1',
      submit: true,
      partTimeType: 'part_time',
      startDate: '2026-09-01',
      fields: { departmentId: 'department-1' },
    });
    expect(bodyFor('add', 'create', values, false)).not.toHaveProperty('fields.isDepartmentHead');
    expect(bodyFor('extend', 'create', { endDate: '2026-10-25', recordId: 'record-1' }, true)).toEqual({
      requestType: 'extend',
      recordId: 'record-1',
      endDate: '2026-10-25',
      submit: true,
    });
    expect(bodyFor('end', 'edit', { endDate: '2026-10-25', departmentId: 'wrong' }, false)).toEqual({
      endDate: '2026-10-25',
    });
    expect(requestFields('end', false)).toEqual(['endDate', 'requestRemark']);
  });
  it('按实际提交 revision 校验；被裁剪的业务状态不是必需回执字段', () => {
    expect(acceptRequest({ id: row.id, revision: 8 }, row.id, 7)).toMatchObject({ revision: 8 });
    for (const value of [{ id: row.id, revision: 7 }, { id: 'other', revision: 8 }, {}])
      expect(() => acceptRequest(value, row.id, 7)).toThrow();
  });
  it('非发起人 403 是中文拒绝，不进入 unknown；409 走冲突恢复', async () => {
    const store = createFormStore();
    const input = {
      values: {},
      baseline: {},
      editableFields: [],
      revision: 5,
      businessId: row.id,
      send: async (): Promise<{ id: string }> => {
        throw requestError(new ApiError(403, 'FORBIDDEN', 'forbidden', 'denied'));
      },
    };
    const denied = await store.submit('/requests/request-1', input);
    expect(denied.status).toBe('rejected');
    expect(String(denied.error)).toContain('原发起人');
    const conflict = await store.submit('/requests/other', {
      ...input,
      send: async () => {
        throw requestError(new ApiError(409, 'PART_TIME_NOT_EXTENDED', 'conflict', 'conflict'));
      },
    });
    expect(conflict.status).toBe('conflict');
    expect(String(conflict.error)).toContain('新结束日期');
  });
});
describe('AC-FE-R2d2b F-247 单一确认规则', () => {
  it('只对早于原日期的延长单提示；等于、缺键与其他类型不提示', () => {
    expect(shorteningNotice(row)).toBe('新结束日期（2026-10-25）早于原结束日期（2026-10-31），兼职并未延长');
    for (const data of [{ ...row, endDate: row.originalEndDate }, { ...row, kind: 'end' }, { kind: 'extend' }])
      expect(shorteningNotice(data)).toBeUndefined();
  });
  it('审批中心按类型登记，同意取快照日期；其他动作和业务不变', () => {
    const detail = { approvalType: 'part_time_extend', form: { values: row } };
    expect(approvalNotice(detail, 'approve')).toBe(shorteningNotice(row));
    expect(approvalNotice(detail, 'reject')).toBeUndefined();
    expect(approvalNotice({ ...detail, approvalType: 'transfer' }, 'approve')).toBeUndefined();
  });
});
