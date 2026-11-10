/**
 * AC-TRF-F481-18 场景设置（设计 §4.1、§5.4、§12）：默认 2 天不提醒；有效期只收 2～30；revision 乐观锁；
 * 租户间互不影响。“之后发起的任务 expires_at = +30×24h”属 S2（发起函数），本片不测。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { denySettings, esignWorld } from './AC-TRF-F481-support.js';

const db = useTestDb();
const PATH = '/scenes/transfer';

describe('AC-TRF-F481-18 场景设置', () => {
  it('没有行时读出默认值：2 天、不提醒、revision 0', async () => {
    const w = await esignWorld(db().db, 'scene');
    const response = await w.call('GET', PATH);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      scene: 'transfer',
      validityDays: 2,
      remindBeforeExpiry: false,
      revision: 0,
    });
  });

  it('1 与 31 天 400；30 天 200 并 revision + 1；2 天边界合法', async () => {
    const w = await esignWorld(db().db, 'scene-range');
    for (const validityDays of [1, 31, 0, 2.5, '5']) {
      const r = await w.call('PUT', PATH, { ifMatch: 0, body: { validityDays, remindBeforeExpiry: false } });
      expect(r.status, String(validityDays)).toBe(400);
    }
    expect(((await w.call('GET', PATH).then((r) => r.json())) as { revision: number }).revision).toBe(0);
    const ok = await w.call('PUT', PATH, { ifMatch: 0, body: { validityDays: 30, remindBeforeExpiry: true } });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await ok.json()).toMatchObject({ validityDays: 30, remindBeforeExpiry: true, revision: 1 });
    const edge = await w.call('PUT', PATH, { ifMatch: 1, body: { validityDays: 2, remindBeforeExpiry: false } });
    expect(await edge.json()).toMatchObject({ validityDays: 2, remindBeforeExpiry: false, revision: 2 });
    expect(await w.call('GET', PATH).then((r) => r.json())).toMatchObject({ validityDays: 2, revision: 2 });
  });

  it('旧 revision 409 且不改数据；缺 If-Match 400；缺字段 / 多余字段 400', async () => {
    const w = await esignWorld(db().db, 'scene-rev');
    await w.call('PUT', PATH, { ifMatch: 0, body: { validityDays: 10, remindBeforeExpiry: false } });
    const stale = await w.call('PUT', PATH, { ifMatch: 0, body: { validityDays: 20, remindBeforeExpiry: false } });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe('REVISION_CONFLICT');
    expect(await w.call('GET', PATH).then((r) => r.json())).toMatchObject({ validityDays: 10, revision: 1 });
    expect((await w.call('PUT', PATH, { body: { validityDays: 5, remindBeforeExpiry: false } })).status).toBe(400);
    expect((await w.call('PUT', PATH, { ifMatch: 1, body: { validityDays: 5 } })).status).toBe(400);
    expect(
      (await w.call('PUT', PATH, { ifMatch: 1, body: { validityDays: 5, remindBeforeExpiry: false, x: 1 } })).status,
    ).toBe(400);
  });

  it('没有 ESignSettings 权限读写都 403；租户之间的设置互不影响', async () => {
    const a = await esignWorld(db().db, 'scene-a');
    await a.call('PUT', PATH, { ifMatch: 0, body: { validityDays: 7, remindBeforeExpiry: true } });
    const b = await esignWorld(db().db, 'scene-b');
    expect(await b.call('GET', PATH).then((r) => r.json())).toMatchObject({ validityDays: 2, revision: 0 });
    const denied = await esignWorld(db().db, 'scene-denied', denySettings);
    expect((await denied.call('GET', PATH)).status).toBe(403);
    expect(
      (await denied.call('PUT', PATH, { ifMatch: 0, body: { validityDays: 7, remindBeforeExpiry: true } })).status,
    ).toBe(403);
  });

  it('场景设置修改写字段级审计', async () => {
    const w = await esignWorld(db().db, 'scene-audit');
    await w.call('PUT', PATH, { ifMatch: 0, body: { validityDays: 9, remindBeforeExpiry: true } });
    const { auditEvents, eq, and, withTenant } = await import('@italent/db');
    const rows = await withTenant(db().db, w.session.tenant.id, (tx) =>
      tx
        .select({ action: auditEvents.action, objectType: auditEvents.objectType })
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, w.session.tenant.id), eq(auditEvents.objectType, 'esign-scene-settings'))),
    );
    expect(rows).toEqual([{ action: 'esign.scene.update', objectType: 'esign-scene-settings' }]);
  });
});
