import { commandLedger, employmentPayloadVersions, eq, grantMembership, withTenant } from '@italent/db';
import { testDbMode, useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { failWith500, resultPath, selfTransferWorld, transferPath, withLedgerFault } from './support/f537-rollback.js';
import { cmd, errorCode, seedTenantWithMember } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('AC-F537 本人命令回滚后按原 ID 回查', () => {
  let fixture: Awaited<ReturnType<typeof selfTransferWorld>>;
  let revision: number;
  const query = (id: string, actor = fixture.actor) => fixture.api().request('GET', resultPath(id), actor);
  function submit(id: string, api = fixture.api(), departmentId = fixture.first) {
    return api.request('POST', transferPath, {
      ...fixture.actor,
      ifMatch: revision,
      idempotencyKey: id,
      body: { effectiveDate: '2026-10-19', fields: { departmentId } },
    });
  }
  async function rollback(id: string) {
    const response = await submit(id, fixture.api(withLedgerFault(database().db, failWith500)));
    expect(response.status, await response.clone().text()).toBe(500);
  }

  beforeAll(async () => {
    fixture = await selfTransferWorld(database().db);
    const profile = await fixture.api().request('GET', '/api/tenant/self-service/profile', fixture.actor);
    expect(profile.status).toBe(200);
    revision = ((await profile.json()) as { employee: { revision: number } }).employee.revision;
  });

  it('500 回滚业务，台账只留作废结论，查询返回本人未执行', async () => {
    const id = uniqueSuffix();
    await rollback(id);
    await withTenant(database().db, fixture.actor.tenant, async (tx) => {
      expect(await tx.select().from(commandLedger).where(eq(commandLedger.commandId, id))).toEqual([
        expect.objectContaining({ responseStatus: 409, actorUserId: fixture.actor.user }),
      ]);
      expect(
        await tx.select().from(employmentPayloadVersions).where(eq(employmentPayloadVersions.commandId, id)),
      ).toEqual([]);
    });
    const response = await query(id);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      commandId: id,
      status: 'not_executed',
      commandType: 'POST /api/tenant/self-service/transfer',
      businessId: null,
      businessType: null,
      revision: null,
      httpStatus: 500,
      completedAt: fixture.world.clock().toISOString(),
    });
  });

  it('执行阶段存储故障曾返回未知，持久化回滚证据后可确认未执行', async () => {
    const id = uniqueSuffix();
    const fault = withLedgerFault(database().db, () => {
      throw Object.assign(new Error('合成存储不可写'), { code: '53100' });
    });
    const failed = await submit(id, fixture.api(fault));
    expect(failed.status, await failed.clone().text()).toBe(503);
    const result = await query(id);
    expect(result.status, await result.clone().text()).toBe(200);
    expect(await result.json()).toMatchObject({ commandId: id, status: 'not_executed', httpStatus: 503 });
  });

  it('同租户其他成员及其他租户看到与无记录相同的 404', async () => {
    const id = uniqueSuffix();
    await rollback(id);
    const foreign = await seedTenantWithMember(database().db, 'f537-other');
    await grantMembership(
      database().db,
      { tenantId: foreign.tenant.id, userId: fixture.actor.user, expectedRevision: 0 },
      cmd(),
    );
    for (const actor of [
      fixture.world.as(fixture.world.hr.id),
      { user: foreign.user.id, tenant: foreign.tenant.id },
      { user: fixture.actor.user, tenant: foreign.tenant.id },
    ]) {
      const response = await query(id, actor);
      const missing = await query(uniqueSuffix(), actor);
      expect(response.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toEqual(await missing.json());
    }
  });

  it('无记录和提交回执丢失保持未知，旧业务失败不能盖过最新不确定结果', async () => {
    expect((await query(uniqueSuffix())).status).toBe(404);
    const id = uniqueSuffix();
    expect((await submit(id, fixture.api(), 'invalid-department')).status).toBe(400);
    const retry = await submit(id, fixture.api(withLedgerFault(database().db, () => {}, true)));
    expect(retry.status, await retry.clone().text()).toBe(503);
    expect(await errorCode(retry)).toBe('SERVICE_UNAVAILABLE');
    expect((await query(id)).status).toBe(404);
  });

  it.skipIf(testDbMode() !== 'pg')('同键写入在途仍未知，写入落库后保持成功回执', async () => {
    const id = uniqueSuffix();
    expect((await submit(id, fixture.api(), 'invalid-department')).status).toBe(400);
    const paused = latch();
    const resume = latch();
    const fault = withLedgerFault(database().db, async () => {
      paused.resolve();
      await resume.promise;
    });
    const retry = submit(id, fixture.api(fault));
    try {
      await Promise.race([
        paused.promise,
        retry.then(async (response) => {
          throw new Error(`重提提前结束：${response.status} ${await response.text()}`);
        }),
      ]);
      const pending = await query(id);
      expect(pending.status, await pending.clone().text()).toBe(404);
    } finally {
      resume.resolve();
      await retry;
    }
    const succeeded = await query(id);
    expect(succeeded.status).toBe(200);
    expect(await succeeded.json()).toMatchObject({ commandId: id, status: 'succeeded', httpStatus: 201 });
  });
});
