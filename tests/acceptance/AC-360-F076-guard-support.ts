/** F-076 AC-34/37/39/40：R3 / R4 路由表复用真实登录、任务归属与撤权场景。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { expect } from 'vitest';
import { employeeAvatar } from './AC-EMP-F058-avatar-support.js';
import { issuedScene, loginOk, logout, PORTAL, sessionCall, sql1 } from './AC-360-F076-portal-support.js';
import { rowsOf } from './AC-360-F076-support.js';
import type { World360 } from './AC-360-support.js';
import type { RequestOptions } from './support/tenant-api.js';

type Env = { w: World360 };
type Kind = 'home' | 'avatar' | 'read' | 'save' | 'submit' | 'page';
const TASK = '/tasks/:relationId/questionnaires/:questionnaireId';
const ROUTES: readonly [string, string, Kind][] = [
  ['GET', '', 'home'],
  ['GET', '/avatars/:attachmentId/content', 'avatar'],
  ['GET', TASK, 'read'],
  ['PUT', TASK, 'save'],
  ['POST', `${TASK}/submit`, 'submit'],
  ['POST', `${TASK}/page-check`, 'page'],
];

async function status(response: Promise<Response>, expected: number) {
  const res = await response;
  expect(res.status, await res.clone().text()).toBe(expected);
  return res;
}

async function snapshot(w: World360) {
  return withTenant(w.db, w.tenantId, async (tx) => ({
    sheets: rowsOf(await tx.execute(sql`SELECT * FROM survey360_sheets ORDER BY id`)),
    answers: rowsOf(await tx.execute(sql`SELECT * FROM survey360_answers ORDER BY id`)),
    timings: rowsOf(await tx.execute(sql`SELECT * FROM survey360_sheet_timings ORDER BY relation_id`)),
    audit: rowsOf(await tx.execute(sql`SELECT * FROM audit_events ORDER BY id`)),
    ledger: rowsOf(await tx.execute(sql`SELECT * FROM command_ledger ORDER BY command_id`)),
  }));
}

async function setup(env: Env, kind: Kind) {
  const { s, w, creds } = await issuedScene(env.w.db, `guard-portal-${kind}`);
  const cred = creds.get(s.person.P1.id)!;
  const { session } = await loginOk(w, cred);
  const other = await loginOk(w, creds.get(s.person.P2.id)!);
  const own = sessionCall(w, session);
  const stranger = sessionCall(w, other.session);
  // 门户不受成员的字段配置支配；按活动匿名投影隐藏评价者与角色（F-076 §4.2）。
  await sql1(
    w,
    sql`UPDATE survey360_activities SET show_appraiser_name = false, role_display = 'hidden'
    WHERE id = ${s.activity.id}::uuid`,
  );
  const task = `/tasks/${s.rel.p1.id}/questionnaires/${s.q.id}`;
  const content = {
    answers: s.q.questions.map((q) => ({ itemId: q.id, optionId: s.q.scales[0]!.options[0]!.id })),
    suggestion: '门户本人的建议',
  };
  let path = kind === 'home' ? '' : task;
  let options: RequestOptions = {};
  let avatar: Awaited<ReturnType<typeof employeeAvatar>> | undefined;
  if (kind === 'avatar') {
    avatar = await employeeAvatar(w, s.employees.T.id);
    path = `/avatars/${avatar.avatar.id}/content`;
  }
  if (kind === 'save') options = { ifMatch: 0, body: content };
  if (kind === 'submit') {
    const saved = await (await status(own('PUT', task, { ifMatch: 0, body: content }), 200)).json();
    path += '/submit';
    options = { ifMatch: saved.revision, body: {} };
  }
  if (kind === 'page') {
    await status(own('GET', task), 200);
    path += '/page-check';
    options = { body: { items: [{ itemId: s.q.questions[0]!.id }] } };
  }
  return { s, w, cred, session, own, stranger, path, task, options, content, avatar };
}

function anonymous(body: unknown) {
  const text = JSON.stringify(body);
  for (const key of ['appraiser', 'role']) expect(text).not.toContain(`"${key}":`);
  for (const name of ['同事一', '同事二']) expect(text).not.toContain(name);
}

function trimmingCase(method: string, kind: Kind) {
  if (kind === 'avatar')
    return { na: '仅返回授权图片字节，无人员字段投影；本表超范围用例核对本人真实字节及他人头像 404' };
  if (kind === 'page')
    return { na: '仅返回 reminder 与 autoDismissSeconds，不含人员或答卷字段；AC-40 核对完整回执与重放' };
  return async (env: Env) => {
    const p = await setup(env, kind);
    const options = { ...p.options, idempotencyKey: randomUUID() };
    const first = await (await status(p.own(method, p.path, options), 200)).json();
    anonymous(first);
    if (kind === 'home') expect(first.tasks.length).toBeGreaterThan(0);
    if (kind === 'read') expect(first).toHaveProperty('sheet');
    if (kind === 'save' || kind === 'submit') {
      expect(first.suggestion).toBe(p.content.suggestion);
      expect(first.answers).toEqual(
        expect.arrayContaining(p.content.answers.map((answer) => expect.objectContaining(answer))),
      );
      const replay = await (await status(p.own(method, p.path, options), 200)).json();
      expect(replay).toEqual(first);
      anonymous(replay);
    }
  };
}

/** 六条会话入口均有真实未授权 / 超范围请求；身份只取会话，不借用管理员身份。 */
export const PORTAL_GUARD_CASES = Object.fromEntries(
  ROUTES.map(([method, route, kind]) => [
    `${method} ${PORTAL}${route}`,
    {
      unauthorized: async (env: Env) => {
        const p = await setup(env, kind);
        await status(logout(p.w, p.session), 204);
        const before = await snapshot(p.w);
        for (const token of ['', p.cred.token, p.session]) {
          const denied = await status(sessionCall(p.w, token)(method, p.path, p.options), 401);
          expect(await denied.text()).not.toContain(p.content.suggestion);
        }
        expect(await snapshot(p.w)).toEqual(before);
      },
      outOfScope: async (env: Env) => {
        const p = await setup(env, kind);
        const allowed = await status(p.own(method, p.path, p.options), 200);
        if (kind === 'avatar') expect(Buffer.from(await allowed.arrayBuffer())).toEqual(p.avatar!.fixture.bytes);
        if (kind === 'home') {
          const page = await allowed.json();
          expect(page.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ relationId: p.s.rel.p1.id })]));
        }
        let denied: () => Promise<Response>;
        let expected = 404;
        if (kind === 'home') {
          // 使用另一个真实租户，而不是不存在的 UUID；会话不能跨租户使用。
          denied = () => p.own(method, p.path, { tenant: env.w.tenantId });
          expected = 401;
        } else if (kind === 'avatar') {
          const otherAvatar = await employeeAvatar(p.w, p.s.employees.P2.id);
          denied = () => p.own('GET', `/avatars/${otherAvatar.avatar.id}/content`);
        } else {
          denied = () => p.stranger(method, p.path, p.options);
        }
        const before = await snapshot(p.w);
        const response = await status(denied(), expected);
        expect(await response.text()).not.toContain(p.content.suggestion);
        expect(await snapshot(p.w)).toEqual(before);
      },
      trimming: trimmingCase(method, kind),
    },
  ]),
);

/** 三条写路由全部适用：保留另一任务使会话仍有效，只移除已成功写入的目标关系。 */
export const PORTAL_REPLAY_CASES = Object.fromEntries(
  ROUTES.filter(([, , kind]) => ['save', 'submit', 'page'].includes(kind)).map(([method, route, kind]) => [
    `${method} ${PORTAL}${route}`,
    async (env: Env) => {
      const p = await setup(env, kind);
      const extraObject = await p.w.object(p.s.activity.id, p.s.person.M.id, [p.s.q.id]);
      await p.w.appraiser(p.s.activity.id, extraObject.id, p.s.person.P1.id, 'peer');
      const options = { ...p.options, idempotencyKey: randomUUID() };
      const call = () => p.own(method, p.path, options);
      const first = await (await status(call(), 200)).json();
      expect(await (await status(call(), 200)).json()).toEqual(first);
      await p.w.ok(
        p.w.request('DELETE', `${p.s.path}/objects/${p.s.object.id}/appraisers/${p.s.rel.p1.id}`, {
          ifMatch: p.s.rel.p1.revision,
        }),
      );
      const home = await (await status(p.own('GET'), 200)).json();
      expect(home.tasks.length).toBeGreaterThan(0);
      expect(home.tasks.some((task: { relationId: string }) => task.relationId === p.s.rel.p1.id)).toBe(false);
      const before = await snapshot(p.w);
      for (const request of [call, () => p.own(method, p.path, { ...options, idempotencyKey: randomUUID() })]) {
        const denied = await status(request(), 404);
        expect(await denied.text()).not.toContain(p.content.suggestion);
      }
      expect(await snapshot(p.w)).toEqual(before);
      await status(logout(p.w, p.session), 204);
      const revoked = await snapshot(p.w);
      await status(call(), 401);
      expect(await snapshot(p.w)).toEqual(revoked);
    },
  ]),
);
