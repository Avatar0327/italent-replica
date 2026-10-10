/**
 * AC-360-F076-14（真 PostgreSQL 交错；PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行）：
 * 发放写回与轮换登记的协调（设计 §2.4）。写回事务持有“密钥版本登记”的共享锁并在锁内复核 CURRENT ≥ 已登记最高版本；
 * 轮换登记取同一把锁的排他模式。所以：
 * - 写回事务进行中，登记必须等它提交（这一条以登记前的版本提交是合法的：那时登记还没完成）；
 * - 登记一旦提交，此后任何写回都读到新的最高版本，以旧版本生成的凭据一律回滚，一条也提交不了。
 * 去掉写回事务里的协调（不取共享锁、不复核），登记不会等待，且登记后的旧版本写回照常提交——本文件两条断言都会失败。
 */
import { randomBytes } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { credentialConfig } from '../../apps/api/src/modules/survey360/credential-config.js';
import { runCredentialMaintenance } from '../../apps/api/src/modules/survey360/credential-maintenance.js';
import { rotateKeys } from '../../apps/api/src/modules/survey360/credential-ops.js';
import { sceneB } from './AC-360-B-support.js';
import { linkRows, portalCredentials, resetCredentialConfig } from './AC-360-F076-support.js';

const realPostgres = Boolean(process.env.TEST_DATABASE_URL);
const testDb = useTestDb();
afterEach(() => resetCredentialConfig());
const FAST = { N: 1024, r: 8, p: 1 };
const keys = new Map([1, 2, 3].map((v) => [v, randomBytes(32)]));
function configure(current: number) {
  portalCredentials(true, {
    credentialKeys: keys,
    currentVersion: current,
    retiredVersions: new Set(),
    compromisedVersions: new Set(),
    kdf: FAST,
  });
  return credentialConfig();
}
const settledWithin = (promise: Promise<unknown>, ms: number) =>
  Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
  ]);

describe.skipIf(!realPostgres)('AC-360-F076-14 写回与轮换登记的协调（真 PG）', () => {
  it('写回事务进行中登记 k3：登记等写回提交；登记完成后剩余的 k2 凭据全部回滚', async () => {
    configure(2);
    const s = await sceneB(testDb().db, 'f076-14p');
    await rotateKeys(s.w.db, { to: 2, config: credentialConfig() });
    const v2 = configure(2);
    const v3 = { ...v2, currentVersion: 3 };

    let rotation: Promise<unknown> | undefined;
    let rotationWaitedForWriteBack: boolean | undefined;
    const run = runCredentialMaintenance(s.w.db, {
      tenantId: s.w.tenantId,
      config: v2,
      kdfConcurrency: 1,
      hooks: {
        // 第一行的写回事务已取得协调锁并复核通过、尚未提交：此时另一个连接开始登记 k3
        duringWriteBack: async () => {
          if (rotation) return;
          rotation = rotateKeys(s.w.db, { to: 3, config: v3 });
          rotationWaitedForWriteBack = !(await settledWithin(rotation, 500));
        },
      },
    });
    await expect(run).rejects.toThrow(/回退/);
    expect(rotationWaitedForWriteBack).toBe(true);
    await expect(rotation).resolves.toBeDefined();

    const links = await linkRows(s.w, s.activity.id);
    // 登记完成之前提交的那一行是合法的 k2；登记完成之后一条 k2 也没有提交
    expect(links.filter((l) => l.credential_state === 'issued').map((l) => l.credential_key_version)).toEqual([2]);
    expect(links.filter((l) => l.credential_state === 'pending').length).toBe(4);

    expect((await runCredentialMaintenance(s.w.db, { tenantId: s.w.tenantId, config: v3 })).issued).toBe(4);
  });
});
