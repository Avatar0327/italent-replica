/**
 * AC-TEN-05（DEC-056，REQ-TEN-001 R5 / REQ-PLT-001 R5）租户时区：
 * 新租户默认 Asia/Shanghai；同一生效日在两个时区下的到期判定不同；审计事件时间以 UTC 存储、按租户时区显示。
 * “定时任务在 UTC 09-30 17:00 运行并落地调动”部分依赖 R1-T08（定时生效）与调动对象，暂以 it.todo 占位。
 */
import { auditEvents, createTenant, getTenant, withTenant } from '@italent/db';
import { isEffectiveDue, tenantLocalDate } from '@italent/domain';
import { pgErrorCode, useTestDb } from '@italent/testkit';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedTenantWithMember, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const RUN_AT = new Date('2026-09-30T17:00:00Z'); // 北京时间 10-01 01:00
const EFFECTIVE_DATE = '2026-10-01';

describe('AC-TEN-05 租户时区', () => {
  let a: Awaited<ReturnType<typeof seedTenantWithMember>>;
  let b: Awaited<ReturnType<typeof seedTenantWithMember>>;

  beforeAll(async () => {
    const { db } = testDb();
    a = await seedTenantWithMember(db, 'a');
    b = await seedTenantWithMember(db, 'b', 'UTC');
  });

  it('新开租户未指定时区时默认 Asia/Shanghai', async () => {
    const tenant = await getTenant(testDb().db, a.tenant.id);
    expect(tenant?.timezone).toBe('Asia/Shanghai');
  });

  it('非 IANA 时区在平台开通与数据库约束两层都被拒绝', async () => {
    const { db } = testDb();
    await expect(createTenant(db, { code: 'bad-tz', name: '坏时区', timezone: 'Mars/Olympus' })).rejects.toThrow(
      RangeError,
    );
    const direct = await db
      .execute(sql`INSERT INTO tenants (code, name, timezone) VALUES ('bad-tz-2', '坏时区', '+08:00')`)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(pgErrorCode(direct)).toBe('23514');
  });

  it('同一生效日 10-01：UTC 09-30 17:00 时 A（上海）已到期，B（UTC）未到期，UTC 10-01 起 B 到期', async () => {
    const { db } = testDb();
    const tzA = (await getTenant(db, a.tenant.id))!.timezone;
    const tzB = (await getTenant(db, b.tenant.id))!.timezone;

    expect(isEffectiveDue(EFFECTIVE_DATE, tzA, RUN_AT)).toBe(true);
    expect(isEffectiveDue(EFFECTIVE_DATE, tzB, RUN_AT)).toBe(false);
    expect(isEffectiveDue(EFFECTIVE_DATE, tzB, new Date('2026-10-01T00:00:00Z'))).toBe(true);
  });

  it('审计事件时间以 UTC 存储，与会话时区无关；按各自租户时区显示为不同日期', async () => {
    const { db } = testDb();
    const api = tenantApi(db, { clock: () => RUN_AT });
    for (const t of [a, b]) {
      const res = await api.request('PUT', '/api/tenant/settings/audit.retention', {
        user: t.user.id,
        tenant: t.tenant.id,
        ifMatch: 0,
        body: { value: { queryMonths: 1, retainMonths: 2 } },
      });
      expect(res.status).toBe(200);
    }

    for (const [t, expectedLocalDate] of [
      [a, '2026-10-01'],
      [b, '2026-09-30'],
    ] as const) {
      const [row] = await withTenant(db, t.tenant.id, async (tx) => {
        await tx.execute(sql`SET LOCAL TIME ZONE 'America/New_York'`);
        return tx
          .select({
            occurredAt: auditEvents.occurredAt,
            utcText: sql<string>`to_char(${auditEvents.occurredAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`,
          })
          .from(auditEvents)
          .where(eq(auditEvents.tenantId, t.tenant.id));
      });
      expect(row?.utcText).toBe('2026-09-30 17:00:00');
      expect(row?.occurredAt.toISOString()).toBe(RUN_AT.toISOString());
      const tz = (await getTenant(db, t.tenant.id))!.timezone;
      expect(tenantLocalDate(row!.occurredAt, tz)).toBe(expectedLocalDate);
    }
  });

  it.todo('定时任务在 UTC 09-30 17:00 运行：A 的调动已生效，B 仍为「审批通过」，UTC 10-01 后生效（R1-T08 完成后补全）');
  it.todo('租户管理员修改时区只影响之后的日期判定，不改写已生效数据（REQ-PLT-001 R5，待确认口径，R1-T17）');
});
