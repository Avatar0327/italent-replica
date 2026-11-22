import { randomUUID } from 'node:crypto';
import { createApp } from '@italent/api';
import {
  and,
  auditEvents,
  employmentBusinessObjects,
  employmentEmployees,
  employmentOutbox,
  eq,
  onboardingEntryCases,
  pgErrorCode,
  sql,
  type Db,
  withTenant,
} from '@italent/db';
import { createTestDb, testDbMode, useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { completePendingEntry } from '../../apps/api/src/modules/employment/employee-status.js';
import { entryLifecyclePort } from '../../apps/api/src/modules/employment/onboarding-entry-port.js';
import { addPending, entryWorld, portContext } from './AC-EN-BE2a-support.js';
import { seedTenantWithMember } from './support/tenant-api.js';

const testDb = useTestDb();
const now = new Date('2026-10-20T08:00:00Z');
const pendingDate = '2026-10-22';
const cases = onboardingEntryCases;
const NOT_CURRENT = { code: 'CONFLICT', details: { reason: 'ENTRY_CASE_NOT_CURRENT' } };
const ONBOARDING = '/api/tenant/onboarding';
const TASK_POOL = `${ONBOARDING}/integration/task-pool`;
const SCHEMES = `${ONBOARDING}/integration/schemes`;

async function fixture(label: string, db = testDb().db) {
  const { tenant, user } = await seedTenantWithMember(db, label);
  return withTenant(db, tenant.id, async (tx) => {
    const [employee] = await tx.insert(employmentEmployees).values({ tenantId: tenant.id, name: label }).returning();
    const businessIds = [randomUUID(), randomUUID(), randomUUID()];
    await tx
      .insert(employmentBusinessObjects)
      .values(businessIds.map((id) => ({ id, tenantId: tenant.id, employeeId: employee!.id })));
    const context = () => ({
      tenantId: tenant.id,
      userId: user.id,
      timezone: tenant.timezone,
      commandId: randomUUID(),
      now,
    });
    return {
      db,
      run: <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, tenant.id, fn),
      context,
      entry: { employeeId: employee!.id, businessId: businessIds[0]!, pendingDate },
      replacements: [businessIds[1]!, businessIds[2]!] as const,
    };
  });
}

function install(db: Db) {
  const app = createApp({ db });
  return { port: entryLifecyclePort(), app };
}

describe('AC-EN-BE16-01 阶段事务端口', () => {
  it('建立阶段并随替换和取消恢复保持同一 ID，拒绝旧 ID 与删除后写入', async () => {
    const f = await fixture('ZZ_BE16_LIFECYCLE');
    const { entry, run, context, replacements } = f;
    const { port, app } = install(f.db);
    const onboardingRoutes = app.routes
      .filter(({ path }) => path.startsWith(ONBOARDING))
      .map(({ method, path }) => `${method} ${path}`)
      .sort();
    expect(onboardingRoutes).toEqual([
      `DELETE ${SCHEMES}/:id`,
      `DELETE ${TASK_POOL}/:id`,
      `GET ${SCHEMES}`,
      `GET ${SCHEMES}/:id`,
      `GET ${TASK_POOL}`,
      `GET ${TASK_POOL}/:id`,
      `GET ${TASK_POOL}/categories`,
      `PATCH ${SCHEMES}/:id`,
      `PATCH ${TASK_POOL}/:id`,
      `POST ${SCHEMES}`,
      `POST ${TASK_POOL}`,
    ]);
    const created = await run((tx) => port.create(tx, context(), entry));
    expect(await run((tx) => port.create(tx, context(), entry))).toEqual(created);
    const replacement = { ...entry, kind: 'replace' as const, replacementBusinessId: replacements[0], pendingDate };
    await expect(run((tx) => port.apply(tx, context(), { ...replacement, intent: 'restore' }))).rejects.toMatchObject(
      NOT_CURRENT,
    );
    const replaced = await run((tx) => port.apply(tx, context(), { ...replacement, intent: 'preserve' }));
    expect(replaced).toMatchObject({
      id: created.id,
      rootBusinessId: entry.businessId,
      currentBusinessId: replacements[0],
      state: 'pending',
      revision: 2,
    });
    await expect(run((tx) => port.create(tx, context(), entry))).rejects.toMatchObject(NOT_CURRENT);
    await expect(run((tx) => port.apply(tx, context(), { ...entry, kind: 'cancel' }))).rejects.toMatchObject(
      NOT_CURRENT,
    );
    const current = { ...entry, businessId: replaced.currentBusinessId };
    const cancelled = await run((tx) => port.apply(tx, context(), { ...current, kind: 'cancel' }));
    expect(cancelled).toMatchObject({ id: created.id, state: 'cancelled', revision: 3 });
    expect(await run((tx) => port.apply(tx, context(), { ...current, kind: 'cancel' }))).toEqual(cancelled);
    const restored = await run((tx) =>
      port.apply(tx, context(), {
        ...current,
        kind: 'replace',
        intent: 'restore',
        replacementBusinessId: replacements[1],
        pendingDate: '2026-11-02',
      }),
    );
    expect(restored).toMatchObject({ id: created.id, state: 'pending', revision: 4, pendingDate: '2026-11-02' });
    const latest = { ...current, businessId: replacements[1] };
    const deleted = await run((tx) => port.apply(tx, context(), { ...latest, kind: 'delete' }));
    expect(deleted).toMatchObject({ id: created.id, state: 'deleted', revision: 5 });
    await expect(run((tx) => port.apply(tx, context(), { ...latest, kind: 'cancel' }))).rejects.toMatchObject(
      NOT_CURRENT,
    );
    expect(await run((tx) => tx.select().from(cases))).toEqual([deleted]);
    expect(await run((tx) => tx.select().from(employmentOutbox))).toEqual([]);
    const audits = await run((tx) => tx.select().from(auditEvents).where(eq(auditEvents.objectId, created.id)));
    expect(audits.map(({ action }) => action).sort()).toEqual(
      ['create', 'replace', 'cancel', 'replace', 'delete'].map((action) => `onboarding.entry_case.${action}`).sort(),
    );
  });

  it.each([
    { intent: 'preserve', expectedState: 'cancelled', action: '编辑' },
    { intent: 'restore', expectedState: 'pending', action: '改期恢复' },
  ] as const)('取消后的替换（$action）保留阶段和根业务，并记录实际状态流转', async ({ intent, expectedState }) => {
    const { db, entry, run, context, replacements } = await fixture(`ZZ_BE16_REPLACE_${intent}`);
    const { port } = install(db);
    const created = await run((tx) => port.create(tx, context(), entry));
    const cancelled = await run((tx) => port.apply(tx, context(), { ...entry, kind: 'cancel' }));
    const nextDate = '2026-11-02';
    const change = {
      ...entry,
      kind: 'replace' as const,
      intent,
      replacementBusinessId: replacements[0],
      pendingDate: nextDate,
    };
    const replaceContext = context();
    const replaced = await run((tx) => port.apply(tx, replaceContext, change));
    expect(replaced.state).toBe(expectedState);
    expect(replaced).toMatchObject({
      id: created.id,
      rootBusinessId: entry.businessId,
      currentBusinessId: replacements[0],
      pendingDate: nextDate,
      revision: cancelled.revision + 1,
    });
    expect(await run((tx) => tx.select().from(cases))).toEqual([replaced]);

    const ref = { ...entry, caseId: created.id, caseRevision: replaced.revision, businessRevision: 1 };
    await expect(run((tx) => port.lockForWrite(tx, context(), ref, [expectedState]))).rejects.toMatchObject(
      NOT_CURRENT,
    );
    const audits = await run((tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.objectId, created.id), eq(auditEvents.commandId, replaceContext.commandId))),
    );
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'onboarding.entry_case.replace',
        before: expect.objectContaining({
          id: created.id,
          rootBusinessId: entry.businessId,
          currentBusinessId: entry.businessId,
          pendingDate,
          state: 'cancelled',
          revision: cancelled.revision,
        }),
        after: expect.objectContaining({
          id: created.id,
          rootBusinessId: entry.businessId,
          currentBusinessId: replacements[0],
          pendingDate: nextDate,
          state: expectedState,
          revision: replaced.revision,
        }),
      }),
    ]);
  });

  it('业务头锁和阶段 revision 均复核；业务事务失败不留下阶段或审计', async () => {
    const { db, entry, run, context } = await fixture('ZZ_BE16_ROLLBACK');
    const { port } = install(db);
    const abort = new Error('ZZ_BE16_ROLLBACK');
    await expect(
      run(async (tx) => {
        await port.create(tx, context(), entry);
        throw abort;
      }),
    ).rejects.toBe(abort);
    expect(await run((tx) => tx.select().from(cases))).toEqual([]);
    const rows = await run((tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.objectType, 'onboarding-entry-case')),
    );
    expect(rows).toEqual([]);
    const created = await run((tx) => port.create(tx, context(), entry));
    const ref = { ...entry, caseId: created.id, caseRevision: 1, businessRevision: 1 };
    expect(await run((tx) => port.lockForWrite(tx, context(), ref, ['pending']))).toEqual(created);
    for (const override of [{ caseRevision: 0 }, { businessRevision: 0 }]) {
      await expect(
        run((tx) => port.lockForWrite(tx, context(), { ...ref, ...override }, ['pending'])),
      ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    }
    await expect(run((tx) => port.lockForWrite(tx, context(), ref, ['hired']))).rejects.toMatchObject(NOT_CURRENT);
  });

  it('只接收已到业务日的入职事实，阶段保存真实生效任职关联', async () => {
    const db = testDb().db;
    const w = await entryWorld(db, 'ZZ_BE16_HIRED');
    const { employee, recordId, business } = await addPending(w, '2026-10-19', 'ZZ_BE16_HIRED');
    const ctx = { ...portContext(w, business.revision), now };
    const { port } = install(db);
    await withTenant(db, ctx.tenantId, async (tx) => {
      const entry = { employeeId: employee.id, businessId: recordId };
      const created = await port.create(tx, ctx, { ...entry, pendingDate: business.record.effectiveDate });
      const hire = { ...entry, kind: 'hire' as const, hiredRecordId: recordId };
      await expect(port.apply(tx, ctx, { ...hire, hiredOn: '2026-10-30' })).rejects.toMatchObject(NOT_CURRENT);
      const completed = await completePendingEntry(tx, ctx, recordId, { probation: false });
      const hired = await port.apply(tx, ctx, { ...hire, hiredOn: completed.effectiveDate });
      expect(hired).toMatchObject({ id: created.id, state: 'hired', hiredRecordId: recordId, hiredOn: '2026-10-19' });
    });
  });
});

describe('AC-EN-BE16-01 阶段表约束', () => {
  it('拒绝组合外键跨租户、跨人员，拒绝当前业务重复与不完整入职事实', async () => {
    const a = await fixture('ZZ_BE16_FK_A');
    const b = await fixture('ZZ_BE16_FK_B');
    const { port } = install(a.db);
    await a.run((tx) => port.create(tx, a.context(), a.entry));
    const row = {
      tenantId: a.context().tenantId,
      employeeId: a.entry.employeeId,
      rootBusinessId: a.replacements[0],
      currentBusinessId: a.replacements[1],
      pendingDate,
    };
    for (const overrides of [
      { rootBusinessId: b.entry.businessId },
      { currentBusinessId: b.entry.businessId },
      { employeeId: b.entry.employeeId },
      { createdBy: b.context().userId },
    ]) {
      const code = await a.run((tx) => tx.insert(cases).values({ ...row, ...overrides })).catch(pgErrorCode);
      expect(code).toBe('23503');
    }
    const duplicate = await a
      .run((tx) => tx.insert(cases).values({ ...row, currentBusinessId: a.entry.businessId }))
      .catch(pgErrorCode);
    expect(duplicate).toBe('23505');
    const invalid = await a
      .run((tx) => tx.insert(cases).values({ ...row, state: 'hired', hiredOn: pendingDate }))
      .catch(pgErrorCode);
    expect(invalid).toBe('23514');
    expect(await b.run((tx) => tx.select().from(cases))).toEqual([]);
  });

  it.runIf(testDbMode() === 'pg')('PG16 无租户上下文时读不到，写入被 RLS 拒绝', async () => {
    const { db, entry, run, context, replacements } = await fixture('ZZ_BE16_NO_CONTEXT');
    const { port } = install(db);
    await run((tx) => port.create(tx, context(), entry));
    // 专门验证拒绝路径。超级用户 CI 分片先降为运行角色，app_owner 分片直接检查强制 RLS。
    const withoutTenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
      db.transaction(async (tx) => {
        const [role] = rowsOf<{ rolsuper: boolean }>(
          await tx.execute(sql`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`),
        );
        if (role?.rolsuper) await tx.execute(sql`SET LOCAL ROLE app_user`);
        return fn(tx);
      });
    expect(await withoutTenant((tx) => tx.select().from(cases))).toEqual([]);
    const denied = await withoutTenant((tx) =>
      tx.insert(cases).values({
        tenantId: context().tenantId,
        employeeId: entry.employeeId,
        rootBusinessId: replacements[0],
        currentBusinessId: replacements[0],
        pendingDate,
      }),
    ).catch(pgErrorCode);
    expect(denied).toBe('42501');
  });

  it.runIf(testDbMode() === 'pg')('两个 PG 会话真实等锁，替换提交后旧 ID 的写入失败', async () => {
    const { db, entry, run, context, replacements } = await fixture('ZZ_BE16_RACE');
    const { port } = install(db);
    const created = await run((tx) => port.create(tx, context(), entry));
    let markLocked!: (pid: number) => void;
    let release!: () => void;
    const locked = new Promise<number>((resolve) => {
      markLocked = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const replacing = run(async (tx) => {
      const [row] = rowsOf<{ pid: number }>(await tx.execute(sql`SELECT pg_backend_pid() AS pid`));
      await tx
        .select()
        .from(employmentBusinessObjects)
        .where(
          and(
            eq(employmentBusinessObjects.tenantId, context().tenantId),
            eq(employmentBusinessObjects.id, entry.businessId),
          ),
        )
        .for('update');
      await port.apply(tx, context(), {
        ...entry,
        kind: 'replace',
        intent: 'preserve',
        replacementBusinessId: replacements[0],
        pendingDate,
      });
      markLocked(row!.pid);
      await proceed;
    });
    const pid = await Promise.race([
      locked,
      replacing.then(() => {
        throw new Error('替换事务未触发屏障');
      }),
    ]);
    const write = run((tx) =>
      port.lockForWrite(tx, context(), { ...entry, caseId: created.id, caseRevision: 1, businessRevision: 1 }, [
        'pending',
      ]),
    );
    const rejected = expect(write).rejects.toMatchObject(NOT_CURRENT);
    try {
      await vi.waitFor(
        async () => {
          const rows = rowsOf<{ pid: number }>(
            await db.execute(sql`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
            AND ${pid}::int = ANY(pg_blocking_pids(pid))`),
          );
          expect(rows).toHaveLength(1);
        },
        { timeout: 5_000 },
      );
    } finally {
      release();
      await Promise.all([replacing, rejected]);
    }
    expect(await run((tx) => tx.select().from(cases))).toEqual([
      expect.objectContaining({ id: created.id, currentBusinessId: replacements[0], revision: 2 }),
    ]);
  });

  it('从上一结构升级只新增空阶段表，保留原任职业务', async () => {
    const handle = await createTestDb({ migrateBefore: '_be16_entry_cases' });
    try {
      const { run, entry } = await fixture('ZZ_BE16_UPGRADE', handle.db);
      await handle.migrate();
      expect(await run((tx) => tx.select().from(cases))).toEqual([]);
      expect(
        await run((tx) =>
          tx.select().from(employmentBusinessObjects).where(eq(employmentBusinessObjects.id, entry.businessId)),
        ),
      ).toEqual([expect.objectContaining({ id: entry.businessId, revision: 1 })]);
    } finally {
      await handle.close();
    }
  });
});
