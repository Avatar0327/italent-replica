/**
 * F-120：申请人按命令 ID 只读查询自身命令结果（GET /api/tenant/commands/:commandId/result）。
 * 场景：① 员工本人调动 → succeeded + 业务 ID；② 经理暂存他人调动 → 经理可查、被调动员工 404；
 * ③ 其他用户 / 其他租户 404；④ 失败命令 → failed + httpStatus；⑤ 不存在的命令 ID 404；⑥ 查询不产生写入。
 * 设计：docs/08_设计/F-120_本人命令结果查询_路由声明.md。
 */
import { randomUUID } from 'node:crypto';
import { auditCommandFailures, auditEvents, commandLedger, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { approvalWorld, type Person } from './AC-APV-support.js';
import { addMember } from './AC-PRM-support.js';
import { transferWorld } from './AC-TRF-manager-support.js';
import { seedTenantWithMember, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const RESULT_KEYS = [
  'businessId',
  'businessType',
  'commandId',
  'commandType',
  'completedAt',
  'httpStatus',
  'revision',
  'status',
];
const resultPath = (commandId: string) => `/api/tenant/commands/${commandId}/result`;

describe('F-120 员工本人调动：按命令 ID 回查', () => {
  let world: Awaited<ReturnType<typeof approvalWorld>>;
  let api: ReturnType<typeof tenantApi>;
  let department: string;
  let self: Person;
  let other: Person;

  beforeAll(async () => {
    world = await approvalWorld(database().db, 'f120-self');
    api = tenantApi(database().db, { authorize: undefined, clock: world.clock });
    department = await world.org('合成部门');
    self = await world.person('本人', department, { place: '权限外地址' });
    other = await world.person('其他员工', department);
    await world.publishedProcess({ nodes: [{ key: 'owner_review', approver: 'owner' }] });
  });

  const query = (commandId: string, user = self.userId) =>
    api.request('GET', resultPath(commandId), { ...world.as(user) });
  const submit = async (commandId: string, fields: object) => {
    const profile = await api.request('GET', '/api/tenant/self-service/profile', world.as(self.userId));
    const revision = ((await profile.json()) as { employee: { revision: number } }).employee.revision;
    return api.request('POST', '/api/tenant/self-service/transfer', {
      ...world.as(self.userId),
      ifMatch: revision,
      idempotencyKey: commandId,
      body: { effectiveDate: '2026-10-19', fields },
    });
  };

  it('①本人提交调动后按原命令 ID 查到 succeeded 与业务 ID，只含结果摘要', async () => {
    const commandId = `f120-self-${randomUUID()}`;
    const saved = await submit(commandId, { departmentId: department });
    expect(saved.status, await saved.clone().text()).toBe(201);
    const body = (await saved.json()) as { id: string; revision: number };

    const response = await query(commandId);
    expect(response.status, await response.clone().text()).toBe(200);
    const result = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(RESULT_KEYS);
    expect(result).toMatchObject({
      commandId,
      status: 'succeeded',
      commandType: 'POST /api/tenant/self-service/transfer',
      businessType: 'transfer',
      businessId: body.id,
      revision: body.revision,
      httpStatus: 201,
    });
    expect(Number.isNaN(Date.parse(result.completedAt as string))).toBe(false);
    // 不返回业务正文
    expect(JSON.stringify(result)).not.toMatch(/权限外地址|departmentId|effectiveDate/);
    // 大小写不敏感的命令 ID 不会指向别的命令：原样查询即可
    expect((await query(commandId.toUpperCase())).status).toBe(404);
  });

  it('③同租户其他成员查同一命令 ID 为 404，与不存在无法区分', async () => {
    const commandId = `f120-self-${randomUUID()}`;
    expect((await submit(commandId, { departmentId: department })).status).toBe(201);
    expect((await query(commandId)).status).toBe(200);
    const foreign = await query(commandId, other.userId);
    const missing = await query(`f120-missing-${randomUUID()}`, other.userId);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    const strip = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;
    expect(await strip(foreign)).toBe(await strip(missing));
  });

  it('③其他租户的成员查同一命令 ID 为 404（同一用户换租户也查不到）', async () => {
    const commandId = `f120-self-${randomUUID()}`;
    expect((await submit(commandId, { departmentId: department })).status).toBe(201);
    expect((await query(commandId)).status).toBe(200);
    const stranger = await seedTenantWithMember(database().db, 'f120-stranger');
    const crossTenant = await api.request('GET', resultPath(commandId), {
      user: stranger.user.id,
      tenant: stranger.tenant.id,
    });
    expect(crossTenant.status).toBe(404);
    const wrongTenant = await api.request('GET', resultPath(commandId), {
      user: self.userId,
      tenant: stranger.tenant.id,
    });
    expect([403, 404]).toContain(wrongTenant.status);
  });

  it('⑤不存在或格式不合法的命令 ID：404 / 400，不得当成确定失败的依据', async () => {
    expect((await query(`f120-missing-${randomUUID()}`)).status).toBe(404);
    expect((await query('bad id')).status).toBe(400);
    expect((await query(`x${'y'.repeat(120)}`)).status).toBe(400);
  });

  it('⑥查询不产生任何写入（台账、审计、失败审计行数不变）', async () => {
    const commandId = `f120-self-${randomUUID()}`;
    expect((await submit(commandId, { departmentId: department })).status).toBe(201);
    const counts = () =>
      withTenant(database().db, world.tenant.id, async (tx) => ({
        ledger: (await tx.select({ n: sql<number>`count(*)::int` }).from(commandLedger))[0]!.n,
        audit: (await tx.select({ n: sql<number>`count(*)::int` }).from(auditEvents))[0]!.n,
        failures: (await tx.select({ n: sql<number>`count(*)::int` }).from(auditCommandFailures))[0]!.n,
      }));
    const before = await counts();
    expect((await query(commandId)).status).toBe(200);
    expect((await query(`f120-missing-${randomUUID()}`)).status).toBe(404);
    expect((await query(commandId, other.userId)).status).toBe(404);
    expect(await counts()).toEqual(before);
  });
});

describe('F-120 经理调动他人：仅经理本人可查', () => {
  let world: Awaited<ReturnType<typeof transferWorld>>;
  let manager: { user: string; tenant: string };
  let subject: { user: string; tenant: string };
  let member: { id: string; revision: number };
  let child: { id: string; revision: number };

  beforeAll(async () => {
    world = await transferWorld(database().db);
    const user = await addMember(world, 'f120-manager');
    manager = { user: user.id, tenant: world.tenant.id };
    const own = await world.person(world.outside.id, manager);
    const updated = await world.setup.request('PATCH', `/api/tenant/org/organizations/${world.inside.id}`, {
      ...world.asAdmin,
      ifMatch: world.inside.revision,
      body: { effectiveDate: '2026-01-02', personInChargeId: own.id },
    });
    expect(updated.status, await updated.clone().text()).toBe(200);
    const response = await world.setup.request('POST', '/api/tenant/org/organizations', {
      ...world.asAdmin,
      ifMatch: 0,
      body: { name: 'F-120 下级部门', establishedOn: '2025-01-01', parents: { admin: { parentId: world.inside.id } } },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    child = (await response.json()) as typeof child;
    const subjectUser = await addMember(world, 'f120-subject');
    subject = { user: subjectUser.id, tenant: world.tenant.id };
    member = await world.person(child.id, subject);
  });

  const query = (commandId: string, as: { user: string; tenant: string }) =>
    world.api.request('GET', resultPath(commandId), as);
  const transfer = async (commandId: string, fields: object) =>
    world.api.request('POST', `/api/tenant/employment/transfers/employees/${member.id}`, {
      ...manager,
      ifMatch: await world.currentRevision(member),
      idempotencyKey: commandId,
      body: {
        initiator: 'manager',
        transferTypeCode: 'cross_department',
        formId: 'TenantBase.TransferMultiFormView',
        effectiveDate: '2026-10-01',
        mode: 'application',
        fields,
      },
    });

  it('②经理暂存他人调动：经理本人查到 succeeded，被调动员工查同一命令 ID 为 404', async () => {
    const commandId = `f120-mgr-${randomUUID()}`;
    const saved = await transfer(commandId, { departmentId: child.id });
    expect(saved.status, await saved.clone().text()).toBe(201);
    const body = (await saved.json()) as { id: string; revision: number };

    const mine = await query(commandId, manager);
    expect(mine.status, await mine.clone().text()).toBe(200);
    expect(await mine.json()).toMatchObject({
      commandId,
      status: 'succeeded',
      commandType: 'POST /api/tenant/employment/transfers/employees/:id',
      businessType: 'transfer',
      businessId: body.id,
      revision: body.revision,
      httpStatus: 201,
    });
    // 被调动员工本人、租户管理员都不是命令发起人
    expect((await query(commandId, subject)).status).toBe(404);
    expect((await query(commandId, world.asAdmin)).status).toBe(404);
    // 经理看不到别人的命令
    const adminCommand = `f120-adm-${randomUUID()}`;
    const adminSaved = await world.setup.request('POST', '/api/tenant/org/organizations', {
      ...world.asAdmin,
      ifMatch: 0,
      idempotencyKey: adminCommand,
      body: {
        name: 'F-120 管理员建部门',
        establishedOn: '2025-01-01',
        parents: { admin: { parentId: world.inside.id } },
      },
    });
    expect(adminSaved.status, await adminSaved.clone().text()).toBe(201);
    expect((await query(adminCommand, world.asAdmin)).status).toBe(200);
    expect((await query(adminCommand, manager)).status).toBe(404);
  });

  it('④失败命令：返回 failed 与原响应的 httpStatus，不含业务 ID', async () => {
    const commandId = `f120-fail-${randomUUID()}`;
    const rejected = await transfer(commandId, { departmentId: 'not-a-uuid' });
    expect(rejected.status).toBeGreaterThanOrEqual(400);
    expect(rejected.status).toBeLessThan(500);

    const response = await query(commandId, manager);
    expect(response.status, await response.clone().text()).toBe(200);
    const result = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(RESULT_KEYS);
    expect(result).toMatchObject({
      commandId,
      status: 'failed',
      commandType: 'POST /api/tenant/employment/transfers/employees/:id',
      businessId: null,
      businessType: null,
      revision: null,
      httpStatus: rejected.status,
    });
    expect((await query(commandId, subject)).status).toBe(404);
  });

  it('④失败后用同一命令 ID 重提成功：以台账为准返回 succeeded', async () => {
    const commandId = `f120-retry-${randomUUID()}`;
    expect((await transfer(commandId, { departmentId: 'not-a-uuid' })).status).toBeGreaterThanOrEqual(400);
    const saved = await transfer(commandId, { departmentId: child.id });
    expect(saved.status, await saved.clone().text()).toBe(201);
    expect(await (await query(commandId, manager)).json()).toMatchObject({ status: 'succeeded', httpStatus: 201 });
  });
});
