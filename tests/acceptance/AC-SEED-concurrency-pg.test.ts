/**
 * DEC-361 R2-01：并发回补互斥（真 PostgreSQL 交错；PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行）。
 * 两个合法平台回补请求（不同命令 ID）同时对同一租户缺失的同一预置编码补装：统一安装函数必须在读取已有编码之前取得
 * 租户级事务锁，后到者等前者提交后读到“已存在”，两个请求都正常完成（200），第二个报告无缺失项，业务写与审计不重复，
 * 而不是撞唯一约束返回 500。屏障放在“已有编码读取之后”：没有锁时两个请求都会读到缺失，有锁时后到者根本到不了屏障。
 */
import { randomUUID } from 'node:crypto';
import { and, auditEvents, eq, talentDescriptionTypes, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { recordAudit } from '../../apps/api/src/audit/record.js';
import { registerSeed } from '../../apps/api/src/seeds/registry.js';
import { newUser, PLATFORM, provisioned, seedOperator } from './support/platform-api.js';
import { tenantApi } from './support/tenant-api.js';

const realPostgres = Boolean(process.env.TEST_DATABASE_URL);
const testDb = useTestDb();
const OBJECT = 'Test.SeedRace';

/** 两个请求都读完“已有编码”后才继续（最多等 700ms，给有锁时后到者的等待留出通过路径）。 */
let arrivals = 0;
let release: (() => void) | undefined;
let gate: Promise<void> = Promise.resolve();
function resetGate() {
  arrivals = 0;
  gate = new Promise<void>((resolve) => {
    release = resolve;
    setTimeout(resolve, 700);
  });
}
async function barrier() {
  arrivals += 1;
  if (arrivals >= 2) release?.();
  await gate;
}

/** 用真实表（发展建议类型，租户内名称唯一）当预置数据，撞唯一约束才是真实的 500 来源。 */
function seedName(module: string) {
  return `并发预置-${module}`;
}
for (const module of ['race-a', 'race-b']) {
  registerSeed({
    module,
    key: 'types',
    version: 1,
    codes: [seedName(module)],
    existing: async (tx, tenantId) => {
      const rows = await tx
        .select({ name: talentDescriptionTypes.name })
        .from(talentDescriptionTypes)
        .where(eq(talentDescriptionTypes.tenantId, tenantId));
      const have = new Set(rows.map((row) => row.name));
      if (module === 'race-a') await barrier();
      return have;
    },
    install: async (tx, write, missing) => {
      for (const name of missing) {
        const [row] = await tx
          .insert(talentDescriptionTypes)
          .values({ tenantId: write.tenantId, name, displayOrder: 99, createdBy: write.actorUserId })
          .returning({ id: talentDescriptionTypes.id });
        await recordAudit(tx, {
          tenantId: write.tenantId,
          actorUserId: write.actorUserId,
          action: 'test.seed-race.create',
          objectType: OBJECT,
          objectId: row!.id,
          before: null,
          after: { name },
          commandId: write.commandId,
          occurredAt: write.now,
        });
      }
    },
  });
}

async function tenant(label: string) {
  const db = testDb().db;
  const api = tenantApi(db, { authorize: undefined });
  const operator = await seedOperator(db, `ops-${label}`);
  const admin = await newUser(db, `admin-${label}`);
  const exception = await newUser(db, `exception-${label}`);
  const result = await provisioned(api, operator, {
    firstAdminUserId: admin.id,
    exceptionAdminUserId: exception.id,
    licenses: [{ licenseType: 'core_hr', quota: 10 }],
  });
  const id = result.tenant.id;
  // 模拟存量租户：开通时已经装上的并发预置删掉（审计事件是追加的，保留）
  await withTenant(db, id, (tx) =>
    tx.delete(talentDescriptionTypes).where(eq(talentDescriptionTypes.displayOrder, 99)),
  );
  return { api, operator, id };
}
const backfill = (t: Awaited<ReturnType<typeof tenant>>, modules?: string[]) =>
  t.api.request('POST', `${PLATFORM}/tenants/${t.id}/seeds/backfill`, {
    user: t.operator.id,
    idempotencyKey: randomUUID(),
    body: modules ? { modules } : {},
  });
type Report = { items: { module: string; installed: string[] }[] };
const installedBy = (report: Report, module: string) => report.items.find((item) => item.module === module)!.installed;

describe.skipIf(!realPostgres)('DEC-361 R2-01 并发回补互斥（真 PG）', () => {
  it.each([
    ['两个不带 modules 的回补同时执行', undefined, undefined, ['race-a', 'race-b']],
    ['两个都带同一 modules 的回补同时执行', ['race-a'], ['race-a'], ['race-a']],
    ['带 modules 与不带 modules 的回补重叠执行', ['race-a'], undefined, ['race-a', 'race-b']],
  ] as const)('%s：两个都 200，只装一次，第二个无缺失项，审计不重复', async (_label, first, second, expected) => {
    const t = await tenant('seed-race');
    const before = await withTenant(testDb().db, t.id, (tx) =>
      tx
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(and(eq(auditEvents.objectType, OBJECT))),
    );
    resetGate();
    const [a, b] = await Promise.all([
      backfill(t, first as string[] | undefined),
      backfill(t, second as string[] | undefined),
    ]);
    expect([a.status, b.status], await a.clone().text()).toEqual([200, 200]);
    const reports = [(await a.json()) as Report, (await b.json()) as Report];
    const installs = reports.map((report) => installedBy(report, 'race-a').length);
    expect(installs.sort()).toEqual([0, 1]);
    const rows = await withTenant(testDb().db, t.id, (tx) =>
      tx
        .select({ name: talentDescriptionTypes.name })
        .from(talentDescriptionTypes)
        .where(eq(talentDescriptionTypes.displayOrder, 99)),
    );
    expect(rows.map((row) => row.name).sort()).toEqual(expected.map(seedName));
    const audited = await withTenant(testDb().db, t.id, (tx) =>
      tx
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(and(eq(auditEvents.objectType, OBJECT))),
    );
    expect(audited.length - before.length).toBe(expected.length);
  });
});
