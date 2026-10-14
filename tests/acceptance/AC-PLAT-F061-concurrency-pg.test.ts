/**
 * F-061 PR-2：回补与租户写入的锁序与交错（真 PostgreSQL；PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行，
 * 写法照 AC-SEED-concurrency-pg）。锁顺序（方案 §4.1）：补装锁（lockTenantSeeds）→ 标准身份行 FOR UPDATE；
 * 租户保存对象权限只取身份行锁。覆盖 T-12（回补互斥、旧路由互斥）、T-13（回补 × 对象权限保存双向交错）、
 * T-22（首次接管 × 审计清理交错：接管对每个身份只读一次审计）。
 * 做法：先让一个事务持锁不放，再发起另一个请求，确认它在等待（没有返回），释放后再核对结果。
 */
import { auditEvents, eq, permissionProfiles, withTenant } from '@italent/db';
import { STANDARD_PROFILES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { runAuditRetention } from '../../apps/api/src/audit/retention.js';
import { objectCatalog } from '../../apps/api/src/modules/permission/catalog.js';
import { takeoverProbe } from '../../apps/api/src/modules/permission/standard-seeds.js';
import { setObjectPermission } from '../../apps/api/src/modules/permission/profiles.js';
import { installMissingSeeds } from '../../apps/api/src/seeds/registry.js';
import { PLATFORM } from './support/platform-api.js';
import {
  BUTTON,
  expectWaitingOnLock,
  backfill,
  buttonCode,
  grantsInstalled,
  HR,
  legacySave,
  legacyWorld,
  ledger,
  OBJ,
  OTHER_BUTTON,
  permissionOf,
  putObject,
  revisionOf,
  runBackfill,
  withObject,
  withoutButton,
  type BackfillReport,
  type World,
} from './support/f061.js';
import { cmd } from './support/tenant-api.js';

const realPostgres = Boolean(process.env.TEST_DATABASE_URL);
const testDb = useTestDb();
const OBJECT = OBJ.objectCode;
const hrButton = buttonCode(HR.code, OBJECT, BUTTON);
const missingButton = [withObject(HR.code, OBJECT, withoutButton(BUTTON))];

/** 一个可以手动放行的闸门。 */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}
/** 持有事务（含已取得的锁）直到 hold.open()；返回 { started: 事务已执行完 body, done: 事务已提交 }。 */
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
const writeCtx = (w: World) => ({
  tenantId: w.tenantId,
  actorUserId: null,
  now: new Date(),
  commandId: `hold-${w.tenantId}`,
});
/** 审计保留清理（DEC-198）：legacySave 写的旧审计早于保留期，会被整条清掉。 */
const purgeAudits = (w: World) => runAuditRetention(testDb().db, cmd(), { tenantId: w.tenantId });
const setObjectAudits = (w: World) =>
  withTenant(w.db, w.tenantId, (tx) =>
    tx.select().from(auditEvents).where(eq(auditEvents.action, 'permission_profile.set_object')),
  );

describe.skipIf(!realPostgres)('AC-PLAT-F061 T-12 回补互斥（真 PG）', () => {
  it('两个不同命令 ID 的 seeds/backfill：后到者等待，不撞唯一约束、不 500；权限与台账各一份', async () => {
    const w = await legacyWorld(testDb().db, 'f061t12a', missingButton);
    const hold = gate();
    const first = holdTx(w, hold, (tx) => installMissingSeeds(tx, writeCtx(w), { modules: ['permission'] }));
    await first.started;
    const second = backfill(w);
    await expectWaitingOnLock(testDb().db, second);
    hold.open();
    const firstReport = await first.done;
    const res = await second;
    expect(res.status, await res.clone().text()).toBe(200);
    expect(firstReport.find((i) => i.key === 'standard-profile-grants')!.installed).toEqual([hrButton]);
    expect(grantsInstalled((await res.json()) as BackfillReport)).toEqual([]);
    expect(
      (await permissionOf(w, HR.code, OBJECT))!.buttons.filter((b) => b.buttonCode === BUTTON.buttonCode),
    ).toHaveLength(1);
    expect((await ledger(w)).get(hrButton)).toBe('install');
  });

  it('旧路由 standard-profiles/backfill 与 seeds/backfill 并发：旧路由等待补装锁，之后全部 ALREADY_INSTALLED，不 500', async () => {
    const w = await legacyWorld(
      testDb().db,
      'f061t12b',
      [],
      STANDARD_PROFILES.map((p) => p.code),
    );
    const hold = gate();
    const first = holdTx(w, hold, (tx) => installMissingSeeds(tx, writeCtx(w), { modules: ['permission'] }));
    await first.started;
    const old = w.api.request('POST', `${PLATFORM}/tenants/${w.tenantId}/standard-profiles/backfill`, {
      user: w.operator.id,
      body: {},
    });
    await expectWaitingOnLock(testDb().db, old);
    hold.open();
    await first.done;
    const res = await old;
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { installed: string[]; skipped: { reason: string }[] };
    expect(body.installed).toEqual([]);
    expect(body.skipped).toHaveLength(STANDARD_PROFILES.length);
    expect(new Set(body.skipped.map((s) => s.reason))).toEqual(new Set(['ALREADY_INSTALLED']));
  });
});

describe.skipIf(!realPostgres)('AC-PLAT-F061 T-13 回补 × 对象权限保存双向交错（真 PG）', () => {
  it('保存先提交：回补读到其结果，保存前后授予过的项不补，没改动的缺项（对象已改过）也不补', async () => {
    const w = await legacyWorld(testDb().db, 'f061t13a', missingButton);
    const profileId = w.profileIds.get(HR.code)!;
    const revision = await revisionOf(w, HR.code);
    const current = (await permissionOf(w, HR.code, OBJECT))!;
    const hold = gate();
    const save = holdTx(w, hold, (tx) =>
      setObjectPermission(
        tx,
        { tenantId: w.tenantId, userId: w.asAdmin.user, now: new Date(), commandId: 'save-1' },
        objectCatalog,
        {
          profileId,
          expectedRevision: revision,
          permission: { ...current, buttons: current.buttons.filter((b) => b.buttonCode !== OTHER_BUTTON.buttonCode) },
        },
      ),
    );
    await save.started;
    const pending = runBackfill(w);
    await expectWaitingOnLock(testDb().db, pending);
    hold.open();
    await save.done;
    expect(grantsInstalled(await pending)).toEqual([]);
    const after = (await permissionOf(w, HR.code, OBJECT))!;
    expect(after.buttons.some((b) => b.buttonCode === OTHER_BUTTON.buttonCode)).toBe(false);
    expect(after.buttons.some((b) => b.buttonCode === BUTTON.buttonCode)).toBe(false);
    expect((await ledger(w)).get(buttonCode(HR.code, OBJECT, OTHER_BUTTON))).toBe('tenant_saved');
  });

  it('回补先提交：等待中的保存按旧 revision 返回 409 REVISION_CONFLICT，刷新后重提成功', async () => {
    const w = await legacyWorld(testDb().db, 'f061t13b', missingButton);
    const profileId = w.profileIds.get(HR.code)!;
    const revision = await revisionOf(w, HR.code);
    const hold = gate();
    const fill = holdTx(w, hold, (tx) => installMissingSeeds(tx, writeCtx(w), { modules: ['permission'] }));
    await fill.started;
    const current = (await permissionOf(w, HR.code, OBJECT))!;
    const { objectCode: _code, ...body } = current;
    const save = w.api.request('PUT', `/api/tenant/permission/profiles/${profileId}/objects/${OBJECT}`, {
      ...w.asAdmin,
      ifMatch: revision,
      body,
    });
    await expectWaitingOnLock(testDb().db, save);
    hold.open();
    await fill.done;
    const res = await save;
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('REVISION_CONFLICT');
    expect(await revisionOf(w, HR.code)).toBe(revision + 1);
    const retry = await putObject(w, profileId, OBJECT, (o) => o);
    expect(retry.status).toBe(200);
  });
});

describe.skipIf(!realPostgres)('AC-PLAT-F061 T-22 首次接管 × 审计清理交错（真 PG）', () => {
  async function modifiedWorld(label: string) {
    const w = await legacyWorld(testDb().db, label, missingButton);
    // F-061 上线前保存过一次 OBJ：revision = 2，一条 set_object 审计，无 @modified 标记
    await legacySave(w, HR.code, OBJECT, (o) => ({
      ...o,
      buttons: o.buttons.filter((b) => b.buttonCode !== OTHER_BUTTON.buttonCode),
    }));
    expect(await setObjectAudits(w)).toHaveLength(1);
    return w;
  }

  it('清理发生在接管读审计之前：条数 < revision − 1，判历史不完整，缺项 withheld，不补', async () => {
    const w = await modifiedWorld('f061t22a');
    const profileId = w.profileIds.get(HR.code)!;
    const hold = gate();
    // 先占住标准身份行锁，让接管卡在第一步；其间清理审计，再放行
    const lock = holdTx(w, hold, (tx) =>
      tx.select().from(permissionProfiles).where(eq(permissionProfiles.id, profileId)).for('update'),
    );
    await lock.started;
    const pending = runBackfill(w);
    await expectWaitingOnLock(testDb().db, pending);
    await purgeAudits(w);
    expect(await setObjectAudits(w)).toHaveLength(0);
    hold.open();
    await lock.done;
    expect(grantsInstalled(await pending)).toEqual([]);
    expect((await ledger(w)).get(hrButton)).toBe('withheld');
    expect((await permissionOf(w, HR.code, OBJECT))!.buttons.some((b) => b.buttonCode === BUTTON.buttonCode)).toBe(
      false,
    );
  });

  it('清理发生在接管读审计之后：按已读到的结果判“确认改过”，缺项 withheld，不会被当成没改过而误补', async () => {
    const w = await modifiedWorld('f061t22b');
    takeoverProbe.afterAuditRead = async () => {
      takeoverProbe.afterAuditRead = undefined;
      await purgeAudits(w);
    };
    try {
      expect(grantsInstalled(await runBackfill(w))).toEqual([]);
    } finally {
      takeoverProbe.afterAuditRead = undefined;
    }
    expect(await setObjectAudits(w)).toHaveLength(0);
    expect((await ledger(w)).get(hrButton)).toBe('withheld');
    expect((await permissionOf(w, HR.code, OBJECT))!.buttons.some((b) => b.buttonCode === BUTTON.buttonCode)).toBe(
      false,
    );
  });
});
