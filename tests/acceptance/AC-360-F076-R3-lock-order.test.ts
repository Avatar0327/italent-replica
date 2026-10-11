/**
 * AC-360-F076-R3（F-076 PR-2a 第 2 轮审查 P2，#234）：评价关系增删的全局取锁顺序（设计 §3.5.1）——
 * 活动行 → 确认单 / 评价对象 / 评价关系行 → 评价者 × 活动的链接锁 → 写关系、链接、活动标记。
 * 用真实路由（上级确认入口、管理端）交错：新增 × 删除不死锁（不再 40P01 → 409），删除最后一条关系 × 新增、
 * 两个入口删除最后两条关系，都在同一保护范围内决定保留 / 作废 / 新建链接（第 1 轮 P2-1 的效果保留）。
 * 交错点用测试钩子停住，另一个请求以 pg_stat_activity 的实际锁等待（或已经完成）为屏障，不按固定延时猜。
 * 真 PG 用例在 PGlite 单连接下无法并发，只在设了 TEST_DATABASE_URL 时运行。
 */
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { linkHooks } from '../../apps/api/src/modules/survey360/links.js';
import { linkRows, resetCredentialConfig } from './AC-360-F076-support.js';
import { issuedScene, login } from './AC-360-F076-portal-support.js';
import { blockedOrSettled, gate } from './AC-360-F076-lock-barrier.js';

const realPostgres = Boolean(process.env.TEST_DATABASE_URL);
const testDb = useTestDb();
afterEach(() => {
  resetCredentialConfig();
  linkHooks.afterLock = undefined;
  linkHooks.afterTaskCheck = undefined;
});

type Scene = Awaited<ReturnType<typeof issuedScene>>;

/** 评价对象 A（场景自带，P1 是其同事评价者）与 B（同事二），两个都邀请直线经理确认；返回两张确认页的调用器。 */
async function twoConfirmations({ s, w }: Scene) {
  const second = await w.object(s.activity.id, s.person.P2.id, [s.q.id]);
  const confirmOf = async (objectId: string) => {
    const res = await w.request('POST', `${s.path}/objects/${objectId}/confirmation`, { ifMatch: 0, body: {} });
    expect(res.status, await res.clone().text()).toBe(201);
    const call = w.link(await w.token(s.activity.id, s.person.M.id, 'survey360.confirm_invitation'));
    const revision = async () => (await w.ok<{ revision: number }>(call('GET', ''))).revision;
    return {
      add: async (personId: string) =>
        call('POST', '/confirmation/appraisers', {
          ifMatch: await revision(),
          body: { personId, roleId: w.role('peer') },
        }),
      remove: async (relationId: string) =>
        call('DELETE', `/confirmation/appraisers/${relationId}`, { ifMatch: await revision() }),
    };
  };
  return { second, a: await confirmOf(s.object.id), b: await confirmOf(second.id) };
}

const linksOf = async ({ s, w }: Scene, personId: string) =>
  (await linkRows(w, s.activity.id)).filter((l) => l.person_id === personId);

describe.skipIf(!realPostgres)('AC-360-F076-R3 上级确认入口：新增 × 删除（真 PG，真实路由）', () => {
  it('B 页新增甲（持有链接锁未提交）时 A 页删除甲原有关系：两者都成功（201 / 200，不再 409），链接保留', async () => {
    const scene = await issuedScene(testDb().db, 'f076-r3-a');
    const { a, b } = await twoConfirmations(scene);
    const p1 = scene.s.person.P1.id;
    const held = gate();
    linkHooks.afterLock = async () => {
      linkHooks.afterLock = undefined;
      held.reached();
      await held.wait;
    };
    const adding = b.add(p1);
    await held.arrived;
    const removing = a.remove(scene.s.rel.p1.id);
    await blockedOrSettled(scene.w.db, removing);
    held.release();
    const [added, removed] = await Promise.all([adding, removing]);
    expect(added.status, await added.clone().text()).toBe(201);
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect((await linksOf(scene, p1)).map((l) => l.revoked)).toEqual([false]);
    const cred = scene.creds.get(p1)!;
    expect((await login(scene.w, cred.serial, cred.password)).status).toBe(201);
  });

  it('A 页删除甲最后一条关系（已判定无剩余、未作废）时 B 页新增甲：最终恰好一条可用链接，且是新链接', async () => {
    const scene = await issuedScene(testDb().db, 'f076-r3-b');
    const { a, b } = await twoConfirmations(scene);
    const p1 = scene.s.person.P1.id;
    const held = gate();
    linkHooks.afterTaskCheck = async () => {
      linkHooks.afterTaskCheck = undefined;
      held.reached();
      await held.wait;
    };
    const removing = a.remove(scene.s.rel.p1.id);
    await held.arrived;
    const adding = b.add(p1);
    await blockedOrSettled(scene.w.db, adding);
    held.release();
    const [removed, added] = await Promise.all([removing, adding]);
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(added.status, await added.clone().text()).toBe(201);
    const links = await linksOf(scene, p1);
    expect(links.map((l) => l.revoked)).toEqual([true, false]);
    const old = scene.creds.get(p1)!;
    expect(links[1]!.id).not.toBe(old.linkId);
    expect((await login(scene.w, old.serial, old.password)).status).toBe(401);
  });

  it('A、B 两页同时删除甲最后两条关系：两者都成功，链接必被作废', async () => {
    const scene = await issuedScene(testDb().db, 'f076-r3-c');
    const { a, b, second } = await twoConfirmations(scene);
    const p1 = scene.s.person.P1.id;
    const extra = await b.add(p1);
    expect(extra.status, await extra.clone().text()).toBe(201);
    const other = (await extra.json()) as { id: string };
    expect(second.id).toBeTruthy();
    const held = gate();
    linkHooks.afterLock = async () => {
      linkHooks.afterLock = undefined;
      held.reached();
      await held.wait;
    };
    const first = a.remove(scene.s.rel.p1.id);
    await held.arrived;
    const later = b.remove(other.id);
    await blockedOrSettled(scene.w.db, later);
    held.release();
    const [one, two] = await Promise.all([first, later]);
    expect(one.status, await one.clone().text()).toBe(200);
    expect(two.status, await two.clone().text()).toBe(200);
    expect((await linksOf(scene, p1)).map((l) => l.revoked)).toEqual([true]);
  });
});

describe.skipIf(!realPostgres)('AC-360-F076-R3 管理端 × 上级确认入口（真 PG，真实路由）', () => {
  it('确认入口新增甲（持有链接锁未提交）时管理员删除甲原有关系：两者都成功，链接保留', async () => {
    const scene = await issuedScene(testDb().db, 'f076-r3-d');
    const { b } = await twoConfirmations(scene);
    const { s, w } = scene;
    const p1 = s.person.P1.id;
    const held = gate();
    linkHooks.afterLock = async () => {
      linkHooks.afterLock = undefined;
      held.reached();
      await held.wait;
    };
    const adding = b.add(p1);
    await held.arrived;
    const removing = w.request('DELETE', `${s.path}/objects/${s.object.id}/appraisers/${s.rel.p1.id}`, {
      ifMatch: s.rel.p1.revision,
    });
    await blockedOrSettled(w.db, removing);
    held.release();
    const [added, removed] = await Promise.all([adding, removing]);
    expect(added.status, await added.clone().text()).toBe(201);
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect((await linksOf(scene, p1)).map((l) => l.revoked)).toEqual([false]);
  });
});
