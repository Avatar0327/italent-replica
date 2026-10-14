/**
 * F-120 第 2 轮返工（Codex 第 1 轮审查 3 项 P2，真实 HTTP 序列）：
 * ① 同键重试结果未知时不得返回旧的确定失败；② 模块自有错误码按写接口实际状态返回，找不到映射为 null；
 * ③ 命令 ID 在台账中属于他人（含 actor 为空的历史 / 系统行）一律 404，不回退到失败审计。
 * 设计：docs/08_设计/F-120_本人命令结果查询_路由声明.md。
 */
import { randomUUID } from 'node:crypto';
import { commandLedger, type Db, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { addMember } from './AC-PRM-support.js';
import { transferWorld } from './AC-TRF-manager-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const resultPath = (commandId: string) => `/api/tenant/commands/${commandId}/result`;
const LOST = new Error('test rollback');

/** 事务回调返回后若本命令的台账行已写入，就回滚并报告连接中断：模拟“提交请求已发出、结果没有回来”（提交阶段 unknown）。 */
function lostCommitFor(db: Db, commandId: string): Db {
  const wrapper = Object.create(db) as Db;
  wrapper.transaction = (async (fn: Parameters<Db['transaction']>[0]) => {
    try {
      return await db.transaction(async (tx) => {
        const value = await fn(tx);
        // 非租户事务（无 app_user 角色）读台账会被拒：用保存点隔离，只在租户命令事务里判断
        const written = await tx
          .transaction(async (probe) => probe.select({ id: commandLedger.commandId }).from(commandLedger))
          .catch(() => []);
        if (written.some((row) => row.id === commandId)) throw LOST;
        return value;
      });
    } catch (error) {
      if (error !== LOST) throw error;
      throw Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
    }
  }) as Db['transaction'];
  return wrapper;
}

describe('F-120 第 2 轮：本人命令结果的归属与结果未知', () => {
  let world: Awaited<ReturnType<typeof transferWorld>>;
  const at = (iso: string) => () => new Date(iso);
  const query = (commandId: string, as: { user: string; tenant: string }) =>
    world.api.request('GET', resultPath(commandId), as);
  const org = (api: ReturnType<typeof tenantApi>, commandId: string, body: object, as = world.asAdmin) =>
    api.request('POST', '/api/tenant/org/organizations', { ...as, ifMatch: 0, idempotencyKey: commandId, body });
  const validOrg = () => ({
    name: `F-120 部门 ${uniqueSuffix()}`,
    establishedOn: '2025-01-01',
    parents: { admin: { parentId: world.inside.id } },
  });

  beforeAll(async () => {
    world = await transferWorld(database().db);
  });

  it('P2-1 同键重试结果未知：最新记录是 unknown 时返回 404，不返回旧的 failed；之后再确定失败则以最新为准', async () => {
    const db = database().db;
    const commandId = `f120-r2-unknown-${randomUUID()}`;
    const first = await org(world.setup, commandId, {});
    expect(first.status).toBe(400);
    expect((await (await query(commandId, world.asAdmin)).json()) as object).toMatchObject({ status: 'failed' });

    const lost = tenantApi(lostCommitFor(db, commandId), { clock: at('2026-10-01T02:00:00.000Z') });
    const retry = await org(lost, commandId, validOrg());
    expect(retry.status, await retry.clone().text()).toBe(503);
    expect(((await retry.json()) as { error: { details?: { reason?: string } } }).error.details?.reason).toBe(
      'RESULT_UNKNOWN',
    );
    const unknown = await query(commandId, world.asAdmin);
    expect(unknown.status, await unknown.clone().text()).toBe(404);

    const later = tenantApi(db, { clock: at('2026-10-01T03:00:00.000Z') });
    expect((await org(later, commandId, {})).status).toBe(400);
    const failed = await query(commandId, world.asAdmin);
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({ status: 'failed', httpStatus: 400 });
  });

  it('P2-2 模块自有错误码：HR 提交早于入职周期的调动，回查 httpStatus 与写接口实际返回的 409 一致', async () => {
    const person = await world.person(world.inside.id, undefined, undefined, { effectiveDate: '2026-09-01' });
    const hr = await world.actor('f120-hr');
    await world.settings(true);
    const commandId = `f120-r2-module-${randomUUID()}`;
    const rejected = await world.api.request('POST', `/api/tenant/employment/transfers/employees/${person.id}`, {
      ...hr,
      ifMatch: person.revision,
      idempotencyKey: commandId,
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        formId: 'TenantBase.CrossDepartmentTransferMultiFormView',
        effectiveDate: '2026-08-01',
        mode: 'application',
        fields: { departmentId: world.outside.id },
      },
    });
    expect(rejected.status, await rejected.clone().text()).toBe(409);
    expect(((await rejected.json()) as { error: { code: string } }).error.code).toBe('EMPLOYMENT_BEFORE_CYCLE_ENTRY');

    const result = await query(commandId, hr);
    expect(result.status, await result.clone().text()).toBe(200);
    expect(await result.json()).toMatchObject({ status: 'failed', httpStatus: 409 });
  });

  it('P2-3 命令 ID 已属于他人：碰撞失败审计、actor 为空的历史行都不得让非本人查到 200', async () => {
    const db = database().db;
    const other = await addMember(world, 'f120-round2-other');
    const stranger = { user: other.id, tenant: world.tenant.id };
    const commandId = `f120-r2-owned-${randomUUID()}`;
    const created = await org(world.setup, commandId, validOrg());
    expect(created.status, await created.clone().text()).toBe(201);
    // B 用 A 的命令 ID 提交写请求：409 IDEMPOTENCY_CONFLICT，并留下 B 自己的失败审计
    const collided = await org(world.setup, commandId, validOrg(), stranger);
    expect(collided.status).toBe(409);
    expect((await query(commandId, world.asAdmin)).status).toBe(200);
    const foreign = await query(commandId, stranger);
    expect(foreign.status, await foreign.clone().text()).toBe(404);

    // 历史 / 系统行（actor 为空）：同样视为已归属，不回退到失败审计
    const legacyId = `f120-r2-legacy-${randomUUID()}`;
    await withTenant(db, world.tenant.id, (tx) =>
      tx.insert(commandLedger).values({
        tenantId: world.tenant.id,
        commandId: legacyId,
        requestHash: 'legacy',
        responseStatus: 201,
        responseBody: {},
      }),
    );
    expect((await org(world.setup, legacyId, validOrg(), stranger)).status).toBe(409);
    expect((await query(legacyId, stranger)).status).toBe(404);
    expect((await query(legacyId, world.asAdmin)).status).toBe(404);
  });

  // 第 3 轮：最新时间整组判定，不受固定窗口限制（Codex 第 2 轮审查 P2，与第 1 轮 P2-1 同类）
  async function unknownThen(commandId: string, unknownAt: string) {
    const lost = tenantApi(lostCommitFor(database().db, commandId), { clock: at(unknownAt) });
    const retry = await org(lost, commandId, validOrg());
    expect(retry.status, await retry.clone().text()).toBe(503);
  }
  async function businessFailures(commandId: string, count: number, failedAt: string) {
    const api = tenantApi(database().db, { clock: at(failedAt) });
    for (let i = 0; i < count; i += 1) expect((await org(api, commandId, {})).status).toBe(400);
  }

  it('P2-R3 最新时间同刻 1 条 unknown + 21 条业务失败（超过任何固定窗口）：返回 404', async () => {
    const commandId = `f120-r3-tie-${randomUUID()}`;
    await unknownThen(commandId, '2026-10-02T02:00:00.000Z');
    await businessFailures(commandId, 21, '2026-10-02T02:00:00.000Z');
    const result = await query(commandId, world.asAdmin);
    expect(result.status, await result.clone().text()).toBe(404);
  });

  it('P2-R3 对照：最新时间整组都是确定失败（21 条）→ 200 failed / 400', async () => {
    const commandId = `f120-r3-allfail-${randomUUID()}`;
    await businessFailures(commandId, 21, '2026-10-03T02:00:00.000Z');
    const result = await query(commandId, world.asAdmin);
    expect(result.status, await result.clone().text()).toBe(200);
    expect(await result.json()).toMatchObject({
      status: 'failed',
      httpStatus: 400,
      completedAt: '2026-10-03T02:00:00.000Z',
    });
  });

  it('P2-R3 对照：unknown 早于最新一组确定失败（21 条）→ 以最新组为准，200 failed / 400', async () => {
    const commandId = `f120-r3-older-${randomUUID()}`;
    await unknownThen(commandId, '2026-10-04T01:00:00.000Z');
    await businessFailures(commandId, 21, '2026-10-04T02:00:00.000Z');
    const result = await query(commandId, world.asAdmin);
    expect(result.status, await result.clone().text()).toBe(200);
    expect(await result.json()).toMatchObject({
      status: 'failed',
      httpStatus: 400,
      completedAt: '2026-10-04T02:00:00.000Z',
    });
  });
});
