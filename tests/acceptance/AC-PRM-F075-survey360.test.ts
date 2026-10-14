/**
 * AC-PRM-F075（DEC-369，用户已同意去掉冗余授权调用）360 管理端 24 项：套卷（questionnaires）、设置 / 评价角色
 * （settings / roles）、新建活动（POST /activities）逐个入口的 loadAdmin 预取（Activity 的 object.view 与 viewAll 按钮）
 * 不影响返回。本文件在改动前的代码上全绿，改动后原样保持全绿：
 *   - 原生授权（真实 360 权限）下 3 类操作人跑固定场景，规范化转录与改动前生成的黄金文件逐字节相等；
 *   - 全允许替身下，冗余的 2 个请求键分别撤 / 一起撤 / 都不撤（四种组合），转录相同（独立性）。
 * 套卷模板入口（#125 新增，18 项）等用户答复，不在本次范围，保持现状。
 */
import type { Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { BASE, type World360, world360 } from './AC-360-support.js';
import { createAuthorizerDouble } from './support/route-policy/double.js';
import { expectGolden, expectSameTranscript, step, type Step } from './support/f075-equivalence.js';
import { type RequestOptions, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

/** 被去掉的两个冗余请求键（所有 24 项都是这一对）。 */
const REDUNDANT_KEYS = ['obj:Survey360.Activity:view', 'btn:Survey360.Activity#viewAll@list'] as const;
const NEW_ID = '6d8f8f0e-2a4d-4b8b-8d64-5b0c2f7a9e11';

type Send = (user: string) => (method: string, path: string, opts?: RequestOptions) => Promise<Response>;

/** 固定场景：每个入口至少一个成功路径、一个非法 / 冲突 / 不存在路径，三类操作人各一遍读写。 */
async function scenario(w: World360, send: Send): Promise<Step[]> {
  const general = await w.member('f075-general');
  await w.appoint(general, 'general');
  const plain = await w.member('f075-plain');
  const steps: Step[] = [];
  /** 当前 revision：各授权下写入的成败不同（如非本人是否被拒），后续步骤用实时值，保证两种授权下走同一串分支。 */
  const rev = async (path: string) =>
    ((await (await send(w.admin)('GET', path)).json()) as { revision: number }).revision;
  const run = async (name: string, user: string, method: string, path: string, opts: RequestOptions = {}) =>
    steps.push(await step(name, await send(user)(method, path, opts)));

  // ---- 设置 / 评价角色（5 个入口）----
  await run('admin GET /settings', w.admin, 'GET', '/settings');
  await run('admin PUT /settings 开精细化', w.admin, 'PUT', '/settings', {
    ifMatch: 0,
    body: { finePermission: true },
  });
  await run('admin PUT /settings 过期 revision', w.admin, 'PUT', '/settings', {
    ifMatch: 0,
    body: { finePermission: false },
  });
  await run('admin PUT /settings 非法体', w.admin, 'PUT', '/settings', { ifMatch: 1, body: { finePermission: 'x' } });
  await run('general GET /settings', general, 'GET', '/settings');
  await run('general PUT /settings', general, 'PUT', '/settings', { ifMatch: 1, body: { finePermission: false } });
  await run('plain GET /settings', plain, 'GET', '/settings');
  await run('admin GET /roles', w.admin, 'GET', '/roles');
  await run('general GET /roles', general, 'GET', '/roles');
  await run('plain GET /roles', plain, 'GET', '/roles');
  await run('admin POST /roles', w.admin, 'POST', '/roles', {
    ifMatch: 0,
    body: { name: '角色甲', displayText: '甲' },
  });
  await run('admin POST /roles 非法体', w.admin, 'POST', '/roles', { ifMatch: 0, body: {} });
  await run('general POST /roles', general, 'POST', '/roles', { ifMatch: 0, body: { name: '角色乙' } });
  await run('plain POST /roles', plain, 'POST', '/roles', { ifMatch: 0, body: { name: '角色丙' } });
  const roles = (
    (await (await send(w.admin)('GET', '/roles')).json()) as {
      items: { id: string; code: string | null; revision: number }[];
    }
  ).items;
  const custom = roles.find((r) => r.code === null)!;
  const builtin = roles.find((r) => r.code !== null)!;
  await run('admin PUT /roles/:id', w.admin, 'PUT', `/roles/${custom.id}`, {
    ifMatch: custom.revision,
    body: { displayText: '改' },
  });
  await run('admin PUT /roles/:id 过期', w.admin, 'PUT', `/roles/${custom.id}`, {
    ifMatch: 0,
    body: { displayText: '再改' },
  });
  await run('admin PUT /roles/:id 内置改名', w.admin, 'PUT', `/roles/${builtin.id}`, {
    ifMatch: builtin.revision,
    body: { name: '改名' },
  });
  await run('admin PUT /roles/:id 不存在', w.admin, 'PUT', `/roles/${NEW_ID}`, {
    ifMatch: 0,
    body: { displayText: 'x' },
  });
  await run('admin PUT /roles/:id 非法标识', w.admin, 'PUT', '/roles/not-a-uuid', { ifMatch: 0, body: {} });
  await run('general PUT /roles/:id', general, 'PUT', `/roles/${custom.id}`, {
    ifMatch: 2,
    body: { displayText: '丙' },
  });

  // ---- 套卷（questionnaires：6 个入口，含本人 / 非本人）----
  const q = async (user: string, label: string, name: string) => {
    const res = await send(user)('POST', '/questionnaires', { ifMatch: 0, body: { name, type: 'key_behavior' } });
    steps.push(await step(`${label} POST /questionnaires`, res.clone()));
    return res.status === 201 ? ((await res.json()) as { id: string; revision: number }) : undefined;
  };
  const mine = (await q(w.admin, 'admin', '套卷A'))!;
  await run('admin POST /questionnaires 非法体', w.admin, 'POST', '/questionnaires', { ifMatch: 0, body: {} });
  await q(general, 'general', '套卷G');
  await q(plain, 'plain', '套卷P');
  await run('admin GET /questionnaires', w.admin, 'GET', '/questionnaires');
  await run('general GET /questionnaires', general, 'GET', '/questionnaires');
  await run('plain GET /questionnaires', plain, 'GET', '/questionnaires');
  await run('admin GET /questionnaires/:id', w.admin, 'GET', `/questionnaires/${mine.id}`);
  await run('admin GET /questionnaires/:id 不存在', w.admin, 'GET', `/questionnaires/${NEW_ID}`);
  await run('admin GET /questionnaires/:id 非法标识', w.admin, 'GET', '/questionnaires/not-a-uuid');
  await run('general GET /questionnaires/:id', general, 'GET', `/questionnaires/${mine.id}`);
  await run('plain GET /questionnaires/:id', plain, 'GET', `/questionnaires/${mine.id}`);
  await run('admin PUT /questionnaires/:id 整卷', w.admin, 'PUT', `/questionnaires/${mine.id}`, {
    ifMatch: mine.revision,
    body: { name: '套卷A改', content: w.keyBehaviorContent({ self: 0, superior: 5, peer: 3, subordinate: 2 }) },
  });
  await run('admin PUT /questionnaires/:id 过期', w.admin, 'PUT', `/questionnaires/${mine.id}`, {
    ifMatch: mine.revision,
    body: { name: '再改' },
  });
  await run('admin PUT /questionnaires/:id 不存在', w.admin, 'PUT', `/questionnaires/${NEW_ID}`, {
    ifMatch: 0,
    body: { name: 'x' },
  });
  await run('general PUT /questionnaires/:id 非本人', general, 'PUT', `/questionnaires/${mine.id}`, {
    ifMatch: await rev(`/questionnaires/${mine.id}`),
    body: { name: '非本人改' },
  });
  await run('plain PUT /questionnaires/:id', plain, 'PUT', `/questionnaires/${mine.id}`, {
    ifMatch: await rev(`/questionnaires/${mine.id}`),
    body: { name: '无权改' },
  });
  await run('general POST /:id/enable 非本人', general, 'POST', `/questionnaires/${mine.id}/enable`, {
    ifMatch: await rev(`/questionnaires/${mine.id}`),
  });
  await run('admin POST /:id/enable', w.admin, 'POST', `/questionnaires/${mine.id}/enable`, {
    ifMatch: await rev(`/questionnaires/${mine.id}`),
  });
  await run('admin POST /:id/enable 重复', w.admin, 'POST', `/questionnaires/${mine.id}/enable`, {
    ifMatch: await rev(`/questionnaires/${mine.id}`),
  });
  await run('admin POST /:id/enable 不存在', w.admin, 'POST', `/questionnaires/${NEW_ID}/enable`, { ifMatch: 0 });
  const doomed = (await q(w.admin, 'admin 删除用甲', '套卷D'))!;
  await run('general DELETE /questionnaires/:id 非本人', general, 'DELETE', `/questionnaires/${doomed.id}`, {
    ifMatch: await rev(`/questionnaires/${doomed.id}`),
  });
  const doomedToo = (await q(w.admin, 'admin 删除用乙', '套卷E'))!;
  await run('admin DELETE /questionnaires/:id 过期', w.admin, 'DELETE', `/questionnaires/${doomedToo.id}`, {
    ifMatch: 9,
  });
  await run('admin DELETE /questionnaires/:id', w.admin, 'DELETE', `/questionnaires/${doomedToo.id}`, {
    ifMatch: await rev(`/questionnaires/${doomedToo.id}`),
  });
  await run('admin DELETE /questionnaires/:id 重复', w.admin, 'DELETE', `/questionnaires/${doomedToo.id}`, {
    ifMatch: 1,
  });
  await run('admin GET /questionnaires 之后', w.admin, 'GET', '/questionnaires');

  // ---- 新建活动（POST /activities）----
  const activity = { name: '活动甲', form: 'single', showAppraiserName: true, roleDisplay: 'name' };
  await run('admin POST /activities', w.admin, 'POST', '/activities', { ifMatch: 0, body: activity });
  await run('admin POST /activities 非法体', w.admin, 'POST', '/activities', { ifMatch: 0, body: { form: 'x' } });
  await run('admin POST /activities 非 0 revision', w.admin, 'POST', '/activities', { ifMatch: 3, body: activity });
  await run('general POST /activities', general, 'POST', '/activities', { ifMatch: 0, body: activity });
  await run('plain POST /activities', plain, 'POST', '/activities', { ifMatch: 0, body: activity });
  return steps;
}

describe('AC-PRM-F075 360 管理端：去掉 loadAdmin 预取前后返回完全一致（DEC-369）', () => {
  it('原生授权（真实 360 权限；系统管理员 / 普通管理员 / 无身份成员）：转录与改动前的黄金文件逐字节相等', async () => {
    const w = await world360(testDb().db as Db, 'f075native');
    const steps = await scenario(w, (user) => (method, path, opts) => w.as(user)(method, path, opts));
    expect(steps.length).toBeGreaterThan(50);
    expectGolden('survey360-native', steps);
  }, 240_000);

  it('全允许替身：Activity 查看 / viewAll 两个冗余请求键的四种答案组合，转录都相同，也等于黄金文件', async () => {
    const run = async (label: string, revoke: readonly string[]) => {
      const w = await world360(testDb().db as Db, label);
      const double = createAuthorizerDouble();
      for (const key of revoke) double.revoke(key);
      const api = tenantApi(testDb().db as Db, {
        clock: () => new Date('2026-10-01T01:00:00Z'),
        authorize: double.authorize,
      });
      return scenario(
        w,
        (user) =>
          (method, path, opts = {}) =>
            api.request(method, `${BASE}${path}`, { ...opts, user, tenant: w.tenantId }),
      );
    };
    const allowed = await run('f075allow', []);
    // 四种组合（#177 审查 P3-1）：两个键各自单独撤、两个一起撤、都不撤——任何一个的答案都不影响返回
    const [view, viewAll] = REDUNDANT_KEYS;
    const combinations: readonly (readonly [string, readonly string[]])[] = [
      ['只撤 Activity:view', [view]],
      ['只撤 viewAll 按钮', [viewAll]],
      ['两个一起撤', [view, viewAll]],
    ];
    for (const [label, keys] of combinations) {
      expectSameTranscript(await run(`f075${keys.length}${keys[0] === viewAll ? 'b' : 'a'}`, keys), allowed, label);
    }
    expectGolden('survey360-all-allow', allowed);
  }, 240_000);
});
