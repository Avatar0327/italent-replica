/**
 * AC-360-13（DEC-027、DEC-280）：360 身份（系统 / 高级 / 一般）由企业管理员在“用户授权”里授予；高级与一般管理员
 * 只能看到自己创建或被授权的活动；未授权活动的任何读写一律 404，不泄露是否存在；没有 360 身份一律 403。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { type ActivityView, world360 } from './AC-360-support.js';

const testDb = useTestDb();

describe('AC-360-13 一般管理员查看未被授权的活动', () => {
  it('列表不含、详情与子资源 404、写入 404 且数据不变；授权后可见', async () => {
    const w = await world360(testDb().db, 'a13');
    const general = await w.member('一般管理员');
    await w.appoint(general, 'general');
    const own = await w.activity({ name: '自建活动' }, general);
    const hidden = await w.activity({ name: '未授权活动' });
    const g = w.as(general);
    const list = await w.ok<{ items: ActivityView[] }>(g('GET', '/activities'));
    expect(list.items.map((a) => a.id)).toEqual([own.id]);
    expect((await g('GET', `/activities/${hidden.id}`)).status).toBe(404);
    expect((await g('GET', `/activities/${hidden.id}/objects`)).status).toBe(404);
    const before = await w.getActivity(hidden.id);
    const put = await g('PUT', `/activities/${hidden.id}`, { ifMatch: before.revision, body: { name: '篡改' } });
    expect(put.status).toBe(404);
    const enable = await g('POST', `/activities/${hidden.id}/enable`, { ifMatch: before.revision });
    expect(enable.status).toBe(404);
    const person = await w.person('对象');
    const add = await g('POST', `/activities/${hidden.id}/objects`, {
      ifMatch: 0,
      body: { personId: person.id, questionnaireIds: [] },
    });
    expect(add.status).toBe(404);
    expect(await w.getActivity(hidden.id)).toEqual(before);
    expect((await w.ok<{ items: unknown[] }>(w.request('GET', `/activities/${hidden.id}/objects`))).items).toEqual([]);

    await w.ok(
      w.request('POST', `/activities/${hidden.id}/grants`, { ifMatch: before.revision, body: { userIds: [general] } }),
    );
    expect((await g('GET', `/activities/${hidden.id}`)).status).toBe(200);
    const granted = await w.ok<{ items: ActivityView[] }>(g('GET', '/activities'));
    expect(granted.items.map((a) => a.id).sort()).toEqual([own.id, hidden.id].sort());
  });

  it('高级管理员同样只见自己创建或被授权的活动；撤销用户授权后失去访问（403）', async () => {
    const w = await world360(testDb().db, 'a13b');
    const advanced = await w.member('高级管理员');
    const grant = await w.appoint(advanced, 'advanced');
    const activity = await w.activity();
    const own = await w.activity({ name: '高级自建' }, advanced);
    const a = w.as(advanced);
    expect((await a('GET', `/activities/${activity.id}`)).status).toBe(404);
    expect((await w.ok<{ items: ActivityView[] }>(a('GET', '/activities'))).items.map((x) => x.id)).toEqual([own.id]);
    const outsider = await w.member('其他成员');
    expect((await w.as(outsider)('GET', '/activities')).status).toBe(403);
    await w.revokeGrant(grant);
    expect((await a('GET', `/activities/${own.id}`)).status).toBe(403);
    expect((await a('GET', '/activities')).status).toBe(403);
  });

  it('没有 360 身份的成员看不到人员、套卷、角色与设置（403）', async () => {
    const w = await world360(testDb().db, 'a13c');
    const outsider = await w.member('成员');
    for (const path of ['/people', '/questionnaires', '/roles', '/settings']) {
      expect((await w.as(outsider)('GET', path)).status, path).toBe(403);
    }
  });
});
