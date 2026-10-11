/** F-076 §4.2～4.7：真实登录后的会话读取、撤销、任务归属与命令语义。 */
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { resetCredentialConfig } from './AC-360-F076-support.js';
import { issuedScene, login, loginOk, logout, minutes, sql1, sessionCall } from './AC-360-F076-portal-support.js';

const testDb = useTestDb();
afterEach(resetCredentialConfig);
const task = (s: Awaited<ReturnType<typeof issuedScene>>['s']) => `/tasks/${s.rel.p1.id}/questionnaires/${s.q.id}`;

async function setup(label: string) {
  const data = await issuedScene(testDb().db, label);
  const cred = data.creds.get(data.s.person.P1.id)!;
  const { session } = await loginOk(data.w, cred);
  return { ...data, cred, session, call: sessionCall(data.w, session) };
}

describe('AC-360-F076-33～39 会话入口', () => {
  it('AC-33：门户与个人链接任务逐项相同，外部评价者也能读取', async () => {
    const { s, w, cred, call, creds } = await setup('entry-33');
    const portal = await call('GET');
    expect(portal.status).toBe(200);
    expect(await portal.json()).toEqual(await (await w.link(cred.token)('GET', '')).json());
    const external = await loginOk(w, creds.get(s.person.X.id)!);
    expect((await sessionCall(w, external.session)('GET')).status).toBe(200);
  });

  it('AC-34：绝对过期、伪造、缺令牌、登出与跨租户都 401，读取不续期', async () => {
    const { w, session, call } = await setup('entry-34');
    expect((await sessionCall(w, randomUUID())('GET')).status).toBe(401);
    expect((await sessionCall(w, '')('GET')).status).toBe(401);
    expect((await call('GET', '', { tenant: randomUUID() })).status).toBe(401);
    w.setNow(minutes(479));
    expect((await call('GET')).status).toBe(200);
    w.setNow(minutes(480));
    expect((await call('GET')).status).toBe(401);
    w.setNow(minutes(1));
    expect((await logout(w, session)).status).toBe(204);
    expect((await call('GET')).status).toBe(401);
  });

  it('AC-36/37：部分移除可用、被删任务 404；最后移除及重新加回不恢复旧会话', async () => {
    const { s, w, call, cred } = await setup('entry-37');
    const second = await w.object(s.activity.id, s.person.M.id, [s.q.id]);
    const extra = await w.appraiser(s.activity.id, second.id, s.person.P1.id, 'peer');
    expect(
      (await w.request('DELETE', `${s.path}/objects/${second.id}/appraisers/${extra.id}`, { ifMatch: extra.revision }))
        .status,
    ).toBe(200);
    expect((await call('GET')).status).toBe(200);
    expect((await call('GET', `/tasks/${extra.id}/questionnaires/${s.q.id}`)).status).toBe(404);
    expect((await call('GET', task(s))).status).toBe(200);
    expect(
      (
        await w.request('DELETE', `${s.path}/objects/${s.object.id}/appraisers/${s.rel.p1.id}`, {
          ifMatch: s.rel.p1.revision,
        })
      ).status,
    ).toBe(200);
    for (const path of ['', task(s), `/avatars/${randomUUID()}/content`])
      expect((await call('GET', path)).status).toBe(401);
    expect((await login(w, cred.serial, cred.password)).status).toBe(401);
    await w.appraiser(s.activity.id, s.object.id, s.person.P1.id, 'peer');
    expect((await call('GET')).status).toBe(401);
    expect((await login(w, cred.serial, cred.password)).status).toBe(401);
  });

  it('AC-36：移除最后对象、活动删除与会话所属链接作废均立即失效', async () => {
    const { s, w, call, cred } = await setup('entry-36');
    for (const [table, column, id] of [
      ['survey360_objects', 'removed', s.object.id],
      ['survey360_activities', 'deleted', s.activity.id],
      ['survey360_links', 'revoked', cred.linkId],
    ]) {
      await sql1(w, sql`UPDATE ${sql.identifier(table!)} SET ${sql.identifier(column!)} = true WHERE id = ${id}::uuid`);
      for (const path of ['', task(s), `/avatars/${randomUUID()}/content`])
        expect((await call('GET', path)).status).toBe(401);
      await sql1(
        w,
        sql`UPDATE ${sql.identifier(table!)} SET ${sql.identifier(column!)} = false WHERE id = ${id}::uuid`,
      );
    }
  });

  it('AC-38：会话、个人链接、报告链接、确认与成员权限互不通用', async () => {
    const { w, call, session, cred, s } = await setup('entry-38');
    expect((await sessionCall(w, cred.token)('GET')).status).toBe(401);
    expect((await w.link(session)('GET', '')).status).toBe(404);
    for (const path of ['/api/survey360/report-link', '/api/tenant/survey360/activities']) {
      const res = await w.api.request('GET', path, {
        tenant: w.tenantId,
        headers: { 'x-survey360-session': session, 'x-survey360-token': session },
      });
      expect([401, 404]).toContain(res.status);
    }
    expect((await call('GET', '/confirmation/candidates')).status).toBe(404);
    expect((await call('GET', `/tasks/${randomUUID()}/questionnaires/${s.q.id}`)).status).toBe(404);
    expect((await call('GET', `/tasks/bad/questionnaires/${s.q.id}`)).status).toBe(400);
  });

  it('AC-39：本人保存、同键重放、跨入口冲突、If-Match、停用与匿名投影', async () => {
    const { w, s, call, cred } = await setup('entry-39');
    const command = randomUUID();
    const body = { answers: [], suggestion: '本人草稿' };
    const opts = { ifMatch: 0, idempotencyKey: command, body };
    const saved = await call('PUT', task(s), opts);
    expect(saved.status, await saved.clone().text()).toBe(200);
    const data = await saved.json();
    expect(await (await call('PUT', task(s), opts)).json()).toEqual(data);
    const cross = await w.link(cred.token)('PUT', task(s), opts);
    expect(cross.status).toBe(409);
    expect(await cross.text()).toContain('IDEMPOTENCY_CONFLICT');
    expect((await call('PUT', task(s), { ifMatch: 0, body })).status).toBe(409);
    await sql1(w, sql`UPDATE survey360_activities SET show_appraiser_name = false WHERE id = ${s.activity.id}::uuid`);
    expect(await (await call('GET')).json()).not.toHaveProperty('appraiser');
    await w.transition(s.activity.id, 'disable');
    expect((await call('GET')).status).toBe(200);
    const stopped = await call('PUT', task(s), { ifMatch: data.revision, body });
    expect(stopped.status).toBe(409);
    expect(await stopped.text()).toContain('ACTIVITY_NOT_OPEN');
  });
});
