/**
 * F-061 PR-2：已上线租户的首次接管（方案 §5，D1 = A，DEC-374）。F-061 上线前开通的租户台账为空，首次回补按身份判断：
 * 对象行不存在 / 身份 revision = 1 / 历史完整且该对象无 @modified 标记、无 set_object 审计 → 确认没改过，缺项补；
 * 有标记或有审计 → 确认改过，缺项记 withheld 不补；无标记无审计但历史不完整（审计条数 < revision − 1）→ 历史不足以判断，
 * 缺项记 withheld 不补。接管只登记、不改权限、不写业务审计。当前已有的项记 adopted，最后写 @ledger。
 * 覆盖 T-08、T-09（D1 = A）、T-18；T-22（接管 × 审计清理的真 PG 交错）在 AC-PLAT-F061-concurrency-pg。
 */
import { auditEvents, withTenant } from '@italent/db';
import { profileLedgerMarker, STANDARD_PROFILES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  BUTTON,
  buttonCode,
  FIELD,
  fieldCode,
  grantsInstalled,
  HR,
  inflateRevision,
  legacySave,
  legacyWorld,
  ledger,
  OBJ,
  OBJ_B,
  OBJ_C,
  OTHER_BUTTON,
  permissionOf,
  putObject,
  revisionOf,
  runBackfill,
  withObject,
  withoutButton,
  type World,
} from './support/f061.js';

const testDb = useTestDb();
const OBJECT = OBJ.objectCode;
const hrButton = buttonCode(HR.code, OBJECT, BUTTON);
const auditCount = (w: World) =>
  withTenant(w.db, w.tenantId, async (tx) => (await tx.select({ id: auditEvents.id }).from(auditEvents)).length);
const hasButton = async (w: World, object: string, button: string) =>
  (await permissionOf(w, HR.code, object))!.buttons.some((b) => b.buttonCode === button);
const withoutOther = (o: NonNullable<Awaited<ReturnType<typeof permissionOf>>>) => ({
  ...o,
  buttons: o.buttons.filter((b) => b.buttonCode !== OTHER_BUTTON.buttonCode),
});

describe('AC-PLAT-F061 T-08 接管：对象没改过', () => {
  it('旧版本升级夹具缺一个按钮、身份 revision = 1 → 首次回补：已有项记 adopted、缺项补上；接管不写业务审计', async () => {
    const w = await legacyWorld(testDb().db, 'f061t08', [withObject(HR.code, OBJECT, withoutButton(BUTTON))]);
    expect((await ledger(w)).size).toBe(0);
    const audits = await auditCount(w);
    expect(grantsInstalled(await runBackfill(w))).toEqual([hrButton]);

    const now = await ledger(w);
    for (const profile of STANDARD_PROFILES) expect(now.get(profileLedgerMarker(profile.code))).toBe('adopted');
    expect(now.get(buttonCode(HR.code, OBJECT, OTHER_BUTTON))).toBe('adopted');
    expect(now.get(fieldCode(HR.code, OBJECT, FIELD, 'edit'))).toBe('adopted');
    expect(now.get(hrButton)).toBe('install');
    expect(await hasButton(w, OBJECT, BUTTON.buttonCode)).toBe(true);
    expect([...now.values()]).not.toContain('withheld');
    // 只多一条 backfill_grants（装上缺失按钮），接管本身没有业务审计
    expect((await auditCount(w)) - audits).toBe(1);
  });
});

describe('AC-PLAT-F061 T-09 接管：对象确认改过（D1 = A）', () => {
  const MODIFIERS = [
    ['租户经 API 保存（有 @modified 标记和审计）', 'api'],
    ['F-061 上线前保存（只有 set_object 审计，无标记）', 'legacy'],
  ] as const;

  it.each(MODIFIERS)(
    '缺项记 withheld 不补；同身份其他没改过的对象照常补；撤销的项不恢复 —— %s',
    async (_label, via) => {
      const w = await legacyWorld(testDb().db, `f061t09-${via}`, [
        withObject(HR.code, OBJECT, withoutButton(BUTTON)),
        withObject(HR.code, OBJ_B.objectCode, withoutButton(OBJ_B.buttons[0]!)),
      ]);
      const profileId = w.profileIds.get(HR.code)!;
      if (via === 'api') {
        const res = await putObject(w, profileId, OBJECT, withoutOther);
        expect(res.status, await res.clone().text()).toBe(200);
      } else {
        await legacySave(w, HR.code, OBJECT, withoutOther);
      }
      expect(await revisionOf(w, HR.code)).toBe(2);

      const report = await runBackfill(w);
      // OBJ 改过：缺的 BUTTON 不补；OBJ_B 没改过：缺的按钮补上
      expect(grantsInstalled(report)).toEqual([buttonCode(HR.code, OBJ_B.objectCode, OBJ_B.buttons[0]!)]);
      expect(await hasButton(w, OBJECT, BUTTON.buttonCode)).toBe(false);
      expect(await hasButton(w, OBJECT, OTHER_BUTTON.buttonCode)).toBe(false);
      const now = await ledger(w);
      expect(now.get(hrButton)).toBe('withheld');
      expect(now.get(profileLedgerMarker(HR.code))).toBe('adopted');

      // 之后再回补：withheld 不动
      expect(grantsInstalled(await runBackfill(w))).toEqual([]);
      expect(await hasButton(w, OBJECT, BUTTON.buttonCode)).toBe(false);
    },
  );
});

describe('AC-PLAT-F061 T-18 接管：历史不完整', () => {
  it('审计条数 < revision − 1：无标记无审计的对象缺项记 withheld 不补；对象行不存在的新对象仍补', async () => {
    const w = await legacyWorld(testDb().db, 'f061t18', [
      withObject(HR.code, OBJECT, withoutButton(BUTTON)),
      withObject(HR.code, OBJ_C.objectCode, null),
    ]);
    // 另一个对象被保存过一次（1 条审计），再把 revision 调大 3：有更早的保存审计已被清理
    await legacySave(w, HR.code, OBJ_B.objectCode, (o) => o);
    await inflateRevision(w, HR.code, 3);
    expect(await permissionOf(w, HR.code, OBJ_C.objectCode)).toBeUndefined();

    const installed = grantsInstalled(await runBackfill(w));
    expect(installed).not.toContain(hrButton);
    expect((await ledger(w)).get(hrButton)).toBe('withheld');
    expect(await hasButton(w, OBJECT, BUTTON.buttonCode)).toBe(false);
    // 新对象：对象行不存在 → 确认未保存过 → 整个对象补齐
    expect(installed).toContain(`${HR.code}/${OBJ_C.objectCode}/op:view`);
    const created = await permissionOf(w, HR.code, OBJ_C.objectCode);
    expect(created!.fields.length).toBe(OBJ_C.fields.length);
    expect(created!.buttons.length).toBe(OBJ_C.buttons.length);
  });
});
