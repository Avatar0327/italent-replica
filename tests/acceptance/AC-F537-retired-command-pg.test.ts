import { auditCommandFailures, commandLedger, createPgDb, eq, sql, withTenant, type Db, type Tx } from '@italent/db';
import { createTestDb, testDbMode } from '@italent/testkit';
import { expect, it, vi } from 'vitest';
import { failWith500, resultPath, selfTransferWorld, transferPath, withLedgerFault } from './support/f537-rollback.js';
import { errorCode } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

function latch<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function find<T>(rows: unknown): T {
  return (rows as T[])[0]!;
}
function hookLock(
  db: Db,
  name: string,
  hook: (execute: Tx['execute'], statement: Parameters<Tx['execute']>[0]) => Promise<unknown>,
): Db {
  const wrapped = Object.create(db) as Db;
  wrapped.transaction = (async (fn: Parameters<Db['transaction']>[0]) =>
    db.transaction(async (tx) => {
      const execute = tx.execute.bind(tx);
      tx.execute = ((statement: Parameters<Tx['execute']>[0]) => {
        const prefix =
          typeof statement === 'string'
            ? statement
            : (statement.getSQL().queryChunks[0] as { value?: string[] } | undefined)?.value?.join('');
        return prefix?.startsWith(`SELECT ${name}(`) ? hook(execute, statement) : execute(statement);
      }) as Tx['execute'];
      return fn(tx);
    })) as Db['transaction'];
  return wrapped;
}

// app / app_owner 登录角色只在普通角色分片由 scripts/pg-roles.sql 建出（REQUIRE_APP_ROLE=1，约定同 AC-CI-F212）；
// 普通 PG 分片与 PGlite 没有这两个角色，连接会报认证失败，故跳过。
it.skipIf(testDbMode() !== 'pg' || process.env.REQUIRE_APP_ROLE !== '1').each(['app', 'app_owner'])(
  'AC-F537 P2-1 GET 先锁、旧键 POST 排队及晚到均被拒，回执恒为未执行 (%s)',
  async (role) => {
    const owner = await createTestDb();
    const name = find<{ name: string }>(await owner.db.execute(sql`SELECT current_database() AS name`)).name;
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.username = role;
    // scripts/pg-roles.sql 里两个角色的口令与角色同名；沿用原 URL 的口令会在 CI 的 postgres:postgres 下认证失败
    url.password = role;
    url.pathname = `/${name}`;
    const runtime = createPgDb(url.toString(), { max: 3 });
    try {
      const { api, actor, first } = await selfTransferWorld(owner.db);
      const profile = await api(runtime.db).request('GET', '/api/tenant/self-service/profile', actor);
      expect(profile.status, await profile.clone().text()).toBe(200);
      const {
        employee: { revision },
      } = (await profile.json()) as { employee: { revision: number } };
      const id = uniqueSuffix();
      const submit = (db: Db) =>
        api(db).request('POST', transferPath, {
          ...actor,
          ifMatch: revision,
          idempotencyKey: id,
          body: { effectiveDate: '2026-10-19', fields: { departmentId: first } },
        });
      const initial = await submit(withLedgerFault(runtime.db, failWith500));
      expect(initial.status, await initial.clone().text()).toBe(500);

      const gotReaderLock = latch<number>();
      const releaseReader = latch<void>();
      const writerPid = latch<number>();
      const reader = hookLock(runtime.db, 'pg_try_advisory_xact_lock', async (execute, statement) => {
        const result = await execute(statement);
        expect(find<{ entered: boolean }>(result).entered).toBe(true);
        gotReaderLock.resolve(find<{ pid: number }>(await execute(sql`SELECT pg_backend_pid() AS pid`)).pid);
        await releaseReader.promise;
        return result;
      });
      const writer = hookLock(runtime.db, 'pg_advisory_xact_lock_shared', async (execute, statement) => {
        writerPid.resolve(find<{ pid: number }>(await execute(sql`SELECT pg_backend_pid() AS pid`)).pid);
        return execute(statement);
      });
      const query = api(reader).request('GET', resultPath(id), actor);
      let retry: Promise<Response> | undefined;
      try {
        const blocker = await Promise.race([
          gotReaderLock.promise,
          query.then(async (response) => {
            throw new Error(`GET 未进入屏障 ${response.status}: ${await response.clone().text()}`);
          }),
        ]);
        retry = submit(writer);
        const waiting = await Promise.race([
          writerPid.promise,
          retry.then(async (response) => {
            throw new Error(`POST 未进入屏障 ${response.status}: ${await response.clone().text()}`);
          }),
        ]);
        await vi.waitFor(
          async () => {
            const { blockers } = find<{ blockers: number[] }>(
              await owner.db.execute(sql`SELECT pg_blocking_pids(${waiting}) AS blockers`),
            );
            expect(blockers).toContain(blocker);
          },
          { timeout: 5000 },
        );
      } finally {
        releaseReader.resolve();
        if (retry) await Promise.allSettled([query, retry]);
      }
      const before = await query;
      const write = await retry!;
      const after = await api(runtime.db).request('GET', resultPath(id), actor);
      expect(before.status).toBe(200);
      const beforeBody = await before.json();
      expect(beforeBody).toMatchObject({ commandId: id, status: 'not_executed' });
      expect(write.status, '排队的旧键 POST 必须被确定拒绝').toBe(409);
      expect(await errorCode(write)).toBe('COMMAND_VOIDED');
      expect(after.status).toBe(200);
      expect(await after.json()).toEqual(beforeBody);
      const late = await submit(runtime.db);
      expect(late.status).toBe(409);
      expect(await errorCode(late)).toBe('COMMAND_VOIDED');
      await withTenant(runtime.db, actor.tenant, async (tx) => {
        expect(
          await tx.select().from(auditCommandFailures).where(eq(auditCommandFailures.commandId, id)),
        ).toContainEqual(expect.objectContaining({ confirmedRollback: true, actorUserId: actor.user }));
        expect(await tx.select().from(commandLedger).where(eq(commandLedger.commandId, id))).toEqual([
          expect.objectContaining({ responseStatus: 409, actorUserId: actor.user }),
        ]);
      });
    } finally {
      await runtime.close();
      await owner.close();
    }
  },
);
