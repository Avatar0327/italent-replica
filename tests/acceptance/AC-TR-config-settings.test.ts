/**
 * R3-T04 PR-B1 盘点租户设置（设计 §2.2 settings、§4.1 系统主体指定）：
 * - 单例资源：没有记录时返回默认值与 revision 0，首次保存 If-Match 0 建立；之后按 revision 乐观锁；
 * - 四个键：兼岗提名、本人结果可见（缺省关闭，Q-M0-129 取证前不开放成果页）、完成页隐藏继任、系统主体用户；
 * - 系统主体必须是当前租户的有效成员（不存在 / 其他租户都是 400），可显式清空；
 * - 指定系统主体写数据变更日志（只记改动字段）。
 */
import { TALENT_REVIEW_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { configWorld, TR_NOW } from './AC-TR-config-support.js';
import { errorCode } from './support/tenant-api.js';

const testDb = useTestDb();
const DEFAULTS = {
  allowSecondaryKeyPositionNomination: false,
  selfResultVisible: false,
  doneHideSuccession: false,
  systemPrincipalUserId: null,
};
interface SettingsView {
  readonly revision: number;
  readonly allowSecondaryKeyPositionNomination: boolean;
  readonly selfResultVisible: boolean;
  readonly doneHideSuccession: boolean;
  readonly systemPrincipalUserId: string | null;
}

describe('盘点租户设置（设计 §2.2）', () => {
  it('没有记录时返回默认值与 revision 0；首次保存 If-Match 0 建立，之后按 revision 乐观锁', async () => {
    const w = await configWorld(testDb().db, 'trc-settings');
    const initial = await w.request('GET', '/settings');
    expect(initial.status).toBe(200);
    expect(initial.headers.get('etag')).toBe('"0"');
    expect(await initial.json()).toMatchObject({ ...DEFAULTS, revision: 0 });
    const created = await w.request('PATCH', '/settings', { ifMatch: 0, body: { doneHideSuccession: true } });
    expect(created.status, await created.clone().text()).toBe(200);
    expect(await created.json()).toMatchObject({ ...DEFAULTS, doneHideSuccession: true, revision: 1 });
    const stale = await w.request('PATCH', '/settings', { ifMatch: 0, body: { selfResultVisible: true } });
    expect([stale.status, await errorCode(stale)]).toEqual([409, 'REVISION_CONFLICT']);
    const second = await w.request('PATCH', '/settings', {
      ifMatch: 1,
      body: { allowSecondaryKeyPositionNomination: true },
    });
    expect(await second.json()).toMatchObject({
      allowSecondaryKeyPositionNomination: true,
      doneHideSuccession: true,
      selfResultVisible: false,
      revision: 2,
    });
    const missing = await w.request('PATCH', '/settings', { body: { selfResultVisible: true } });
    expect(await errorCode(missing)).toBe('REVISION_REQUIRED');
    const unknown = await w.request('PATCH', '/settings', { ifMatch: 2, body: { other: 1 } });
    expect([unknown.status, await errorCode(unknown)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(((await (await w.request('GET', '/settings')).json()) as SettingsView).revision).toBe(2);
  });

  it('同幂等键同内容重放首次结果，异内容 409；并发首次保存只有一个成功', async () => {
    const w = await configWorld(testDb().db, 'trc-settings-idem');
    const options = { ifMatch: 0, idempotencyKey: 'trc-settings-1', body: { selfResultVisible: true } };
    const first = await w.request('PATCH', '/settings', options);
    const replay = await w.request('PATCH', '/settings', options);
    expect([replay.status, await replay.json()]).toEqual([200, await first.json()]);
    const conflict = await w.request('PATCH', '/settings', { ...options, body: { selfResultVisible: false } });
    expect(await errorCode(conflict)).toBe('IDEMPOTENCY_CONFLICT');
    const racing = await Promise.all(
      [1, 2].map((n) => w.request('PATCH', '/settings', { ifMatch: 0, body: { doneHideSuccession: n === 1 } })),
    );
    expect(racing.map((response) => response.status).sort()).toEqual([409, 409]);
  });

  it('系统主体必须是本租户的有效成员；其他租户、不存在、非 UUID 都是 400，可以显式清空', async () => {
    const db = testDb().db;
    const w = await configWorld(db, 'trc-settings-principal');
    const other = await configWorld(db, 'trc-settings-principal-other');
    const body = (systemPrincipalUserId: unknown) => ({ ifMatch: 0, body: { systemPrincipalUserId } });
    for (const bad of [other.as.user, '00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      const response = await w.request('PATCH', '/settings', body(bad));
      expect([response.status, await errorCode(response)], String(bad)).toEqual([400, 'VALIDATION_FAILED']);
    }
    expect(((await (await w.request('GET', '/settings')).json()) as SettingsView).revision).toBe(0);
    const ok = await w.request('PATCH', '/settings', body(w.as.user.toUpperCase()));
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await ok.json()).toMatchObject({ systemPrincipalUserId: w.as.user, revision: 1 });
    const cleared = await w.request('PATCH', '/settings', { ifMatch: 1, body: { systemPrincipalUserId: null } });
    expect(await cleared.json()).toMatchObject({ systemPrincipalUserId: null, revision: 2 });
    expect(other.as.user).not.toBe(w.as.user);
  });

  it('指定系统主体写数据变更日志，只记改动字段；其他租户读不到该租户的设置', async () => {
    const db = testDb().db;
    const w = await configWorld(db, 'trc-settings-audit');
    const other = await configWorld(db, 'trc-settings-audit-other');
    const audit = auditApi(db, TR_NOW.toISOString());
    await w.request('PATCH', '/settings', { ifMatch: 0, body: { doneHideSuccession: true } });
    const patched = await w.request('PATCH', '/settings', { ifMatch: 1, body: { systemPrincipalUserId: w.as.user } });
    expect(patched.status).toBe(200);
    const objectType = TALENT_REVIEW_OBJECTS.settings.code;
    const { items } = await audit.dataChanges(w.as, { objectType, limit: '50' });
    expect(items.map((entry) => entry.operation).sort()).toEqual(['create', 'update']);
    const update = items.find((entry) => entry.operation === 'update')!;
    expect(update.changes.map((change) => change.field)).toEqual(['systemPrincipalUserId']);
    expect(((await (await other.request('GET', '/settings')).json()) as SettingsView).revision).toBe(0);
  });
});
