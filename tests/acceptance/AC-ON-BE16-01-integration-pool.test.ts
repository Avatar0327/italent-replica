import { randomUUID } from 'node:crypto';
import { auditEvents, commandLedger, eq, grantMembership, pgErrorCode, sql, withTenant } from '@italent/db';
import { testDbMode, useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { lockIntegrationPoolTaskForAttachment } from '../../apps/api/src/modules/onboarding/integration-pool.js';
import { grantStandardProfile } from '../../apps/api/src/modules/permission/standard-profiles.js';
import { provisionTenant } from '../../apps/api/src/modules/platform/provisioning.js';
import { newUser, seedOperator } from './support/platform-api.js';
import { cmd, tenantApi, type RequestOptions } from './support/tenant-api.js';

const testDb = useTestDb();
const path = '/api/tenant/onboarding/integration/task-pool';
const now = new Date('2026-11-21T08:00:00Z');

async function fixture() {
  const { db } = testDb();
  const ops = await seedOperator(db, 'ZZ_BE16_POOL_OPS');
  const admin = await newUser(db, 'ZZ_BE16_POOL_ADMIN');
  const hr = await newUser(db, 'ZZ_BE16_POOL_HR');
  const provision = () =>
    provisionTenant(
      db,
      {
        code: `ZZ_BE16_${randomUUID()}`,
        name: 'ZZ_BE16_POOL',
        firstAdminUserId: admin.id,
        exceptionAdminUserId: admin.id,
      },
      cmd(ops.id),
      now,
    );
  const home = await provision();
  const tenantId = home.tenant.id;
  const api = tenantApi(db, { authorize: undefined, clock: () => now });
  await grantMembership(db, { tenantId, userId: hr.id, expectedRevision: 0 }, cmd(ops.id));
  await withTenant(db, tenantId, (tx) =>
    grantStandardProfile(
      tx,
      { tenantId, actorUserId: ops.id, now, commandId: randomUUID() },
      { userId: hr.id, profile: home.profiles.find(({ code }) => code === 'standard_hr_specialist')! },
    ),
  );
  const request = (method: string, suffix: string, options: RequestOptions = {}) =>
    api.request(method, path + suffix, { user: admin.id, tenant: tenantId, ...options });
  return { db, tenantId, api, admin, hr, provision, request };
}

const assessment = (assessmentType: string, name = 'ZZ_BE16_考核') => ({
  type: 'assessment',
  assessmentType,
  name,
});
const createBody = (code: string, action: unknown = assessment('probation'), category = 'probation_assessment') => ({
  code,
  name: 'ZZ_BE16_任务',
  category,
  action,
});

const performanceError = {
  error: {
    code: 'VALIDATION_FAILED',
    message: '绩效活动暂未开放，请选择试用中考核或转正考核',
    details: { reason: 'INTEGRATION_PERFORMANCE_ACTIVITY_UNAVAILABLE' },
  },
};

describe('AC-ON-BE16-01 融入任务池设置', () => {
  it('九类别保序，三类暂缓，选择项只提供两类现有审批考核', async () => {
    const { request } = await fixture();
    const response = await request('GET', '/categories');
    expect(response.status).toBe(200);
    const dictionary = await response.json();
    expect(dictionary).toMatchObject({
      items: [
        { code: 'administrative', name: '行政事项', enabled: true },
        { code: 'team_integration', name: '团队融入', enabled: true },
        { code: 'work_integration', name: '工作融入', enabled: true },
        { code: 'new_employee_introduction', name: '新员工介绍', enabled: true },
        { code: 'probation_assessment', name: '试用期考核', enabled: true },
        { code: 'learning_plan', name: '学习计划', enabled: false },
        { code: 'probation_goal_plan', name: '试用期目标计划', enabled: false },
        { code: 'survey', name: '问卷调查', enabled: false },
        { code: 'other', name: '其他', enabled: true },
      ],
      assessmentTypes: [{ code: 'probation' }, { code: 'regularization' }],
    });
    for (const category of ['learning_plan', 'probation_goal_plan', 'survey']) {
      const denied = await request('POST', '', {
        ifMatch: 0,
        body: createBody('ZZ_BE16_DISABLED', { type: 'form', fields: [] }, category),
      });
      expect(denied.status).toBe(400);
    }
    const list = await request('GET', '');
    expect(await list.json()).toMatchObject({ items: [], availableActions: ['create'] });
  });

  it('保存两类审批考核和合法表单，校验类别、动作和名称的搭配', async () => {
    const { request } = await fixture();
    for (const type of ['probation', 'regularization']) {
      const body = createBody(`ZZ_BE16_${type}`, assessment(type));
      const created = await request('POST', '', { ifMatch: 0, body });
      expect(created.status).toBe(201);
      const receipt = await created.json();
      expect(receipt).toEqual({ id: expect.any(String), revision: 1, status: 'enabled' });
      const detail = await request('GET', `/${receipt.id}`);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({
        ...body,
        revision: 1,
        availableActions: ['edit', 'delete'],
      });
    }

    const form = { type: 'form', fields: [{ code: 'summary', label: 'ZZ_BE16_说明', kind: 'text', required: true }] };
    const saved = await request('POST', '', { ifMatch: 0, body: createBody('ZZ_BE16_FORM', form, 'administrative') });
    expect(saved.status).toBe(201);
    const listed = await request('GET', '?category=administrative&pageSize=1');
    expect(await listed.json()).toMatchObject({ items: [{ code: 'ZZ_BE16_FORM', action: form }] });
    for (const invalid of [
      createBody('ZZ_BE16_FORM_AS_ASSESSMENT', form),
      createBody('ZZ_BE16_ASSESSMENT_AS_FORM', assessment('probation'), 'other'),
      createBody('ZZ_BE16_EMPTY_NAME', assessment('regularization', '   ')),
      createBody('ZZ_BE16_UNKNOWN_ACTION', assessment('other')),
      createBody('ZZ_BE16_DUPLICATE_FIELD', { ...form, fields: [...form.fields, ...form.fields] }, 'other'),
    ]) {
      const denied = await request('POST', '', { ifMatch: 0, body: invalid });
      expect(denied.status).toBe(400);
    }
  });

  it('直接新建与局部更新拒绝绩效活动，保留原配置、revision、审计和成功台账', async () => {
    const { request, db, tenantId } = await fixture();
    const createKey = randomUUID();
    const opened = await request('POST', '', {
      ifMatch: 0,
      idempotencyKey: createKey,
      body: createBody('ZZ_BE16_PERF', { type: 'performance_activity' }),
    });
    expect(opened.status).toBe(400);
    expect(await opened.json()).toEqual(performanceError);

    const body = createBody('ZZ_BE16_KEEP');
    const created = await request('POST', '', { ifMatch: 0, body });
    expect(created.status).toBe(201);
    const { id } = await created.json();
    const target = `/${id}`;
    const idempotencyKey = randomUUID();
    const patch = await request('PATCH', target, {
      ifMatch: 1,
      idempotencyKey,
      body: { action: assessment('performance_activity') },
    });
    expect(patch.status).toBe(400);
    expect(await patch.json()).toEqual(performanceError);
    expect(await (await request('GET', target)).json()).toMatchObject({ ...body, revision: 1 });
    expect(await (await request('GET', '')).json()).toMatchObject({ items: [{ id }] });

    await withTenant(db, tenantId, async (tx) => {
      for (const key of [createKey, idempotencyKey])
        expect(await tx.select().from(commandLedger).where(eq(commandLedger.commandId, key))).toEqual([]);
      const audits = await tx.select().from(auditEvents).where(eq(auditEvents.objectId, id));
      expect(audits.map(({ action }) => action)).toEqual(['onboarding.integration_pool.create']);
    });

    const edited = await request('PATCH', target, {
      ifMatch: 1,
      idempotencyKey,
      body: { name: 'ZZ_BE16_已修改', enabled: false },
    });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toEqual({ id, revision: 2, status: 'disabled' });
    await expect(
      withTenant(db, tenantId, (tx) => lockIntegrationPoolTaskForAttachment(tx, tenantId, id)),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'INTEGRATION_TASK_DISABLED' } });
  });

  it('同租户组合外键阻止删除被引用项，解除引用后可删除并重放 204', async () => {
    const { request, db, tenantId, provision } = await fixture();
    const created = await request('POST', '', { ifMatch: 0, body: createBody('ZZ_BE16_REFERENCED') });
    expect(created.status).toBe(201);
    const { id } = await created.json();
    // 用真实约束模拟后续方案的组合外键，16b-0 没有生产方案表。
    await db.execute(sql`
      CREATE TABLE zz_be16_pool_reference (
        tenant_id uuid NOT NULL, pool_id uuid NOT NULL,
        FOREIGN KEY (tenant_id, pool_id) REFERENCES onboarding_integration_task_pool(tenant_id, id)
          ON DELETE RESTRICT
      )
    `);
    await db.execute(sql`SELECT enable_tenant_isolation('zz_be16_pool_reference')`);
    await db.execute(sql`GRANT SELECT, INSERT, DELETE ON zz_be16_pool_reference TO app_user`);
    const otherTenant = (await provision()).tenant.id;
    const reference = (owner: string) =>
      withTenant(db, owner, (tx) =>
        tx.execute(sql`INSERT INTO zz_be16_pool_reference VALUES (${owner}::uuid, ${id}::uuid)`),
      );
    await expect(reference(otherTenant).catch(pgErrorCode)).resolves.toBe('23503');
    await withTenant(db, tenantId, async (tx) => {
      await expect(lockIntegrationPoolTaskForAttachment(tx, tenantId, id)).resolves.toMatchObject({
        id,
        action: assessment('probation'),
        revision: 1,
      });
      await tx.execute(sql`INSERT INTO zz_be16_pool_reference VALUES (${tenantId}::uuid, ${id}::uuid)`);
    });
    const target = `/${id}`;
    const blocked = await request('DELETE', target, { ifMatch: 1 });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { details: { reason: 'INTEGRATION_TASK_REFERENCED' } } });
    expect((await request('GET', target)).status).toBe(200);

    await withTenant(db, tenantId, (tx) => tx.execute(sql`DELETE FROM zz_be16_pool_reference`));
    const idempotencyKey = randomUUID();
    for (const ifMatch of [0, 1, 1]) {
      const response = await request('DELETE', target, { ifMatch, idempotencyKey });
      expect(response.status).toBe(ifMatch === 0 ? 409 : 204);
    }
    expect((await request('GET', target)).status).toBe(404);
  });

  it('HR 设置权限失败、跨租户不可查改、同键重放按当前设置权限重验', async () => {
    const { request, db, tenantId, hr, admin, provision, api } = await fixture();
    const idempotencyKey = randomUUID();
    const options = { ifMatch: 0, idempotencyKey, body: createBody('ZZ_BE16_SCOPE') };
    const created = await request('POST', '', options);
    expect(created.status).toBe(201);
    const receipt = await created.json();
    const suffix = `/${receipt.id}`;
    expect(await (await request('POST', '', options)).json()).toEqual(receipt);
    const result = () =>
      api.request('GET', `/api/tenant/commands/${idempotencyKey}/result`, { user: admin.id, tenant: tenantId });
    expect(await (await result()).json()).toEqual({
      status: 'succeeded',
      commandType: `POST ${path}`,
      businessId: receipt.id,
      revision: 1,
      httpStatus: 201,
    });
    expect((await request('GET', '', { user: hr.id })).status).toBe(403);
    expect((await request('GET', suffix, { user: hr.id })).status).toBe(403);
    expect((await request('POST', '', { ...options, user: hr.id })).status).toBe(403);
    const otherTenant = (await provision()).tenant.id;
    expect(await (await request('GET', '', { tenant: otherTenant })).json()).toMatchObject({ items: [] });
    expect((await request('GET', suffix, { tenant: otherTenant })).status).toBe(404);
    expect(
      (
        await request('PATCH', suffix, {
          tenant: otherTenant,
          ifMatch: 1,
          body: { name: 'ZZ_BE16_越界' },
        })
      ).status,
    ).toBe(404);

    await withTenant(db, tenantId, (tx) =>
      tx.execute(sql`UPDATE permission_admins SET status = 'revoked' WHERE user_id = ${admin.id}::uuid`),
    );
    expect((await request('POST', '', options)).status).toBe(403);
    expect((await result()).status).toBe(403);
  });

  it.skipIf(testDbMode() !== 'pg')('双连接创建同一租户任务编码只保存一条', async () => {
    const { request } = await fixture();
    const body = createBody('ZZ_BE16_CONCURRENT');
    const results = await Promise.all([
      request('POST', '', { ifMatch: 0, body }),
      request('POST', '', { ifMatch: 0, body }),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual([201, 409]);
    expect(await (await request('GET', '')).json()).toMatchObject({ items: [{ code: body.code, revision: 1 }] });
  });
});
