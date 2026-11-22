import { randomUUID } from 'node:crypto';
import { auditEvents, commandLedger, eq, withTenant } from '@italent/db';
import { testDbMode, useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { provisionTenant } from '../../apps/api/src/modules/platform/provisioning.js';
import { newUser, seedOperator } from './support/platform-api.js';
import { cmd, tenantApi, type RequestOptions } from './support/tenant-api.js';

const database = useTestDb();
const now = new Date('2026-11-21T08:00:00Z');
const base = '/api/tenant/onboarding/integration';
const path = `${base}/schemes`;
const name = { 'zh-CN': 'ZZ_BE16_融入方案' };
const day = (ordinal: number) => ({ unit: 'day', ordinal });
const week = (ordinal: number) => ({ unit: 'week', ordinal });
const performanceReason = 'INTEGRATION_PERFORMANCE_ACTIVITY_UNAVAILABLE';

async function fixture() {
  const { db } = database();
  const ops = await seedOperator(db, 'ZZ_BE16_SCHEME_OPS');
  const admin = await newUser(db, 'ZZ_BE16_SCHEME_ADMIN');
  const provision = () =>
    provisionTenant(
      db,
      {
        code: `ZZ_BE16_${randomUUID()}`,
        name: 'ZZ_BE16_SCHEME',
        firstAdminUserId: admin.id,
        exceptionAdminUserId: admin.id,
      },
      cmd(ops.id),
      now,
    );
  const home = await provision();
  const tenantId = home.tenant.id;
  const as = { user: admin.id, tenant: tenantId };
  const api = tenantApi(db, { authorize: undefined, clock: () => now });
  const request = (method: string, suffix = '', options: RequestOptions = {}) =>
    api.request(method, path + suffix, { ...as, ...options });

  const fixtureApi = tenantApi(db, { clock: () => now });
  async function org(label: string) {
    const response = await fixtureApi.request('POST', '/api/tenant/org/organizations', {
      ...as,
      ifMatch: 0,
      body: { name: label, establishedOn: '2026-01-01', parents: { admin: { parentId: tenantId } } },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }

  async function poolTask(assessmentType: 'probation' | 'regularization') {
    const response = await api.request('POST', `${base}/task-pool`, {
      ...as,
      ifMatch: 0,
      body: {
        code: `ZZ_BE16_${assessmentType}`,
        name: 'ZZ_BE16_考核',
        category: 'probation_assessment',
        action: { type: 'assessment', assessmentType, name: 'ZZ_BE16_考核' },
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }

  const orgA = await org('ZZ_BE16_组织甲');
  const orgB = await org('ZZ_BE16_组织乙');
  const poolId = await poolTask('probation');
  const regularizationId = await poolTask('regularization');
  return { db, tenantId, as, api, request, provision, orgA, orgB, poolId, regularizationId };
}

function task(poolTaskId: string) {
  return {
    poolTaskId,
    start: week(2),
    due: day(14),
    assignee: { type: 'employee' },
    employeeVisible: true,
    reminder: { mode: 'inherit' },
  };
}

function input(orgIds: string[], poolTaskId: string, priority?: number) {
  return {
    name,
    priority,
    orgIds,
    stages: [{ name: 'ZZ_BE16_第二周', start: week(2), due: week(3), tasks: [task(poolTaskId)] }],
  };
}

async function saved(response: Response) {
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { id: string; revision: number };
}

describe('AC-ON-BE16-01、AC-ON-01、AC-ON-04 融入方案', () => {
  let world: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    world = await fixture();
  });

  it('保存方案默认参数和两类考核挂接，任务池删除受生产关系约束', async () => {
    const { request, api, as, orgA, poolId, regularizationId } = world;
    const body = input([orgA], poolId);
    body.stages[0]!.tasks.push(task(regularizationId));
    const { id } = await saved(await request('POST', '', { ifMatch: 0, body }));
    const target = `/${id}`;
    const detail = await request('GET', target);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      id,
      name,
      orgIds: [orgA],
      priority: 2001,
      revision: 1,
      reminder: { mode: 'off' },
      stages: body.stages,
    });
    for (const taskId of [poolId, regularizationId]) {
      const response = await api.request('DELETE', `${base}/task-pool/${taskId}`, { ...as, ifMatch: 1 });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { details: { reason: 'INTEGRATION_TASK_REFERENCED' } } });
    }
    expect(
      (await api.request('PUT', `${base}/settings`, { ...as, ifMatch: 0, body: { autoStart: true } })).status,
    ).toBe(404);
  });

  it('挂接拒绝绩效活动且原方案与成功台账保持原值', async () => {
    const { request, db, tenantId, orgA, poolId } = world;
    const body = input([orgA], poolId, 2011);
    const { id } = await saved(await request('POST', '', { ifMatch: 0, body }));
    const key = randomUUID();
    const stage = body.stages[0]!;
    const response = await request('PATCH', `/${id}`, {
      ifMatch: 1,
      idempotencyKey: key,
      body: { stages: [{ ...stage, tasks: [{ ...task(poolId), action: { type: 'performance_activity' } }] }] },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: 'VALIDATION_FAILED',
        message: '绩效活动暂未开放，请选择试用中考核或转正考核',
        details: { reason: performanceReason },
      },
    });
    expect(await (await request('GET', `/${id}`)).json()).toMatchObject({ revision: 1, stages: body.stages });
    await withTenant(db, tenantId, async (tx) => {
      expect(await tx.select().from(commandLedger).where(eq(commandLedger.commandId, key))).toEqual([]);
      const events = await tx.select().from(auditEvents).where(eq(auditEvents.objectId, id));
      expect(events.map(({ action }) => action)).toEqual(['onboarding.integration_scheme.create']);
    });
  });

  it('方案或任务开启提醒须填写正整数天数，任务日期须落在阶段内', async () => {
    const { request, orgA, poolId } = world;
    const body = input([orgA], poolId, 2012);
    const stage = body.stages[0]!;
    const { id } = await saved(
      await request('POST', '', {
        ifMatch: 0,
        body: { ...body, reminder: { mode: 'on', days: 5 } },
      }),
    );
    for (const patch of [
      { reminder: { mode: 'on' } },
      { stages: [{ ...stage, tasks: [{ ...task(poolId), reminder: { mode: 'on' } }] }] },
      { stages: [{ ...stage, tasks: [{ ...task(poolId), start: day(1) }] }] },
      { stages: [{ ...stage, tasks: [{ ...task(poolId), employeeVisible: false }] }] },
    ]) {
      expect((await request('PATCH', `/${id}`, { ifMatch: 1, body: patch })).status).toBe(400);
    }
    const response = await request('PATCH', `/${id}`, {
      ifMatch: 1,
      body: { stages: [{ ...stage, tasks: [{ ...task(poolId), reminder: { mode: 'on', days: 2 } }] }] },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ id, revision: 2 });
  });

  it('同优先级同规范范围只存一份，允许不同优先级的重叠配置', async () => {
    const { request, orgA, orgB, poolId } = world;
    const first = input([orgA, orgB], poolId, 2013);
    await saved(await request('POST', '', { ifMatch: 0, body: first }));
    const duplicate = await request('POST', '', { ifMatch: 0, body: input([orgB, orgA], poolId, 2013) });
    expect(duplicate.status).toBe(409);
    await saved(await request('POST', '', { ifMatch: 0, body: { ...first, priority: 2014 } }));
  });

  it('整份范围先于分页、修改和同键重放校验，禁止跨租户查询', async () => {
    const { request, db, as, provision, orgA, orgB, poolId } = world;
    const key = randomUUID();
    const options = { ifMatch: 0, idempotencyKey: key, body: input([orgA, orgB], poolId, 1) };
    const { id } = await saved(await request('POST', '', options));
    const allowed = await saved(await request('POST', '', { ifMatch: 0, body: input([orgA], poolId, 2) }));
    const authorizer = () => true;
    registerScopeProvider(authorizer, {
      authorize: async () => true,
      fields: async () => new Set(['integrationSchemes']),
      scope: async () => ({ all: false, orgIds: [orgA], personIds: [], hasDataPermission: true }),
    });
    const scoped = tenantApi(db, { authorize: authorizer, clock: () => now });
    const list = await scoped.request('GET', `${path}?pageSize=1`, as);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ items: [{ id: allowed.id }] });
    for (const [method, target, extra] of [
      ['GET', `${path}/${id}`, {}],
      ['PATCH', `${path}/${id}`, { ifMatch: 1, body: { orgIds: [orgA] } }],
      ['PATCH', `${path}/${allowed.id}`, { ifMatch: 1, body: { orgIds: [orgB] } }],
      ['POST', path, options],
      ['GET', `/api/tenant/commands/${key}/result`, {}],
    ] as const) {
      expect((await scoped.request(method, target, { ...as, ...extra })).status).toBe(404);
    }
    expect((await request('GET', `/${id}`, { tenant: (await provision()).tenant.id })).status).toBe(404);
  });

  it.skipIf(testDbMode() !== 'pg')('PG16 并发同优先级同范围仅一次写入和一次成功台账', async () => {
    const { request, db, tenantId, orgA, poolId } = world;
    const body = input([orgA], poolId, 2015);
    const keys = [randomUUID(), randomUUID()];
    const results = await Promise.all(
      keys.map((key) => request('POST', '', { ifMatch: 0, idempotencyKey: key, body })),
    );
    expect(results.map(({ status }) => status).sort()).toEqual([201, 409]);
    const ledger = await withTenant(db, tenantId, async (tx) =>
      Promise.all(keys.map((key) => tx.select().from(commandLedger).where(eq(commandLedger.commandId, key)))),
    );
    expect(ledger.map((rows) => rows.length).sort()).toEqual([0, 1]);
  });
});
