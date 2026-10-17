/**
 * BE-15a 第 1 轮审查返工（#400）：
 * - P1：真实授权器下租户管理员（system_admin，配置写 = other_settings）能新增 / 编辑 / 完整读取自动转正规则，
 *   复制 / 启停 / 删除 / 立即执行同样可用；无管理员身份的普通成员 403、不写入。配置对象字段目录须含规则全部字段；
 * - P2-2：立即执行单次扫描有上限时，回执带续跑游标、入口接受游标，续跑能推进到后面到期的人；
 * - P2-3：候选 A < B < C、A 的调动草稿关联 C 时，立即执行先按全局顺序锁住全体参与者，不因锁序守卫整批 409。
 */
import { randomUUID } from 'node:crypto';
import { bootstrapTenantAdmin } from '@italent/api';
import { createUser, grantMembership, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { employeeRevision, hire, pbWorld, type PbWorld } from './AC-PB-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const SERVICE = '../../apps/api/src/modules/employment/auto-regularization.js';
const SWITCH = '/api/tenant/settings/probation.auto_regularization_enabled';
const rows = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];
const CLOCK = () => new Date('2026-10-01T01:00:00.000Z');

interface RunReceipt {
  readonly launched: { employeeId: string }[];
  readonly failed: { employeeId: string; reason: string }[];
  readonly nextCursor?: string | null;
}

const ruleBody = (w: PbWorld, extra: Record<string, unknown> = {}) => ({
  name: '到期当天自动转正',
  priority: 1,
  orgIds: [w.org.id],
  includeSubordinates: false,
  mode: 'direct',
  daysBefore: 0,
  initiatorType: 'rule_operator',
  probationResult: 'normal',
  ...extra,
});

async function launches(w: PbWorld, employeeId: string) {
  return withTenant(w.db, w.session.tenant.id, async (tx) =>
    rows<{ state: string }>(
      await tx.execute(sql`SELECT state FROM employment_auto_regularization_launches
        WHERE tenant_id=${w.session.tenant.id} AND employee_id=${employeeId}::uuid`),
    ),
  );
}

async function switchOn(w: PbWorld) {
  const api = tenantApi(w.db);
  const response = await api.request('PUT', SWITCH, {
    user: w.session.user.id,
    tenant: w.session.tenant.id,
    ifMatch: 0,
    body: { value: true },
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

describe('P1 真实授权器：租户管理员维护自动转正规则', () => {
  it('管理员新增 / 编辑 / 完整读取 / 复制 / 启停 / 删除 / 立即执行均可用；普通成员 403 且不写入', async () => {
    const w = await pbWorld(testDb().db, `auto-reg-real-${randomUUID()}`);
    await bootstrapTenantAdmin(w.db, { tenantId: w.session.tenant.id, userId: w.session.user.id }, cmd());
    const real = tenantApi(w.db, { authorize: undefined, clock: CLOCK });
    const admin = (method: string, path: string, options: { ifMatch?: number; body?: unknown } = {}) =>
      real.request(method, path.startsWith('/api/') ? path : `/api/tenant/employment${path}`, {
        ...options,
        user: w.session.user.id,
        tenant: w.session.tenant.id,
      });

    const created = await admin('POST', '/auto-regularization-rules', { ifMatch: 0, body: ruleBody(w) });
    expect(created.status, await created.clone().text()).toBe(201);
    const rule = (await created.json()) as { id: string; revision: number };
    const edited = await admin('PUT', `/auto-regularization-rules/${rule.id}`, {
      ifMatch: rule.revision,
      body: ruleBody(w, { name: '到期前 3 天自动转正', daysBefore: 3, includeSubordinates: true }),
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    const listed = await admin('GET', '/auto-regularization-rules');
    expect(listed.status, await listed.clone().text()).toBe(200);
    expect(((await listed.json()) as { items: unknown[] }).items).toEqual([
      expect.objectContaining({
        id: rule.id,
        name: '到期前 3 天自动转正',
        priority: 1,
        orgIds: [w.org.id],
        includeSubordinates: true,
        mode: 'direct',
        daysBefore: 3,
        initiatorType: 'rule_operator',
        probationResult: 'normal',
        enabled: true,
        revision: 2,
      }),
    ]);
    const copied = await admin('POST', `/auto-regularization-rules/${rule.id}/copy`, { ifMatch: 0 });
    expect(copied.status, await copied.clone().text()).toBe(201);
    const copy = (await copied.json()) as { id: string; revision: number };
    const enabled = await admin('PUT', `/auto-regularization-rules/${copy.id}/enabled`, {
      ifMatch: copy.revision,
      body: { enabled: true },
    });
    expect(enabled.status, await enabled.clone().text()).toBe(200);
    const removed = await admin('DELETE', `/auto-regularization-rules/${copy.id}`, { ifMatch: copy.revision + 1 });
    expect(removed.status, await removed.clone().text()).toBe(200);

    const due = await hire(w, { date: '2026-09-01', endDate: '2026-10-03' });
    const on = await admin('PUT', SWITCH, { ifMatch: 0, body: { value: true } });
    expect(on.status, await on.clone().text()).toBe(200);
    const run = await admin('POST', '/auto-regularization/run', { ifMatch: 0, body: {} });
    expect(run.status, await run.clone().text()).toBe(200);
    // 第 2 轮审查 P1：管理员只有配置管理权、任职数据范围为空，回执不列出员工；按台账核对已发起
    expect(((await run.json()) as RunReceipt).launched).toEqual([]);
    expect(await launches(w, due.employee.id)).toEqual([{ state: 'launched' }]);

    // 普通成员：没有管理员身份、也没有业务身份（默认拒绝）
    const member = await createUser(
      w.db,
      { email: `auto-reg-member-${randomUUID()}@example.com`, displayName: '普通成员' },
      cmd(),
    );
    await grantMembership(w.db, { tenantId: w.session.tenant.id, userId: member.id, expectedRevision: 0 }, cmd());
    const plain = (method: string, path: string, options: { ifMatch?: number; body?: unknown } = {}) =>
      real.request(method, `/api/tenant/employment${path}`, {
        ...options,
        user: member.id,
        tenant: w.session.tenant.id,
      });
    expect((await plain('POST', '/auto-regularization-rules', { ifMatch: 0, body: ruleBody(w) })).status).toBe(403);
    expect(
      (await plain('PUT', `/auto-regularization-rules/${rule.id}`, { ifMatch: 2, body: ruleBody(w) })).status,
    ).toBe(403);
    expect((await plain('POST', '/auto-regularization/run', { ifMatch: 0, body: {} })).status).toBe(403);
    const after = await admin('GET', '/auto-regularization-rules');
    expect(((await after.json()) as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([rule.id]);
  });
});

describe('P2-2 立即执行续跑', () => {
  type Limits = { scan: number; chunk: number };
  let restore: (() => void) | null = null;
  afterEach(() => restore?.());

  it('单次扫描达到上限时回执带游标；带游标续跑推进到后面到期的人，只发起一次', async () => {
    const service = (await import(SERVICE)) as { AUTO_REGULARIZATION_RUN_LIMITS?: Limits };
    const limits = service.AUTO_REGULARIZATION_RUN_LIMITS ?? ({ scan: 2000, chunk: 100 } as Limits);
    const saved = { ...limits };
    // 测试把扫描上限调小（同一代码路径）：前 5 名不适用、第 6 名到期
    Object.assign(limits, { scan: 3, chunk: 100 });
    restore = () => Object.assign(limits, saved);

    const w = await pbWorld(testDb().db, `auto-reg-cursor-${randomUUID()}`);
    const rule = await w.session.request('POST', '/auto-regularization-rules', { ifMatch: 0, body: ruleBody(w) });
    expect(rule.status, await rule.clone().text()).toBe(201);
    const people = [];
    // 没有预计试用结束日：在试用状态里（是候选），但不是适用对象
    for (let i = 0; i < 6; i += 1) people.push((await hire(w, { date: '2026-09-01', name: `候选${i}` })).employee.id);
    people.sort();
    const last = people.at(-1)!;
    const adjusted = await w.session.request('PUT', `/employees/${last}/probation`, {
      ifMatch: await employeeRevision(w, last),
      body: { hasProbation: true, startDate: '2026-09-01', expectedEndDate: '2026-09-30' },
    });
    expect(adjusted.status, await adjusted.clone().text()).toBe(200);
    await switchOn(w);

    const run = async (cursor?: string) => {
      const response = await w.session.request('POST', '/auto-regularization/run', {
        ifMatch: 0,
        body: cursor ? { cursor } : {},
      });
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()) as RunReceipt;
    };
    const first = await run();
    expect(first.launched).toEqual([]);
    // 第 2 轮审查 P1：游标是续跑句柄，不是员工 UUID
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(people).not.toContain(first.nextCursor);
    const launched: string[] = [];
    let cursor = first.nextCursor ?? null;
    for (let i = 0; cursor && i < 5; i += 1) {
      const next = await run(cursor);
      launched.push(...next.launched.map((item) => item.employeeId));
      cursor = next.nextCursor ?? null;
    }
    expect(cursor).toBeNull();
    expect(launched).toEqual([last]);
    expect(await launches(w, last)).toEqual([{ state: 'launched' }]);
    // 游标不是员工 UUID → 400
    const invalid = await w.session.request('POST', '/auto-regularization/run', {
      ifMatch: 0,
      body: { cursor: 'not-a-uuid' },
    });
    expect(invalid.status).toBe(400);
  });
});

describe('P2-3 调动联动闭包与锁序', () => {
  it('A < B < C、A 的调动草稿关联 C：立即执行整批成功，三人各发起一次', async () => {
    const w = await pbWorld(testDb().db, `auto-reg-closure-${randomUUID()}`);
    const rule = await w.session.request('POST', '/auto-regularization-rules', { ifMatch: 0, body: ruleBody(w) });
    expect(rule.status, await rule.clone().text()).toBe(201);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1)
      ids.push((await hire(w, { date: '2026-09-01', months: 1, name: `联动${i}` })).employee.id);
    const [a, b, c] = ids.sort();
    await w.session.business(
      a!,
      {
        kind: 'transfer',
        mode: 'application',
        effectiveDate: '2026-11-01',
        fields: { departmentId: w.org.id, addedSubordinateIds: [c] },
      },
      await employeeRevision(w, a!),
    );
    await switchOn(w);
    const response = await w.session.request('POST', '/auto-regularization/run', { ifMatch: 0, body: {} });
    expect(response.status, await response.clone().text()).toBe(200);
    const receipt = (await response.json()) as RunReceipt;
    expect(receipt.failed).toEqual([]);
    expect(receipt.launched.map((item) => item.employeeId).sort()).toEqual([a, b, c]);
    for (const id of [a!, b!, c!]) expect(await launches(w, id)).toEqual([{ state: 'launched' }]);
  });
});
