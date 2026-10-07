/**
 * AC-360-13（DEC-027）：360 独立管理员身份（系统 / 高级 / 一般）与活动授权。一般管理员只能看到自己持有或被授权的
 * 活动；未授权活动的任何读写一律 404，不泄露是否存在；非 360 管理员一律 403。
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
      w.request('PUT', `/activities/${hidden.id}/grants`, { ifMatch: before.revision, body: { userIds: [general] } }),
    );
    expect((await g('GET', `/activities/${hidden.id}`)).status).toBe(200);
    const granted = await w.ok<{ items: ActivityView[] }>(g('GET', '/activities'));
    expect(granted.items.map((a) => a.id).sort()).toEqual([own.id, hidden.id].sort());
  });

  it('高级管理员可见全部活动；一般管理员不能指定管理员；撤销身份后失去访问', async () => {
    const w = await world360(testDb().db, 'a13b');
    const advanced = await w.member('高级管理员');
    const general = await w.member('一般管理员');
    const adv = await w.appoint(advanced, 'advanced');
    await w.appoint(general, 'general');
    const activity = await w.activity();
    expect((await w.as(advanced)('GET', `/activities/${activity.id}`)).status).toBe(200);
    const outsider = await w.member('其他成员');
    const appoint = await w.as(general)('POST', '/admins', { ifMatch: 0, body: { userId: outsider, role: 'system' } });
    expect(appoint.status).toBe(403);
    expect((await w.as(outsider)('GET', '/activities')).status).toBe(403);
    const revoked = await w.request('DELETE', `/admins/${adv.id}`, { ifMatch: adv.revision });
    expect(revoked.status).toBe(200);
    expect((await w.as(advanced)('GET', `/activities/${activity.id}`)).status).toBe(403);
    const me = await w.ok<{ role: string | null }>(w.as(outsider)('GET', '/me'));
    expect(me.role).toBeNull();
  });

  it('非 360 管理员看不到人员、套卷与角色（403）', async () => {
    const w = await world360(testDb().db, 'a13c');
    const outsider = await w.member('成员');
    for (const path of ['/people', '/questionnaires', '/roles', '/admins']) {
      expect((await w.as(outsider)('GET', path)).status, path).toBe(403);
    }
  });
});
