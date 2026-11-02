/**
 * FE-R2c2b：离职设置页（B64 交接事项、B65 交接发起规则、B68 黑名单与自动加黑规则）的夹具与真实接口一致。
 *   - 冒烟夹具的行 / 设置 / 权限逐键照抄真实返回（exit-settings-fixtures.ts）；
 *   - 页面的请求体（itemBody / ruleBody / triggerBody / batchBody / blacklistQuery）真实接口接受；
 *   - 回执校验器按真实回执形状通过，错版本 / 错对象拒绝；
 *   - 黑名单写能力：管理员全开；人事专员有对象权限但无看全部数据范围，列表为空、写入被拒，页面据此不给写。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  autoBlacklistDefault,
  blacklistEntry,
  blacklistPermission,
  blacklistRemoved,
  blacklistRule,
  deletedReceipt,
  handoverItem,
  revisionConflict,
  triggerDefault,
} from '../../apps/web/smoke/exit-settings-fixtures.js';
import {
  AUTO_BLACKLIST_PATH,
  BLACKLIST_PAGE_SIZE,
  BLACKLIST_PATH,
  BLACKLIST_RULES_PATH,
  HANDOVER_ITEMS_PATH,
  TRIGGER_PATH,
  batchBody,
  blacklistAccess,
  blacklistQuery,
  itemBody,
  parseAutoBlacklist,
  parseBlacklistDeleteReceipt,
  parseBlacklistPage,
  parseDeleteReceipt,
  parseRemoveReceipt,
  parseRowReceipt,
  parseRows,
  parseSettingReceipt,
  parseTrigger,
  rowPath,
  ruleBody,
  ruleValues,
  triggerBody,
  triggerValues,
} from '../../apps/web/src/exit/settings-model.js';
import { employmentSession } from './AC-EMP-support.js';
import { grantMembership } from '@italent/db';
import { newUser, provisioned, seedOperator } from './support/platform-api.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const sortedKeys = (value: object) => Object.keys(value).sort();

async function world(label: string) {
  const db = testDb().db;
  const session = await employmentSession(db, `fe-r2c2b-${label}`);
  const api = tenantApi(db);
  const call = (method: string, path: string, body?: unknown, ifMatch?: number) =>
    api.request(method, path, { tenant: session.tenant.id, user: session.user.id, body, ifMatch });
  return { session, call };
}

describe('AC-FE-R2c2b 交接事项（B64）夹具与真实接口一致', () => {
  it('新增 / 修改 / 删除：行与夹具同键；整份请求体被接受；回执按提交版本 + 1 核对', async () => {
    const { call } = await world('items');
    const create = itemBody({}, { category: ' 行政 ', sequenceNo: 1, todoType: 'work_handover', title: '归还门禁卡' });
    expect(create).toEqual({
      category: '行政',
      sequenceNo: 1,
      todoType: 'work_handover',
      title: '归还门禁卡',
      formRef: null,
      remark: null,
    });
    const created = await call('POST', HANDOVER_ITEMS_PATH, create, 0);
    expect(created.status, await created.clone().text()).toBe(201);
    const row = await created.json();
    expect(sortedKeys(row)).toEqual(sortedKeys(handoverItem));
    expect({ ...row, id: handoverItem.id }).toEqual(handoverItem);
    expect(parseRowReceipt(row, 'item', { revision: 0 })).toEqual({ id: row.id });
    expect(() => parseRowReceipt(row, 'item', { revision: 1 })).toThrow();

    const listed = await (await call('GET', HANDOVER_ITEMS_PATH)).json();
    expect(parseRows(listed, 'item')).toEqual([row]);

    const edit = itemBody(row, { remark: '  合成备注  ', formRef: '' });
    expect(edit).toMatchObject({ remark: '合成备注', formRef: null, category: '行政' });
    const updated = await call('PUT', rowPath(HANDOVER_ITEMS_PATH, row.id), edit, 1);
    expect(updated.status, await updated.clone().text()).toBe(200);
    const receipt = await updated.json();
    expect(parseRowReceipt(receipt, 'item', { id: row.id, revision: 1 })).toEqual({ id: row.id });
    expect(() => parseRowReceipt(receipt, 'item', { id: 'other', revision: 1 })).toThrow();

    const stale = await call('PUT', rowPath(HANDOVER_ITEMS_PATH, row.id), edit, 1);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject(revisionConflict);

    const deleted = await call('DELETE', rowPath(HANDOVER_ITEMS_PATH, row.id), undefined, 2);
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    const gone = await deleted.json();
    expect(gone).toEqual(deletedReceipt(row.id));
    expect(parseDeleteReceipt(gone, row.id)).toEqual({ id: row.id });
  });
});

describe('AC-FE-R2c2b 交接发起规则（B65）与自动加黑总开关', () => {
  it('系统值等于夹具；整份替换的请求体被接受；回执 source=tenant、版本 + 1', async () => {
    const { call } = await world('trigger');
    const read = await (await call('GET', TRIGGER_PATH)).json();
    expect(read).toEqual(triggerDefault);
    const setting = parseTrigger(read);
    const value = triggerBody(triggerValues(setting.value), { method: 'on_node_approved', nodeKey: ' hrbp ' });
    expect(value).toEqual({ ...triggerDefault.value!, method: 'on_node_approved', nodeKey: 'hrbp' });
    const saved = await call('PUT', TRIGGER_PATH, { value }, 0);
    expect(saved.status, await saved.clone().text()).toBe(200);
    const receipt = await saved.json();
    expect(sortedKeys(receipt)).toEqual(sortedKeys(triggerDefault));
    expect(parseSettingReceipt(receipt, 'exit.handover_trigger', 0)).toEqual({ id: 'exit.handover_trigger' });
    expect(() => parseSettingReceipt(receipt, 'exit.handover_trigger', 1)).toThrow();

    // 换成“最后工作日前若干天”：不再带回节点标识（后端结构严格，未知 / 多余键会被拒或残留）。
    const days = triggerBody(triggerValues(parseTrigger(receipt).value), {
      method: 'days_before_last_work_date',
      daysBeforeLastWorkDate: 3,
    });
    expect(days).not.toHaveProperty('nodeKey');
    const again = await call('PUT', TRIGGER_PATH, { value: days }, 1);
    expect(again.status, await again.clone().text()).toBe(200);
    expect((await again.json()).value).toEqual(days);

    const switchRead = await (await call('GET', AUTO_BLACKLIST_PATH)).json();
    expect(switchRead).toEqual(autoBlacklistDefault);
    expect(parseAutoBlacklist(switchRead)).toMatchObject({ value: false, revision: 0 });
    const on = await call('PUT', AUTO_BLACKLIST_PATH, { value: true }, 0);
    expect(on.status, await on.clone().text()).toBe(200);
    expect(parseSettingReceipt(await on.json(), 'exit.auto_blacklist_enabled', 0)).toEqual({
      id: 'exit.auto_blacklist_enabled',
    });
  });
});

describe('AC-FE-R2c2b 自动加黑规则（B68）夹具与真实接口一致', () => {
  it('新增 / 修改 / 删除：行与夹具同键；条件未改时原样带回；回执核对', async () => {
    const { session, call } = await world('rules');
    const org = await session.org('规则组织', { establishedOn: '2025-01-01' });
    const create = ruleBody(
      {},
      { name: '离职三次永久', priority: 1, orgIds: [org.id], exitCount: 3, term: 'permanent', reason: 'instability' },
    );
    const created = await call('POST', BLACKLIST_RULES_PATH, create, 0);
    expect(created.status, await created.clone().text()).toBe(201);
    const row = await created.json();
    expect(sortedKeys(row)).toEqual(sortedKeys(blacklistRule));
    expect({ ...row, id: blacklistRule.id, orgIds: blacklistRule.orgIds }).toEqual(blacklistRule);
    expect(parseRowReceipt(row, 'rule', { revision: 0 })).toEqual({ id: row.id });
    expect(parseRows(await (await call('GET', BLACKLIST_RULES_PATH)).json(), 'rule')).toEqual([row]);

    const values = ruleValues(row);
    expect(values.exitCount).toBe(3);
    const edit = ruleBody(row, { term: 'exit_month' });
    expect(edit.conditions).toEqual(row.conditions);
    const updated = await call('PUT', rowPath(BLACKLIST_RULES_PATH, row.id), edit, 1);
    expect(updated.status, await updated.clone().text()).toBe(200);
    const receipt = await updated.json();
    expect(receipt).toMatchObject({ term: 'exit_month', revision: 2 });
    expect(parseRowReceipt(receipt, 'rule', { id: row.id, revision: 1 })).toEqual({ id: row.id });

    const recount = ruleBody(receipt, { exitCount: 5 });
    expect(recount.conditions).toEqual([{ field: 'exitCount', operator: 'gte', value: 5 }]);
    expect((await call('PUT', rowPath(BLACKLIST_RULES_PATH, row.id), recount, 2)).status).toBe(200);

    const deleted = await call('DELETE', rowPath(BLACKLIST_RULES_PATH, row.id), undefined, 3);
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(parseDeleteReceipt(await deleted.json(), row.id)).toEqual({ id: row.id });
  });
});

describe('AC-FE-R2c2b 黑名单（B68）夹具与真实接口一致', () => {
  it('手工加黑 / 编辑 / 移出 / 删除：行与夹具同键；分页查询串被接受；回执核对', async () => {
    const { call } = await world('blacklist');
    const created = await call(
      'POST',
      BLACKLIST_PATH,
      { name: '外部人员甲', mobilePhone: '13800000001', reason: 'other' },
      0,
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const row = await created.json();
    expect(sortedKeys(row)).toEqual(sortedKeys(blacklistEntry));
    expect({ ...row, id: blacklistEntry.id, blacklistDate: blacklistEntry.blacklistDate }).toEqual(blacklistEntry);
    expect(parseRowReceipt(row, 'blacklist', { revision: 0 })).toEqual({ id: row.id });

    const everything = () => true;
    const query = blacklistQuery({ status: 'active', name: ' 外部 ' }, 1, everything);
    const listed = await call('GET', query);
    expect(listed.status, await listed.clone().text()).toBe(200);
    const page = await listed.json();
    expect(sortedKeys(page)).toEqual(['hasDataPermission', 'items', 'page', 'pageSize']);
    expect(page).toMatchObject({ page: 1, pageSize: BLACKLIST_PAGE_SIZE, hasDataPermission: true });
    expect(parseBlacklistPage(page, 1)).toMatchObject({ items: [row], hasNext: false });
    expect(() => parseBlacklistPage(page, 2)).toThrow();

    const edited = await call('PUT', rowPath(BLACKLIST_PATH, row.id), { note: '合成说明' }, 1);
    expect(edited.status, await edited.clone().text()).toBe(200);
    const receipt = await edited.json();
    expect(parseRowReceipt(receipt, 'blacklist', { id: row.id, revision: 1 })).toEqual({ id: row.id });

    const removed = await call('POST', `${BLACKLIST_PATH}/remove`, batchBody(row.id, 2));
    expect(removed.status, await removed.clone().text()).toBe(200);
    const removal = await removed.json();
    expect(removal.items[0]).toMatchObject({ id: row.id, status: 'removed', revision: 3 });
    expect(sortedKeys(removal.items[0])).toEqual(sortedKeys(blacklistEntry));
    expect(parseRemoveReceipt(removal, { id: row.id, revision: 2 })).toEqual({ id: row.id });
    expect(() => parseRemoveReceipt(removal, { id: row.id, revision: 3 })).toThrow();
    const removedPage = await (await call('GET', blacklistQuery({ status: 'removed' }, 1, everything))).json();
    expect(parseBlacklistPage(removedPage, 1).items.map((item) => item.id)).toEqual([row.id]);
    const editRemoved = await call('PUT', rowPath(BLACKLIST_PATH, row.id), { note: '已移出' }, 3);
    expect(editRemoved.status).toBe(409);
    expect(await editRemoved.json()).toMatchObject(blacklistRemoved);

    const deleted = await call('POST', `${BLACKLIST_PATH}/delete`, batchBody(row.id, 3));
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    const gone = await deleted.json();
    expect(gone).toEqual({ deleted: 1 });
    expect(parseBlacklistDeleteReceipt(gone, row.id)).toEqual({ id: row.id });
  });

  it('权限：管理员对象权限等于夹具且全部可写；人事专员列表为空、写入被拒，页面不给写', async () => {
    const { db } = testDb();
    const api = tenantApi(db, { authorize: undefined, clock: () => new Date('2026-10-01T04:00:00Z') });
    const admin = await newUser(db, 'fe-r2c2b-admin');
    const result = await provisioned(api, await seedOperator(db), {
      firstAdminUserId: admin.id,
      exceptionAdminUserId: admin.id,
    });
    const asAdmin = { user: admin.id, tenant: result.tenant.id };
    const specialist = await newUser(db, 'fe-r2c2b-specialist');
    await grantMembership(db, { tenantId: result.tenant.id, userId: specialist.id, expectedRevision: 0 }, cmd());
    const profile = result.profiles.find((p) => p.code === 'standard_hr_specialist')!;
    const granted = await api.request('POST', '/api/tenant/permission/grants', {
      ...asAdmin,
      body: { userId: specialist.id, profileId: profile.id },
    });
    expect(granted.status, await granted.clone().text()).toBe(201);
    const asSpecialist = { user: specialist.id, tenant: result.tenant.id };
    const objectPath = `/api/tenant/permission/me/objects/${encodeURIComponent(blacklistPermission.objectCode)}`;

    const adminPermission = await (await api.request('GET', objectPath, asAdmin)).json();
    expect(adminPermission).toEqual(blacklistPermission);
    const adminPage = await (await api.request('GET', BLACKLIST_PATH, asAdmin)).json();
    expect(blacklistAccess(adminPermission, adminPage.hasDataPermission)).toMatchObject({
      create: true,
      updateFields: ['reason', 'expiryDate', 'note'],
      remove: true,
      delete: true,
    });

    const specialistResponse = await api.request('GET', objectPath, asSpecialist);
    const specialistPermission = specialistResponse.status === 200 ? await specialistResponse.json() : undefined;
    const specialistPage = await (await api.request('GET', BLACKLIST_PATH, asSpecialist)).json();
    expect(specialistPage).toMatchObject({ items: [], hasDataPermission: false });
    expect(blacklistAccess(specialistPermission, specialistPage.hasDataPermission)).toMatchObject({
      create: false,
      updateFields: [],
      remove: false,
      delete: false,
    });
    const denied = await api.request('POST', BLACKLIST_PATH, {
      ...asSpecialist,
      body: { name: '专员加黑', mobilePhone: '13800000061', reason: 'other' },
      ifMatch: 0,
    });
    expect(denied.status).toBe(403);
  });
});
