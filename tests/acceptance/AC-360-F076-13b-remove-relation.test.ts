/**
 * AC-360-F076-13b（DEC-409③ / DEC-401⑧ 选 A，设计 §2.1、§2.7、§4.2）：移除评价者最后一条有效关系时同时作废作答链接
 * （凭据与会话随之失效，提示同凭据错误）；还有其他有效关系时不作废；重新加回发新链接与新凭据，旧的不恢复。
 * 三个移除来源都落在 removeRelation()：管理员删评价关系、上级确认入口删关系、移除评价对象。
 */
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { linkRows, resetCredentialConfig, securityEvents } from './AC-360-F076-support.js';
import {
  GENERIC_MESSAGE,
  credsOf,
  issueAll,
  issuedScene,
  login,
  loginOk,
  type SceneB,
} from './AC-360-F076-portal-support.js';

const testDb = useTestDb();
afterEach(() => resetCredentialConfig());

interface RelationRef {
  id: string;
  revision: number;
}

async function removeAppraiser(s: SceneB, objectId: string, relation: RelationRef) {
  return s.w.request('DELETE', `${s.path}/objects/${objectId}/appraisers/${relation.id}`, {
    ifMatch: relation.revision,
  });
}

const revokedOf = async (s: SceneB, personId: string) =>
  (await linkRows(s.w, s.activity.id)).filter((l) => l.person_id === personId).map((l) => l.revoked);

describe('AC-360-F076-13b 移除最后一条有效关系即作废链接与凭据', () => {
  it('评价者有两条关系：删一条仍可登录、链接不变；删最后一条 → 链接作废、登录 401（同凭据错误）、旧会话失效', async () => {
    const { s, w, creds } = await issuedScene(testDb().db, 'f076-13b-a');
    const second = await w.object(s.activity.id, s.person.M.id, [s.q.id]);
    const extra = await w.appraiser(s.activity.id, second.id, s.person.P1.id, 'peer');
    const cred = creds.get(s.person.P1.id)!;
    await loginOk(w, cred);

    expect((await removeAppraiser(s, second.id, extra)).status).toBe(200);
    expect(await revokedOf(s, s.person.P1.id)).toEqual([false]);
    expect((await login(w, cred.serial, cred.password, { ip: '203.0.113.150' })).status).toBe(201);

    expect((await removeAppraiser(s, s.object.id, s.rel.p1)).status).toBe(200);
    expect(await revokedOf(s, s.person.P1.id)).toEqual([true]);
    const denied = await login(w, cred.serial, cred.password, { ip: '203.0.113.151' });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: { code: 'UNAUTHENTICATED', message: GENERIC_MESSAGE } });
  });

  it('重新加回关系：发新链接与新凭据（pending → 发放），旧凭据仍 401', async () => {
    const { s, w, creds } = await issuedScene(testDb().db, 'f076-13b-b');
    const cred = creds.get(s.person.P1.id)!;
    expect((await removeAppraiser(s, s.object.id, s.rel.p1)).status).toBe(200);
    await w.appraiser(s.activity.id, s.object.id, s.person.P1.id, 'peer');

    const links = (await linkRows(w, s.activity.id)).filter((l) => l.person_id === s.person.P1.id);
    expect(links.map((l) => [l.revoked, l.credential_state])).toEqual([
      [true, 'issued'],
      [false, 'pending'],
    ]);
    await issueAll(w);
    const fresh = (await credsOf(w)).get(s.person.P1.id)!;
    expect(fresh.linkId).not.toBe(cred.linkId);
    expect(fresh.serial).not.toBe(cred.serial);
    expect((await login(w, cred.serial, cred.password)).status).toBe(401);
    expect((await login(w, fresh.serial, fresh.password, { ip: '203.0.113.152' })).status).toBe(201);
  });

  it('来源二：移除评价对象 → 该对象下所有评价者的最后一条关系都被移除，链接作废', async () => {
    const { s, w, creds } = await issuedScene(testDb().db, 'f076-13b-c');
    const second = await w.object(s.activity.id, s.person.M.id, [s.q.id]);
    await w.appraiser(s.activity.id, second.id, s.person.P2.id, 'peer');
    const current = await w.ok<{ revision: number }>(w.request('GET', `${s.path}/objects/${s.object.id}`));
    const res = await w.request('DELETE', `${s.path}/objects/${s.object.id}`, { ifMatch: current.revision });
    expect(res.status, await res.clone().text()).toBe(200);

    // P1、自评 T、客户 X 只在被移除的对象里 → 作废；P2 还有另一个对象的关系 → 保留
    for (const person of [s.person.P1, s.person.T, s.person.X]) {
      expect(await revokedOf(s, person.id), person.id).toEqual([true]);
    }
    expect(await revokedOf(s, s.person.P2.id)).toEqual([false]);
    const p2 = creds.get(s.person.P2.id)!;
    expect((await login(w, p2.serial, p2.password)).status).toBe(201);
  });

  it('来源三：上级确认入口删除评价关系（外部客户）→ 其链接作废', async () => {
    const { s, w } = await issuedScene(testDb().db, 'f076-13b-d');
    const invited = await w.ok<{ id: string }>(
      w.request('POST', `${s.path}/objects/${s.object.id}/confirmation`, { ifMatch: 0, body: {} }),
      201,
    );
    expect(invited.id).toBeTruthy();
    const confirm = w.link(await w.token(s.activity.id, s.person.M.id, 'survey360.confirm_invitation'));
    const view = async () =>
      w.ok<{ revision: number; appraisers: { id: string; appraiserPersonId: string }[] }>(confirm('GET', ''));
    const added = await confirm('POST', '/confirmation/appraisers', {
      ifMatch: (await view()).revision,
      body: { person: { name: '客户乙', email: 'customer-13b@example.com' }, roleId: w.role('customer') },
    });
    expect(added.status, await added.clone().text()).toBe(201);
    const customer = (await added.json()) as { id: string; appraiserPersonId: string };
    expect(await revokedOf(s, customer.appraiserPersonId)).toEqual([false]);

    const removed = await confirm('DELETE', `/confirmation/appraisers/${customer.id}`, {
      ifMatch: (await view()).revision,
    });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(await revokedOf(s, customer.appraiserPersonId)).toEqual([true]);
    expect(await securityEvents(w, 'credential_reissued')).toHaveLength(0);
  });
});
