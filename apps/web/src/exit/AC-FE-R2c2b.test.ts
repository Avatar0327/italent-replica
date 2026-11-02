// FE-R2c2b 离职设置页纯规则：形状校验（裁剪键允许缺失）、回执、写能力 fail-closed、查询串、分组、请求体。
import { HANDOVER_TRIGGER_DEFAULT } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import {
  blacklistEntry,
  blacklistPermission,
  blacklistRule,
  handoverItem,
} from '../../smoke/exit-settings-fixtures.js';
import { settingsPermission } from '../../smoke/exit-fixtures.js';
import type { MenuNode } from '../foundation/permission-snapshot.js';
import type { ObjectPermission } from '../foundation/permission-model.js';
import * as model from './settings-model.js';

const menus = (editable: boolean): MenuNode[] => [
  {
    key: 'settings',
    label: '企业设置',
    path: '/settings',
    group: 'settings',
    children: [{ key: 'other.mou_settings', label: '', path: '', group: 'settings', editable }],
  },
];
const without = (permission: ObjectPermission, field: string): ObjectPermission => ({
  ...permission,
  editableFields: permission.editableFields.filter((code) => code !== field),
});

describe('列表与回执形状', () => {
  it('被裁剪的键允许缺失；出现的键类型必须正确；id / revision 必须有', () => {
    const { remark: _remark, formRef: _formRef, ...trimmed } = handoverItem;
    expect(model.parseRows({ items: [handoverItem, { ...trimmed, id: 'b' }] }, 'item')).toHaveLength(2);
    expect(() => model.parseRows({ items: [{ ...handoverItem, sequenceNo: '1' }] }, 'item')).toThrow();
    expect(() => model.parseRows({ items: [{ ...handoverItem, todoType: 'unknown' }] }, 'item')).toThrow();
    expect(() => model.parseRows({ items: [{ ...handoverItem, revision: 0 }] }, 'item')).toThrow();
    expect(() => model.parseRows({ items: [{ ...blacklistRule, conditions: [{ field: 'age' }] }] }, 'rule')).toThrow();
    expect(() => model.parseRows({ rows: [] }, 'item')).toThrow();
    expect(model.parseRows({ items: [blacklistEntry] }, 'blacklist')).toEqual([blacklistEntry]);
  });

  it('回执：版本 = 提交版本 + 1，修改须是本行；删除回执须是本行且 deleted=true', () => {
    expect(model.parseRowReceipt(handoverItem, 'item', { revision: 0 })).toEqual({ id: handoverItem.id });
    expect(() => model.parseRowReceipt(handoverItem, 'item', { revision: 1 })).toThrow();
    expect(() => model.parseRowReceipt(handoverItem, 'item', { id: 'other', revision: 0 })).toThrow();
    expect(() => model.parseDeleteReceipt({ id: 'a', deleted: false }, 'a')).toThrow();
    expect(() => model.parseDeleteReceipt({ id: 'b', deleted: true }, 'a')).toThrow();
    expect(model.parseDeleteReceipt({ id: 'a', deleted: true }, 'a')).toEqual({ id: 'a' });
  });

  it('移出回执：单条、本行、版本 + 1，状态出现时须为已移出；删除回执 deleted=1', () => {
    const removed = { ...blacklistEntry, status: 'removed', revision: 2 };
    expect(model.parseRemoveReceipt({ items: [removed] }, { id: removed.id, revision: 1 })).toEqual({
      id: removed.id,
    });
    expect(() => model.parseRemoveReceipt({ items: [removed, removed] }, { id: removed.id, revision: 1 })).toThrow();
    expect(() =>
      model.parseRemoveReceipt({ items: [{ ...removed, status: 'active' }] }, { id: removed.id, revision: 1 }),
    ).toThrow();
    const { status: _status, ...trimmed } = removed;
    expect(model.parseRemoveReceipt({ items: [trimmed] }, { id: removed.id, revision: 1 })).toEqual({
      id: removed.id,
    });
    expect(() => model.parseBlacklistDeleteReceipt({ deleted: 0 }, 'a')).toThrow();
    expect(model.parseBlacklistDeleteReceipt({ deleted: 1 }, 'a')).toEqual({ id: 'a' });
  });
});

describe('黑名单列表：筛选与分页不串数据', () => {
  it('不可查看的字段、空白值不进查询串；页长固定', () => {
    const viewable = (field: string) => field !== 'idNumber';
    const path = model.blacklistQuery(
      { status: 'removed', name: ' 张 ', idNumber: 'ID-1', mobilePhone: '  ', source: 'manual' },
      3,
      viewable,
    );
    const query = new URL(path, 'http://x').searchParams;
    expect(Object.fromEntries(query)).toEqual({
      status: 'removed',
      name: '张',
      source: 'manual',
      page: '3',
      pageSize: String(model.BLACKLIST_PAGE_SIZE),
    });
  });

  it('回显的页码 / 页长与本次请求不一致按读取失败；满页才有下一页', () => {
    const size = model.BLACKLIST_PAGE_SIZE;
    const full = Array.from({ length: size }, (_, i) => ({ ...blacklistEntry, id: `e-${i}` }));
    const page = { items: full, page: 2, pageSize: size, hasDataPermission: true };
    expect(model.parseBlacklistPage(page, 2)).toMatchObject({ hasNext: true, hasDataPermission: true });
    expect(model.parseBlacklistPage({ ...page, items: full.slice(1) }, 2).hasNext).toBe(false);
    expect(() => model.parseBlacklistPage(page, 1)).toThrow();
    expect(() => model.parseBlacklistPage({ ...page, pageSize: 50 }, 2)).toThrow();
    expect(() => model.parseBlacklistPage({ items: [], page: 2, pageSize: size }, 2)).toThrow();
  });
});

describe('写能力 fail-closed', () => {
  it('黑名单：管理员全开；缺按钮 / 数据操作 / 字段编辑权 / 看全部范围时逐项收回', () => {
    expect(model.blacklistAccess(blacklistPermission, true)).toMatchObject({
      create: true,
      updateFields: ['reason', 'expiryDate', 'note'],
      remove: true,
      delete: true,
    });
    const none = { create: false, createFields: [], updateFields: [], remove: false, delete: false };
    expect(model.blacklistAccess(blacklistPermission, false)).toMatchObject(none);
    expect(model.blacklistAccess(undefined, true)).toMatchObject(none);
    expect(model.blacklistAccess({ ...blacklistPermission, summary: true }, true)).toMatchObject(none);
    const noDelete = { ...blacklistPermission, dataOperations: { create: true, update: true, delete: false } };
    expect(model.blacklistAccess(noDelete, true)).toMatchObject({ delete: false, remove: true });
    const noRowButton = {
      ...blacklistPermission,
      buttons: blacklistPermission.buttons.filter((button) => button.level !== 'list_row'),
    };
    expect(model.blacklistAccess(noRowButton, true).updateFields).toEqual([]);
    expect(model.blacklistAccess(without(blacklistPermission, 'note'), true).updateFields).toEqual([
      'reason',
      'expiryDate',
    ]);
    expect(model.blacklistAccess(without(blacklistPermission, 'reason'), true).create).toBe(false);
    const noIdentity = ['idNumber', 'mobilePhone', 'email'].reduce(without, blacklistPermission);
    expect(model.blacklistAccess(noIdentity, true).create).toBe(false);
  });

  it('交接事项 / 规则：须其他设置菜单可编辑、全部字段可改；新增看 create，修改删除看 update', () => {
    const fields = model.HANDOVER_ITEM_FIELDS;
    expect(model.configAccess(settingsPermission, menus(true), fields)).toEqual({ create: true, update: true });
    expect(model.configAccess(settingsPermission, menus(false), fields)).toEqual({ create: false, update: false });
    expect(model.configAccess(settingsPermission, [], fields)).toEqual({ create: false, update: false });
    expect(model.configAccess(undefined, menus(true), fields)).toEqual({ create: false, update: false });
    expect(model.configAccess(without(settingsPermission, 'remark'), menus(true), fields)).toEqual({
      create: false,
      update: false,
    });
    const readOnly = { ...settingsPermission, dataOperations: { create: false, update: true, delete: false } };
    expect(model.configAccess(readOnly, menus(true), model.RULE_FIELDS)).toEqual({ create: false, update: true });
  });
});

describe('请求体', () => {
  it('交接事项：未改项取最新全量；空白可选文本提交 null', () => {
    expect(model.itemBody(handoverItem, { title: ' 交还电脑 ', remark: '  ' })).toEqual({
      category: '行政',
      sequenceNo: 1,
      todoType: 'work_handover',
      title: '交还电脑',
      formRef: null,
      remark: null,
    });
  });

  it('规则：没改离职次数时原样带回条件（含多条）；改了按一条提交', () => {
    const multi = {
      ...blacklistRule,
      conditions: [...blacklistRule.conditions, { field: 'exitCount', operator: 'gte', value: 9 }],
    };
    expect(model.ruleBody(multi, { name: '新名称' }).conditions).toEqual(multi.conditions);
    expect(model.ruleBody(multi, { exitCount: 4 }).conditions).toEqual([
      { field: 'exitCount', operator: 'gte', value: 4 },
    ]);
    expect(model.ruleValues(blacklistRule).exitCount).toBe(3);
    expect(model.ruleBody(blacklistRule, { description: ' ' }).description).toBeNull();
  });

  it('交接发起规则：只带与发起方式相关的可选键；发起人固定员工本人；按事项类别分组', () => {
    const values = model.triggerValues(HANDOVER_TRIGGER_DEFAULT);
    expect(model.triggerBody(values, {})).toEqual(HANDOVER_TRIGGER_DEFAULT);
    const node = model.triggerBody(
      { ...values, daysBeforeLastWorkDate: 7 },
      { method: 'on_node_approved', nodeKey: 'n1' },
    );
    expect(node).toMatchObject({ method: 'on_node_approved', nodeKey: 'n1', initiator: 'self' });
    expect(node).not.toHaveProperty('daysBeforeLastWorkDate');
    const days = model.triggerBody(
      { ...values, nodeKey: 'n1' },
      { method: 'days_before_last_work_date', daysBeforeLastWorkDate: 2 },
    );
    expect(days).toMatchObject({ daysBeforeLastWorkDate: 2 });
    expect(days).not.toHaveProperty('nodeKey');
    expect(model.triggerBody(values, { remindEnabled: false, remindAfter: 30 }).remind).toEqual({
      enabled: false,
      daysBeforeLastWorkDate: 5,
      daysAfterLastWorkDate: 30,
    });

    const { category: _category, ...trimmed } = handoverItem;
    const groups = model.groupByCategory([
      { ...handoverItem, id: 'a', category: '行政' },
      { ...handoverItem, id: 'b', category: 'IT' },
      { ...handoverItem, id: 'c', category: '行政' },
      { ...trimmed, id: 'd' },
    ]);
    expect(groups.map((group) => [group.category, group.items.map((row) => row.id)])).toEqual([
      ['行政', ['a', 'c']],
      ['IT', ['b']],
      ['—', ['d']],
    ]);
  });

  it('设置读取：形态不对按读取失败，不当作默认值', () => {
    const setting = {
      key: 'exit.handover_trigger',
      value: HANDOVER_TRIGGER_DEFAULT,
      source: 'system',
      revision: 0,
      systemVersion: 1,
      overridable: true,
    };
    expect(model.parseTrigger(setting).value).toEqual(HANDOVER_TRIGGER_DEFAULT);
    expect(() => model.parseTrigger({ ...setting, value: { ...HANDOVER_TRIGGER_DEFAULT, extra: 1 } })).toThrow();
    expect(() => model.parseTrigger({ ...setting, key: 'other' })).toThrow();
    expect(() => model.parseAutoBlacklist({ ...setting, key: 'exit.auto_blacklist_enabled', value: 'yes' })).toThrow();
    // 回执须是租户覆盖
    expect(() => model.parseSettingReceipt({ ...setting, revision: 1 }, 'exit.handover_trigger', 0)).toThrow();
    expect(
      model.parseSettingReceipt({ ...setting, source: 'tenant', revision: 1 }, 'exit.handover_trigger', 0),
    ).toEqual({ id: 'exit.handover_trigger' });
  });
});
