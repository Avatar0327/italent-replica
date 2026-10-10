/**
 * F-052（#117 审查 P3，DEC-249③）：标准身份回补并发的边角——后到一方不得撞唯一约束返回 500。
 * 真 PostgreSQL（PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行，写法照 AC-PLAT-F061-concurrency-pg）。
 * ① 两个不同命令 ID 同时回补同一租户（租户里一个标准身份都没有）：后到者等补装锁，之后全部已装，不 500；
 * ② 回补与同编码自定义身份创建并发：
 *    - 自定义先写（未提交）、回补后到：回补等唯一键，自定义提交后回补不覆盖、不 500，按 DEC-402⑤ 口径列为 CODE_TAKEN，
 *      其余标准身份照常装；自定义行原样保留（source = custom）；
 *    - 回补先写（未提交）、自定义后到：自定义创建返回 409 CONFLICT（身份编码已存在），不 500。
 */
import { permissionProfiles, withTenant } from '@italent/db';
import { STANDARD_PROFILES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { createProfile } from '../../apps/api/src/modules/permission/profiles.js';
import { installMissingSeeds } from '../../apps/api/src/seeds/registry.js';
import { PLATFORM } from './support/platform-api.js';
import { backfill, expectWaitingOnLock, HR, legacyWorld, type World } from './support/f061.js';

const realPostgres = Boolean(process.env.TEST_DATABASE_URL);
const testDb = useTestDb();
const allCodes = STANDARD_PROFILES.map((p) => p.code);
const otherCodes = allCodes.filter((code) => code !== HR.code);

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}
/** 持有事务直到 hold.open()；started = 事务已执行完 body，done = 事务已提交（或失败）。 */
function holdTx<T>(
  w: World,
  hold: ReturnType<typeof gate>,
  body: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>,
) {
  const started = gate();
  const done = withTenant(w.db, w.tenantId, async (tx) => {
    const result = await body(tx);
    started.open();
    await hold.opened;
    return result;
  });
  return { started: started.opened, done };
}
const platformWrite = (w: World) => ({
  tenantId: w.tenantId,
  actorUserId: null,
  now: new Date(),
  commandId: `hold-${w.tenantId}`,
});
const profileRows = (w: World) =>
  withTenant(w.db, w.tenantId, (tx) =>
    tx.select({ code: permissionProfiles.code, source: permissionProfiles.source }).from(permissionProfiles),
  );

interface SeedReport {
  items: { key: string; installed: string[]; existing: number; existingDetails?: { code: string; reason: string }[] }[];
}

describe.skipIf(!realPostgres)('AC-PLAT-F052 ① 两个不同命令 ID 同时回补（真 PG）', () => {
  it('租户一个标准身份都没有：后到者等补装锁，不撞唯一约束、不 500；每个标准身份各一份', async () => {
    const w = await legacyWorld(testDb().db, 'f052a', [], allCodes);
    const hold = gate();
    const first = holdTx(w, hold, (tx) => installMissingSeeds(tx, platformWrite(w), { modules: ['permission'] }));
    await first.started;
    const second = backfill(w);
    await expectWaitingOnLock(testDb().db, second);
    hold.open();
    const firstReport = await first.done;
    const res = await second;
    expect(res.status, await res.clone().text()).toBe(200);
    expect(firstReport.find((i) => i.key === 'standard-profiles')!.installed.sort()).toEqual([...allCodes].sort());
    const body = (await res.json()) as SeedReport;
    expect(body.items.find((i) => i.key === 'standard-profiles')!.installed).toEqual([]);
    const rows = await profileRows(w);
    expect(rows.filter((r) => allCodes.includes(r.code))).toHaveLength(allCodes.length);
  });
});

describe.skipIf(!realPostgres)('AC-PLAT-F052 ② 回补 × 同编码自定义身份创建（真 PG）', () => {
  it('seeds/backfill：自定义先写未提交、回补后到——回补不 500，该编码列为 CODE_TAKEN，其余照装，自定义行保留', async () => {
    const w = await legacyWorld(testDb().db, 'f052b', [], allCodes);
    const hold = gate();
    const custom = holdTx(w, hold, (tx) =>
      createProfile(
        tx,
        { tenantId: w.tenantId, userId: w.asAdmin.user, now: new Date(), commandId: 'custom-hr' },
        { code: HR.code, name: '租户自建的人事管理员', description: '手工建的同编码身份', apps: [], licenseType: null },
      ),
    );
    await custom.started;
    const pending = backfill(w);
    await expectWaitingOnLock(testDb().db, pending);
    hold.open();
    await custom.done;
    const res = await pending;
    expect(res.status, await res.clone().text()).toBe(200);
    const item = ((await res.json()) as SeedReport).items.find((i) => i.key === 'standard-profiles')!;
    expect(item.installed.sort()).toEqual([...otherCodes].sort());
    expect(item.existingDetails).toEqual([{ code: HR.code, reason: 'CODE_TAKEN' }]);
    const rows = await profileRows(w);
    expect(rows.filter((r) => r.code === HR.code)).toEqual([{ code: HR.code, source: 'custom' }]);
    expect(rows.filter((r) => otherCodes.includes(r.code)).every((r) => r.source === 'standard')).toBe(true);
  });

  it('旧路由 standard-profiles/backfill：同样不 500，该编码 skipped CODE_TAKEN，其余 installed', async () => {
    const w = await legacyWorld(testDb().db, 'f052c', [], allCodes);
    const hold = gate();
    const custom = holdTx(w, hold, (tx) =>
      createProfile(
        tx,
        { tenantId: w.tenantId, userId: w.asAdmin.user, now: new Date(), commandId: 'custom-hr' },
        { code: HR.code, name: '租户自建的人事管理员', description: '手工建的同编码身份', apps: [], licenseType: null },
      ),
    );
    await custom.started;
    const pending = w.api.request('POST', `${PLATFORM}/tenants/${w.tenantId}/standard-profiles/backfill`, {
      user: w.operator.id,
      body: {},
    });
    await expectWaitingOnLock(testDb().db, pending);
    hold.open();
    await custom.done;
    const res = await pending;
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { installed: string[]; skipped: { code: string; reason: string }[] };
    expect(body.installed.sort()).toEqual([...otherCodes].sort());
    expect(body.skipped).toEqual([{ code: HR.code, reason: 'CODE_TAKEN' }]);
    expect((await profileRows(w)).find((r) => r.code === HR.code)!.source).toBe('custom');
  });

  it('回补先写未提交、自定义后到：自定义创建 409 CONFLICT（身份编码已存在），不 500；标准身份完好', async () => {
    const w = await legacyWorld(testDb().db, 'f052d', [], allCodes);
    const hold = gate();
    const fill = holdTx(w, hold, (tx) => installMissingSeeds(tx, platformWrite(w), { modules: ['permission'] }));
    await fill.started;
    const custom = withTenant(w.db, w.tenantId, (tx) =>
      createProfile(
        tx,
        { tenantId: w.tenantId, userId: w.asAdmin.user, now: new Date(), commandId: 'custom-hr' },
        { code: HR.code, name: '租户自建的人事管理员', description: '手工建的同编码身份', apps: [], licenseType: null },
      ),
    );
    await expectWaitingOnLock(testDb().db, custom);
    hold.open();
    await fill.done;
    await expect(custom).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await profileRows(w)).find((r) => r.code === HR.code)!.source).toBe('standard');
  });
});
