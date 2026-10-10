/**
 * AC-360-F076-R2（F-076 PR-2a 第 1 轮审查 P2-1～3，#234）：
 * P2-1 删除最后一条关系 × 新增关系 / 两个入口同时删最后两条关系，按评价者 × 活动串行化（真 PG 交错）；
 * P2-2 较早发起、较晚完成的登录，会话时间取实际签发时刻，且不被自身的上限清理淘汰；
 * P2-3 限频维护任务的清理与登录遵守兼容的锁序（真 PG 交错）。
 * 真 PG 用例在 PGlite 单连接下无法并发，只在设了 TEST_DATABASE_URL 时运行。
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCredentialMaintenance } from '../../apps/api/src/modules/survey360/credential-maintenance.js';
import { configureLoginGate, resetLoginGate } from '../../apps/api/src/modules/survey360/login-gate.js';
import { loginHooks, resetLoginHooks } from '../../apps/api/src/modules/survey360/portal.js';
import { linkHooks } from '../../apps/api/src/modules/survey360/links.js';
import { loadRelation, removeRelation } from '../../apps/api/src/modules/survey360/relations.js';
import { SYSTEM_USER_ID } from '../../apps/api/src/system-actor.js';
import { linkRows, resetCredentialConfig } from './AC-360-F076-support.js';
import { START, issuedScene, login, minutes, seedThrottle, sessionRows } from './AC-360-F076-portal-support.js';
import { ipKey, pairKey } from '../../apps/api/src/modules/survey360/throttle.js';
import { credentialConfig } from '../../apps/api/src/modules/survey360/credential-config.js';

const realPostgres = Boolean(process.env.TEST_DATABASE_URL);
const testDb = useTestDb();
afterEach(() => {
  resetCredentialConfig();
  resetLoginHooks();
  resetLoginGate();
  linkHooks.afterLock = undefined;
  linkHooks.afterTaskCheck = undefined;
  vi.restoreAllMocks();
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settles = (promise: Promise<unknown>, ms: number) =>
  Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    pause(ms).then(() => false),
  ]);

describe('AC-360-F076-R2 P2-2 会话时间取实际签发时刻', () => {
  it('较早发起、较晚完成的登录：返回的会话有效，不被自身的 5 会话上限淘汰；期限从实际签发算', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-r2-p2');
    const cred = creds.get(s.person.P1.id)!;
    configureLoginGate({ global: 100, perTenant: 100 });
    loginHooks.afterPrewrite = async () => {
      resetLoginHooks();
      w.setNow(minutes(1));
      for (let i = 0; i < 5; i += 1) {
        expect((await login(w, cred.serial, cred.password, { ip: `203.0.113.${160 + i}` })).status).toBe(201);
      }
      w.setNow(minutes(2));
    };
    const res = await login(w, cred.serial, cred.password, { ip: '203.0.113.170' });
    expect(res.status, await res.clone().text()).toBe(201);
    const body = (await res.json()) as { session: string; expiresAt: string };
    expect(body.expiresAt).toBe('2026-10-01T09:02:00.000Z');
    const rows = await sessionRows(w, cred.linkId);
    expect(rows).toHaveLength(6);
    const own = rows.find((row) => new Date(row.expires_at).toISOString() === body.expiresAt)!;
    expect(own.revoked_at).toBeNull();
    expect(rows.filter((row) => row.revoked_at === null)).toHaveLength(5);
  });
});

describe.skipIf(!realPostgres)('AC-360-F076-R2 P2-1 删最后一条关系 × 新增关系（真 PG）', () => {
  async function removeRelationTx(w: Awaited<ReturnType<typeof issuedScene>>['w'], objectId: string, id: string) {
    await withTenant(w.db, w.tenantId, async (tx) => {
      const relation = await loadRelation(tx, objectId, id, true);
      const ctx = { tenantId: w.tenantId, userId: SYSTEM_USER_ID, commandId: randomUUID(), now: new Date(START) };
      await removeRelation(tx, ctx, relation);
    });
  }

  async function removeHolding(w: Awaited<ReturnType<typeof issuedScene>>['w'], objectId: string, id: string) {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let removed: () => void = () => undefined;
    const done = new Promise<void>((resolve) => (removed = resolve));
    const finished = withTenant(w.db, w.tenantId, async (tx) => {
      const relation = await loadRelation(tx, objectId, id, true);
      const ctx = { tenantId: w.tenantId, userId: SYSTEM_USER_ID, commandId: randomUUID(), now: new Date(START) };
      await removeRelation(tx, ctx, relation);
      removed();
      await gate;
    });
    await done;
    return { release, finished };
  }

  it('删除事务已判定“没有剩余关系”、尚未作废链接时，管理员把评价者加入另一对象：最终必有可用（未作废）链接', async () => {
    const { s, w } = await issuedScene(testDb().db, 'f076-r2-p1a');
    const second = await w.object(s.activity.id, s.person.M.id, [s.q.id]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let checked = false;
    linkHooks.afterTaskCheck = async () => {
      linkHooks.afterTaskCheck = undefined;
      checked = true;
      await gate;
    };
    const removing = removeRelationTx(w, s.object.id, s.rel.p1.id);
    while (!checked) await pause(5);
    const adding = w.appraiser(s.activity.id, second.id, s.person.P1.id, 'peer');
    await settles(adding, 300);
    release();
    await Promise.all([removing, adding]);

    const links = (await linkRows(w, s.activity.id)).filter((l) => l.person_id === s.person.P1.id);
    expect(links.filter((l) => !l.revoked)).toHaveLength(1);
  });

  it('新增关系先持有链接锁、尚未提交时，确认入口删除评价者另一条关系：删除等待，之后看见新增的关系，不作废链接', async () => {
    const { s, w } = await issuedScene(testDb().db, 'f076-r2-p1c');
    const second = await w.object(s.activity.id, s.person.M.id, [s.q.id]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked = false;
    linkHooks.afterLock = async () => {
      linkHooks.afterLock = undefined;
      locked = true;
      await gate;
    };
    const adding = w.appraiser(s.activity.id, second.id, s.person.P1.id, 'peer');
    while (!locked) await pause(5);
    const removing = removeRelationTx(w, s.object.id, s.rel.p1.id);
    await settles(removing, 300);
    release();
    await Promise.all([adding, removing]);

    const links = (await linkRows(w, s.activity.id)).filter((l) => l.person_id === s.person.P1.id);
    expect(links.map((l) => l.revoked)).toEqual([false]);
  });

  it('后补-权限：两个入口同时删除同一评价者最后两条关系：链接必被作废，加回后旧凭据不恢复', async () => {
    const { s, w, creds } = await issuedScene(testDb().db, 'f076-r2-p1b');
    const second = await w.object(s.activity.id, s.person.M.id, [s.q.id]);
    const other = await w.appraiser(s.activity.id, second.id, s.person.P1.id, 'peer');
    const first = await removeHolding(w, s.object.id, s.rel.p1.id);
    const secondRemoval = removeHolding(w, second.id, other.id);
    await settles(secondRemoval, 300);
    first.release();
    const later = await secondRemoval;
    later.release();
    await Promise.all([first.finished, later.finished]);

    const links = (await linkRows(w, s.activity.id)).filter((l) => l.person_id === s.person.P1.id);
    expect(links.map((l) => l.revoked)).toEqual([true]);
    await w.appraiser(s.activity.id, s.object.id, s.person.P1.id, 'peer');
    const old = creds.get(s.person.P1.id)!;
    expect((await login(w, old.serial, old.password)).status).toBe(401);
  });
});

describe.skipIf(!realPostgres)('AC-360-F076-R2 P2-3 限频维护任务 × 登录（真 PG）', () => {
  it('维护任务持有到期的序列号 × IP 行时登录进来：登录等待后成功（201），维护任务不抛错、不死锁', async () => {
    const { s, w, creds } = await issuedScene(testDb().db, 'f076-r2-p3');
    const cred = creds.get(s.person.P1.id)!;
    const ip = '198.51.100.77';
    const config = credentialConfig();
    const old = '2026-09-20T00:00:00Z';
    // 维护任务中断超过一天后恢复：空闲的 IP 行 + 已到期的序列号 × IP 锁
    await seedThrottle(w, { scope: 'ip', key: ipKey(config, ip), startedAt: old });
    await seedThrottle(w, {
      scope: 'pair',
      key: pairKey(config, cred.serial, ip),
      startedAt: old,
      lockedUntil: '2026-09-20T00:15:00Z',
    });

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    const maintenance = runCredentialMaintenance(w.db, {
      tenantId: w.tenantId,
      clock: () => new Date(START),
      hooks: {
        duringCleanup: async () => {
          held = true;
          await gate;
        },
      },
    });
    while (!held) await pause(5);
    const logging = login(w, cred.serial, cred.password, { ip });
    await settles(logging, 300);
    release();
    const [report, res] = await Promise.all([maintenance, logging]);
    expect(res.status, await res.clone().text()).toBe(201);
    expect(report.unlocked).toBeGreaterThanOrEqual(0);
  });
});
