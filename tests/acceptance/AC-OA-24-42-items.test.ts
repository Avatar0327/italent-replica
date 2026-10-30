import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { BASE, bodyOf, expectError, only } from './AC-OA-head-support.js';
import { type ItemsResult, itemsWorld, newOrg, rename, stop } from './AC-OA-items-support.js';

const testDb = useTestDb();

describe('AC-OA-24 明细组织须在组织对象范围（F-287）：范围外与不存在同一 404', () => {
  it('目标 / 新上级 / 转移目标 / 连带下级不在范围 → 404，消息与不存在相同，不写库', async () => {
    const w = await itemsWorld(testDb().db, 'oa24');
    const child = await w.org(`下级${randomUUID()}`, w.a);
    const view = await w.created({ ...w.head(), adjustmentRange: [w.a, w.b] });
    const missing = await w.addItem(view.id, rename(randomUUID()));
    await expectError(missing, 404, 'NOT_FOUND');
    const notFound = (await bodyOf(missing)).error!.message;
    w.access.org = only(w.a);
    const cases = [
      rename(w.b),
      newOrg(w.b),
      rename(w.a, { name: undefined, parent: { orgId: w.b } }),
      stop(w.a, { transferTo: { orgId: w.b } }),
    ];
    for (const body of cases) {
      const res = await w.addItem(view.id, body);
      await expectError(res, 404, 'NOT_FOUND');
      expect((await bodyOf(res)).error!.message).toBe(notFound);
    }
    w.access.org = only(w.a, w.b);
    const cascaded = await w.addItem(view.id, stop(w.a));
    await expectError(cascaded, 404, 'NOT_FOUND');
    expect((await bodyOf(cascaded)).error!.message).toBe(notFound);
    expect(await w.rows(view.id)).toEqual([]);
    w.access.org = only(w.a, child);
    expect((await w.addItem(view.id, stop(w.a))).status).toBe(201);
  });

  it('改行 / 删行时目标已出范围 → 404；申请单不在主对象范围 → 404', async () => {
    const w = await itemsWorld(testDb().db, 'oa24');
    const view = await w.created({ ...w.head(), adjustmentRange: [w.a, w.b] });
    const created = await w.item(view.id, rename(w.b));
    const itemId = created.items[0]!.id;
    w.access.org = only(w.a);
    await expectError(await w.patchItem(view.id, itemId, { name: '范围外' }), 404, 'NOT_FOUND');
    await expectError(await w.deleteItem(view.id, itemId), 404, 'NOT_FOUND');
    w.access.org = only(w.a, w.b);
    w.access.main = only(w.b);
    await expectError(await w.addItem(view.id, rename(w.a)), 404, 'NOT_FOUND');
    expect(await w.rows(view.id)).toHaveLength(1);
  });
});

describe('AC-OA-24 明细重放复核与按查看权裁剪（F-087 同类）', () => {
  it('同命令重放时目标已出组织范围 → 404，与首次判定同口径', async () => {
    const w = await itemsWorld(testDb().db, 'oa24');
    const view = await w.created({ ...w.head(), adjustmentRange: [w.a, w.b] });
    const body = rename(w.b);
    const idempotencyKey = randomUUID();
    const send = () => w.call('POST', `${BASE}/${view.id}/org-items`, { ifMatch: 1, body, idempotencyKey });
    expect((await send()).status).toBe(201);
    w.access.org = only(w.a);
    await expectError(await send(), 404, 'NOT_FOUND');
    w.access.org = only(w.a, w.b);
    expect((await send()).status).toBe(201);
    expect(await w.rows(view.id)).toHaveLength(1);
  });

  it('看不到 orgItems 字段：明细响应去掉对应列，校验信封的明细问题不带组织 ID', async () => {
    const w = await itemsWorld(testDb().db, 'oa24');
    const view = await w.created();
    const itemId = (await w.item(view.id, rename(w.a))).items[0]!.id;
    await w.touchOrg(w.a);
    const stale = (await w.checked(view.id)).errors.find((e) => e.itemId === itemId);
    expect(stale).toMatchObject({ reason: 'ORG_ADJUSTMENT_BASELINE_CHANGED', orgId: w.a });
    w.access.hiddenFields.add('orgItems.targetOrgId').add('orgItems.name');
    const hidden = (await w.checked(view.id)).errors.find((e) => e.itemId === itemId);
    expect(hidden).toMatchObject({ section: 'org', reason: 'ORG_ADJUSTMENT_BASELINE_CHANGED' });
    expect(hidden).not.toHaveProperty('orgId');
    const res = await w.rebaseItem(view.id, itemId);
    expect(res.status, await res.clone().text()).toBe(200);
    const [row] = ((await res.json()) as ItemsResult).items;
    expect(row).toMatchObject({ id: itemId, seq: 1 });
    expect(row).not.toHaveProperty('targetOrgId');
    expect(row).not.toHaveProperty('name');
  });
});

describe('AC-OA-42 明细出调整范围（§5.6）', () => {
  it('目标 / 新上级 / 转移目标在范围外 → 400 OUT_OF_RANGE；范围内组织的下级在范围内', async () => {
    const w = await itemsWorld(testDb().db, 'oa42');
    const child = await w.org(`下级${randomUUID()}`, w.a);
    const view = await w.created();
    for (const body of [rename(w.b), newOrg(w.b), rename(w.a, { name: undefined, parent: { orgId: w.b } })])
      await expectError(await w.addItem(view.id, body), 400, 'VALIDATION_FAILED', 'ORG_ADJUSTMENT_OUT_OF_RANGE');
    expect((await w.addItem(view.id, rename(child))).status).toBe(201);
    const fresh = await w.item(view.id, newOrg(child));
    expect((await w.addItem(view.id, newOrg(w.a, { parent: { itemId: fresh.items[0]!.id } }))).status).toBe(201);
  });

  it('改头缩小范围使已有明细出范围 → 400 并列出明细；不影响的缩小照常', async () => {
    const w = await itemsWorld(testDb().db, 'oa42');
    const view = await w.created({ ...w.head(), adjustmentRange: [w.a, w.b] });
    await w.item(view.id, rename(w.b));
    const res = await w.patch(view.id, { adjustmentRange: [w.a] }, 2);
    await expectError(res, 400, 'VALIDATION_FAILED', 'ORG_ADJUSTMENT_OUT_OF_RANGE');
    expect((await bodyOf(res)).error!.details).toMatchObject({ items: [expect.objectContaining({ section: 'org' })] });
    expect((await w.stored(view.id))!.range).toEqual([w.a, w.b]);
    expect((await w.patch(view.id, { adjustmentRange: [w.b] }, 2)).status).toBe(200);
  });
});
