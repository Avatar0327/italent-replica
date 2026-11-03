import { describe, expect, it } from 'vitest';
import type { ObjectPermission } from '../foundation/permission-model.js';
import * as model from './exit-model.js';

/** 形态对照 exit-queries.ts exitDetailPayload（F-393 起带加黑三项）。 */
const detail: model.Row = {
  id: 'exit-1',
  employeeId: 'employee-1',
  name: '合成员工',
  status: 'approved',
  mode: 'application',
  revision: 2,
  lastWorkDate: '2026-11-30',
  addToBlacklist: true,
  blacklistExpiryDate: '2027-12-31',
  blacklistReason: 'integrity',
  blacklistNote: '合成说明',
};
const permission: ObjectPermission = {
  objectCode: model.object,
  dataOperations: { create: true, update: true },
  buttons: [],
  viewableFields: [...model.formFields],
  editableFields: [...model.formFields],
};

describe('AC-FE-B5a F-394 离职状态中文映射', () => {
  it('后端全部状态（含 deleted）都有中文，不回显英文编码', () => {
    const states: Record<string, string> = {
      draft: '草稿',
      in_review: '审批中',
      approved: '审批通过',
      rejected: '已驳回',
      disapproved: '审批拒绝',
      effective: '已生效',
      cancelled: '已撤销',
      withdrawn: '已撤回',
      voided: '已作废',
      deleted: '已删除',
    };
    for (const [status, label] of Object.entries(states))
      expect(model.cellValue({ id: 'e', status }, 'status'), status).toBe(label);
  });
});

describe('AC-FE-B5a F-393 详情加黑三项展示与编辑', () => {
  it('加黑单的详情列出加入黑名单与三项；未加黑只列“加入黑名单”', () => {
    const keys = model.detailKeys(detail);
    expect(keys).toEqual(expect.arrayContaining(['addToBlacklist', ...model.blacklistFields]));
    const plain = model.detailKeys({ ...detail, addToBlacklist: false });
    expect(plain).toContain('addToBlacklist');
    for (const field of model.blacklistFields) expect(plain, field).not.toContain(field);
  });
  it('三项按真实数据取值：原因显示字典名，截止日期为空显示“永久”，缺键（无字段权）显示占位', () => {
    expect(model.cellValue(detail, 'addToBlacklist')).toBe('是');
    expect(model.cellValue(detail, 'blacklistReason')).toBe('诚信问题');
    expect(model.cellValue(detail, 'blacklistExpiryDate')).toBe('2027-12-31');
    expect(model.cellValue(detail, 'blacklistNote')).toBe('合成说明');
    expect(model.cellValue({ ...detail, blacklistExpiryDate: null }, 'blacklistExpiryDate')).toBe('永久');
    const { blacklistReason: _hidden, ...trimmed } = detail;
    expect(model.cellValue(trimmed, 'blacklistReason')).toBe(model.cellValue({ id: 'e' }, 'blacklistReason'));
    expect(model.cellValue({ ...detail, addToBlacklist: false }, 'addToBlacklist')).toBe('否');
  });
  it('编辑基线取详情的真实三项；只改日期时 PATCH 不带加黑字段，改动加黑原因时只带被改的项', () => {
    const baseline = model.detailValues(detail);
    expect(baseline).toMatchObject({
      addToBlacklist: true,
      blacklistExpiryDate: '2027-12-31',
      blacklistReason: 'integrity',
      blacklistNote: '合成说明',
    });
    const dateOnly = { ...baseline, lastWorkDate: '2026-12-10' };
    expect(() => model.validateExit(dateOnly, model.editableFields(permission, 'update'), baseline)).not.toThrow();
    expect(model.patchBody({ lastWorkDate: '2026-12-10' }, {}, dateOnly)).toEqual({ lastWorkDate: '2026-12-10' });
    const reasonChanged = { ...baseline, blacklistReason: 'instability' };
    expect(model.blackGroupKept(reasonChanged, baseline)).toBe(false);
    expect(model.patchBody({ blacklistReason: 'instability' }, {}, reasonChanged)).toEqual({
      blacklistReason: 'instability',
    });
  });
});
