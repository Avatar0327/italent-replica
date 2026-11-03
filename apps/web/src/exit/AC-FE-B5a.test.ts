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
  it('AC-FE-B5a F-393 三项各按响应键存在展示，与加入黑名单的可见值无关', () => {
    for (const addToBlacklist of [true, false]) {
      expect(model.detailKeys({ ...detail, addToBlacklist })).toEqual(
        expect.arrayContaining(['addToBlacklist', ...model.blacklistFields]),
      );
    }
    for (const hidden of model.blacklistFields) {
      const projected = { ...detail };
      delete projected[hidden];
      expect(model.detailKeys(projected)).not.toContain(hidden);
      expect(model.detailValues(projected)).not.toHaveProperty(hidden);
    }
  });
  it('AC-FE-B5a F-393 无 addToBlacklist 查看权：三项真实值仍展示，编辑初值不补造总开关', () => {
    const projected = { ...detail };
    delete projected.addToBlacklist;
    const baseline = model.detailValues(projected);
    expect(model.detailKeys(projected)).toEqual(expect.arrayContaining(model.blacklistFields));
    expect(model.cellValue(projected, 'blacklistExpiryDate')).toBe('2027-12-31');
    expect(model.cellValue(projected, 'blacklistReason')).toBe('诚信问题');
    expect(model.cellValue(projected, 'blacklistNote')).toBe('合成说明');
    expect(baseline).toMatchObject({
      blacklistExpiryDate: '2027-12-31',
      blacklistReason: 'integrity',
      blacklistNote: '合成说明',
    });
    expect(baseline).not.toHaveProperty('addToBlacklist');
    expect(model.patchBody({ blacklistNote: '新的合成说明' }, {}, baseline)).toEqual({
      blacklistNote: '新的合成说明',
    });
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

/** 形态对照 exit-actions.ts：actions 随列表条目 / 详情下发（F-352①）；按钮权已含在内，前端不再推导。 */
const order: model.Row = {
  id: 'exit-1',
  employeeId: 'employee-1',
  status: 'in_review',
  mode: 'application',
  revision: 2,
};

describe('AC-FE-B5a F-352① 详情 / 行内入口读服务端 actions', () => {
  it('详情按钮 = 服务端 actions 里的 submit / edit / cancel，与状态、权限快照无关', () => {
    const all = { ...order, actions: ['submit', 'edit', 'cancel'] };
    expect(model.detailEntries(all)).toEqual(['submit', 'edit', 'cancel']);
    expect(model.detailEntries({ ...order, status: 'voided', actions: ['edit'] })).toEqual(['edit']);
    expect(model.detailEntries({ ...order, actions: ['cancel'] })).toEqual(['cancel']);
  });
  it('没有 actions（状态字段被裁剪时服务端不下发）或为空：不给任何写入口；未知码与列表专属的 handle 不进详情', () => {
    expect(model.detailEntries(order)).toEqual([]);
    expect(model.detailEntries({ ...order, actions: [] })).toEqual([]);
    expect(model.detailEntries({ ...order, actions: ['handle', 'restore', 'edit'] })).toEqual(['edit']);
  });
  it('单据标识无效时即使服务端给了动作也不开写入口', () => {
    expect(model.detailEntries({ ...order, revision: undefined, actions: ['edit'] })).toEqual([]);
  });
  it('行内“离职处理”只认 actions 里的 handle（不再按状态 + 直接离职按钮推导）', () => {
    const settled = { ...order, status: 'voided' };
    expect(model.rowEntries(settled)).toEqual([]);
    expect(model.rowEntries({ ...settled, actions: ['handle'] })).toEqual(['handle']);
    expect(model.rowEntries({ ...order, actions: ['handle'] })).toEqual(['handle']);
    expect(model.rowEntries({ ...settled, employeeId: undefined, actions: ['handle'] })).toEqual([]);
  });
});
