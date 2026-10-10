/**
 * AC-360-F076-14（F-076 PR-1 第 2 轮审查 P2：密钥版本防回退须是全局、持续有效的边界，设计 §2.4“版本只增不减”）。
 * 第 2 轮实现只在进入某租户时查该租户的 key_rotated 事件，审查方用真 PG 复现了三处遗漏，这里各一条：
 * 1. 轮换后新建的租户没有轮换事件：旧 CURRENT 的维护进程仍会给它发旧版本凭据；
 * 2. 轮换登记发生在发放批次中途：旧批次以登记前的版本照常写回；
 * 3. 启动校验复用跳过 restoring 租户的遍历器：恢复隔离期间以旧配置启动被放行。
 * 另：P3 损坏摘要的参数校验（六段格式但参数非法时不得让 scrypt 抛错）。
 * 三条都不依赖并发连接（批次中途用 beforeWriteBack 钩子在写回事务之前完成登记），PGlite 与真 PG 都跑。
 * 已登记版本是全库（全局）的、只增不减，同一测试库里的三条用例依次使用更高的版本号（1～2、3～5、6～7）；
 * 写回事务与登记事务互相等待的交错见 AC-360-F076-14-key-rollback-pg.test.ts。
 */
import { randomBytes } from 'node:crypto';
import { sql, withPlatform } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { credentialConfig } from '../../apps/api/src/modules/survey360/credential-config.js';
import {
  assertNoKeyRollback,
  runCredentialMaintenance,
} from '../../apps/api/src/modules/survey360/credential-maintenance.js';
import { rotateKeys } from '../../apps/api/src/modules/survey360/credential-ops.js';
import { kdfCallCount, resetKdfCallCount, verifyPassword } from '../../apps/api/src/modules/survey360/credentials.js';
import { sceneB } from './AC-360-B-support.js';
import { linkRows, portalCredentials, resetCredentialConfig } from './AC-360-F076-support.js';

const testDb = useTestDb();
afterEach(() => resetCredentialConfig());
const FAST = { N: 1024, r: 8, p: 1 };
const known = new Map<number, Buffer>();
function configure(versions: number[], current: number) {
  for (const v of versions) if (!known.has(v)) known.set(v, randomBytes(32));
  portalCredentials(true, {
    credentialKeys: new Map(versions.map((v) => [v, known.get(v)!])),
    currentVersion: current,
    retiredVersions: new Set(),
    compromisedVersions: new Set(),
    kdf: FAST,
  });
  return credentialConfig();
}

describe('AC-360-F076-14 密钥版本防回退：全局已登记最高版本', () => {
  it('场景 1：登记轮换到 k2 后新开租户，CURRENT=1 的旧进程不得给新租户发版本 1 凭据', async () => {
    configure([1, 2], 2);
    const old = await sceneB(testDb().db, 'f076-14a-old');
    await rotateKeys(old.w.db, { to: 2, config: credentialConfig() });

    // 轮换登记之后才开通的租户：它自己没有任何 key_rotated 事件
    configure([1, 2], 2);
    const fresh = await sceneB(testDb().db, 'f076-14a-new');
    const stale = configure([1, 2], 1);
    await expect(runCredentialMaintenance(fresh.w.db, { tenantId: fresh.w.tenantId, config: stale })).rejects.toThrow(
      /回退/,
    );
    const links = await linkRows(fresh.w, fresh.activity.id);
    expect(links.length).toBe(5);
    expect(links.every((l) => l.credential_state === 'pending' && l.credential_key_version === null)).toBe(true);

    const current = configure([1, 2], 2);
    expect((await runCredentialMaintenance(fresh.w.db, { tenantId: fresh.w.tenantId, config: current })).issued).toBe(
      5,
    );
    expect((await linkRows(fresh.w, fresh.activity.id)).every((l) => l.credential_key_version === 2)).toBe(true);
  });

  it('场景 2：发放批次中途完成 k5 登记，旧批次（以 k4 生成）一条也不得提交', async () => {
    configure([3, 4, 5], 4);
    const s = await sceneB(testDb().db, 'f076-14b');
    await rotateKeys(s.w.db, { to: 4, config: credentialConfig() });
    const v4 = configure([3, 4, 5], 4);
    const v5: ReturnType<typeof credentialConfig> = { ...v4, currentVersion: 5 };

    let rotated = false;
    const run = runCredentialMaintenance(s.w.db, {
      tenantId: s.w.tenantId,
      config: v4,
      kdfConcurrency: 1,
      hooks: {
        // 第一行已用 k4 生成并做完 KDF、还没写回：此时运维完成 k5 登记
        beforeWriteBack: async () => {
          if (rotated) return;
          rotated = true;
          await rotateKeys(s.w.db, { to: 5, config: v5 });
        },
      },
    });
    await expect(run).rejects.toThrow(/回退/);
    expect(rotated).toBe(true);
    const links = await linkRows(s.w, s.activity.id);
    expect(links.filter((l) => l.credential_key_version === 4)).toEqual([]);
    expect(links.every((l) => l.credential_state === 'pending')).toBe(true);

    expect((await runCredentialMaintenance(s.w.db, { tenantId: s.w.tenantId, config: v5 })).issued).toBe(5);
    expect((await linkRows(s.w, s.activity.id)).every((l) => l.credential_key_version === 5)).toBe(true);
  });

  it('场景 3：恢复隔离期间（租户都处于 restoring）以旧 CURRENT 启动，校验仍须读到已登记的最高版本并拒绝', async () => {
    configure([6, 7], 7);
    const s = await sceneB(testDb().db, 'f076-14c');
    await rotateKeys(s.w.db, { to: 7, config: credentialConfig() });
    // 恢复库保留了已登记版本 7，恢复期间全部租户处于 restoring（DEC-061：恢复后先隔离校验）
    await withPlatform(s.w.db, (tx) =>
      tx.execute(sql`UPDATE tenants SET status = 'restoring' WHERE status = 'active'`),
    );
    try {
      await expect(assertNoKeyRollback(s.w.db, configure([6, 7], 6))).rejects.toThrow(/回退/);
      await expect(assertNoKeyRollback(s.w.db, configure([6, 7], 7))).resolves.toBeUndefined();
    } finally {
      await withPlatform(s.w.db, (tx) =>
        tx.execute(sql`UPDATE tenants SET status = 'active' WHERE status = 'restoring'`),
      );
    }
  });
});

describe('AC-360-F076-14 P3 损坏摘要的参数校验', () => {
  it('六段格式但参数 / 盐 / 哈希不合法：不抛错，按哑摘要路径各做一次缺省参数 KDF 并返回 false', async () => {
    const secret = randomBytes(32);
    const salt = randomBytes(16).toString('base64url');
    const hash = randomBytes(32).toString('base64url');
    const corrupted = [
      `scrypt$3$8$1$${salt}$${hash}`, // N 不是 2 的幂（scrypt 会抛错）
      `scrypt$${2 ** 21}$8$1$${salt}$${hash}`, // N 超过上限
      `scrypt$1$8$1$${salt}$${hash}`, // N < 2
      `scrypt$16384$0$1$${salt}$${hash}`, // r 非正
      `scrypt$16384$8$99$${salt}$${hash}`, // p 超过上限
      `scrypt$16384$8$1$${randomBytes(4).toString('base64url')}$${hash}`, // 盐长度不对
      `scrypt$16384$8$1$${salt}$${randomBytes(8).toString('base64url')}`, // 哈希长度不对
    ];
    resetKdfCallCount();
    for (const digest of corrupted) expect(await verifyPassword(digest, secret, 'ABCD2345')).toBe(false);
    expect(kdfCallCount()).toBe(corrupted.length);
  });
});
