/**
 * DEC-141 升级对账（R1-T15，astra 第二轮 P2-2）：旧版“撤销授权不归还名额”，历史数据里会留下指向已撤销授权的占用。
 * 本 PR 的迁移须对账：该用户已无同类有效授权的占用释放；仍持有同类有效授权的占用改记到最早的那条有效授权。
 * 测试先只跑到本 PR 迁移之前（main 的库结构），按旧逻辑造数据，再跑完迁移，断言余额、使用明细与对账留痕。
 */
import { randomUUID } from 'node:crypto';
import { auditEvents, type Db, permissionOutbox, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { listBalances, listSeats } from '../../apps/api/src/modules/permission/licenses.js';

const testDb = useTestDb({ migrateBefore: '_enterprise_settings' });
const PAGE = { limit: 50, offset: 0 };
type SQL = ReturnType<typeof sql>;

/** 以迁移 / 建库角色在某租户上下文里执行旧结构下的原始 SQL（表强制 RLS，须设 app.tenant_id）。 */
async function asTenant(db: Db, tenantId: string, statements: SQL[]) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    for (const statement of statements) await tx.execute(statement);
  });
}

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

function tenant(db: Db, code: string) {
  const id = randomUUID();
  return db.execute(sql`INSERT INTO tenants (id, code, name) VALUES (${id}, ${code}, ${code})`).then(() => id);
}

async function user(db: Db, name: string) {
  const id = randomUUID();
  const email = `${name}-${id}@example.com`;
  await db.execute(sql`INSERT INTO users (id, email, display_name) VALUES (${id}, ${email}, ${name})`);
  return id;
}

const member = (tenantId: string, userId: string) =>
  sql`INSERT INTO tenant_memberships (tenant_id, user_id) VALUES (${tenantId}, ${userId})`;
const profile = (tenantId: string, id: string, code: string, licenseType: string) =>
  sql`INSERT INTO permission_profiles (id, tenant_id, code, name, license_type)
      VALUES (${id}, ${tenantId}, ${code}, ${code}, ${licenseType})`;
const pool = (tenantId: string, licenseType: string, quota: number) =>
  sql`INSERT INTO license_pools (tenant_id, license_type, quota) VALUES (${tenantId}, ${licenseType}, ${quota})`;
const grantRow = (g: {
  tenantId: string;
  id: string;
  userId: string;
  profileId: string;
  active: boolean;
  at: string;
}) =>
  sql`INSERT INTO permission_grants (id, tenant_id, user_id, profile_id, status, revision, created_at, updated_at)
      VALUES (${g.id}, ${g.tenantId}, ${g.userId}, ${g.profileId}, ${g.active ? 'active' : 'revoked'},
              ${g.active ? 1 : 2}, ${g.at}, ${g.at})`;
const seat = (tenantId: string, licenseType: string, userId: string, grantId: string, consumedAt: string) =>
  sql`INSERT INTO license_seats (tenant_id, license_type, user_id, grant_id, consumed_at)
      VALUES (${tenantId}, ${licenseType}, ${userId}, ${grantId}, ${consumedAt})`;

describe('DEC-141 升级对账：旧版撤销不归还留下的许可占用', () => {
  it('无同类有效授权的占用释放；仍持有的改记到最早的有效授权；按租户逐个对账并留审计与 outbox', async () => {
    const { db } = testDb();
    const a = await tenant(db, `legacy-a-${randomUUID()}`);
    const b = await tenant(db, `legacy-b-${randomUUID()}`);
    const [released, moved, kept] = [await user(db, 'released'), await user(db, 'moved'), await user(db, 'kept')];
    const [admin, viewer, paUser] = [randomUUID(), randomUUID(), randomUUID()];
    const g = {
      releasedOld: randomUUID(), // released：唯一一条同类授权已撤销
      movedOld: randomUUID(), // moved：占名额的那条已撤销……
      movedSuccessor: randomUUID(), // ……之后又授了同类身份（旧逻辑已占名额不再消耗）
      movedLater: randomUUID(), // 更晚的同类有效授权，不应被选中
      kept: randomUUID(), // kept：占名额的授权仍有效
      otherTenant: randomUUID(), // 租户 B 里 released 的已撤销授权
    };

    // 旧逻辑下：配额 3 被 3 个占用全部用完（余额 0），其中两个指向已撤销授权
    await asTenant(db, a, [
      ...[released, moved, kept].map((u) => member(a, u)),
      profile(a, admin, 'core-admin', 'core_hr'),
      profile(a, viewer, 'core-viewer', 'core_hr'),
      pool(a, 'core_hr', 3),
      grantRow({ tenantId: a, id: g.releasedOld, userId: released, profileId: admin, active: false, at: at(1) }),
      grantRow({ tenantId: a, id: g.movedOld, userId: moved, profileId: admin, active: false, at: at(2) }),
      grantRow({ tenantId: a, id: g.kept, userId: kept, profileId: admin, active: true, at: at(3) }),
      grantRow({ tenantId: a, id: g.movedSuccessor, userId: moved, profileId: viewer, active: true, at: at(4) }),
      grantRow({ tenantId: a, id: g.movedLater, userId: moved, profileId: admin, active: true, at: at(5) }),
      seat(a, 'core_hr', released, g.releasedOld, at(1)),
      seat(a, 'core_hr', moved, g.movedOld, at(2)),
      seat(a, 'core_hr', kept, g.kept, at(3)),
    ]);
    await asTenant(db, b, [
      member(b, released),
      profile(b, paUser, 'pa-user', 'pa_user'),
      pool(b, 'pa_user', 1),
      grantRow({ tenantId: b, id: g.otherTenant, userId: released, profileId: paUser, active: false, at: at(6) }),
      seat(b, 'pa_user', released, g.otherTenant, at(6)),
    ]);

    await testDb().migrate();

    const a1 = await withTenant(db, a, async (tx) => ({
      balances: await listBalances(tx),
      seats: await listSeats(tx, 'core_hr', PAGE),
    }));
    expect(a1.balances).toEqual([
      expect.objectContaining({ licenseType: 'core_hr', quota: 3, used: 2, balance: 1, overage: false }),
    ]);
    expect(a1.seats).toEqual([
      expect.objectContaining({ userId: moved, grantId: g.movedSuccessor, profileId: viewer }),
      expect.objectContaining({ userId: kept, grantId: g.kept, profileId: admin }),
    ]);
    const b1 = await withTenant(db, b, (tx) => listBalances(tx));
    expect(b1).toEqual([expect.objectContaining({ licenseType: 'pa_user', quota: 1, used: 0, balance: 1 })]);

    const trailOf = (tenantId: string) =>
      withTenant(db, tenantId, async (tx) => ({
        audits: await tx
          .select()
          .from(auditEvents)
          .where(sql`${auditEvents.action} LIKE 'license_seat.%'`),
        outbox: await tx
          .select()
          .from(permissionOutbox)
          .where(sql`${permissionOutbox.eventType} LIKE 'license_seat.%'`),
      }));
    const trailA = await trailOf(a);
    expect(trailA.audits.map((e) => [e.action, e.objectId, e.actorUserId]).sort()).toEqual([
      ['license_seat.reassign', `core_hr:${moved}`, null],
      ['license_seat.release', `core_hr:${released}`, null],
    ]);
    expect(trailA.audits.find((e) => e.action === 'license_seat.release')).toMatchObject({
      before: { licenseType: 'core_hr', userId: released, grantId: g.releasedOld },
      after: null,
    });
    expect(trailA.audits.find((e) => e.action === 'license_seat.reassign')).toMatchObject({
      before: { grantId: g.movedOld },
      after: { grantId: g.movedSuccessor },
    });
    expect(trailA.outbox.map((e) => e.eventType).sort()).toEqual(['license_seat.reassign', 'license_seat.release']);
    const trailB = await trailOf(b);
    expect(trailB.audits.map((e) => [e.action, e.objectId])).toEqual([['license_seat.release', `pa_user:${released}`]]);
  });
});
