/**
 * R2-T08 BE-10d：AC-OA-24（读）——审批主体组织在申请单对象范围外 → 列表不出现、详情 404；
 * 明细组织在组织对象范围外 → 读时整行隐去（设计 §4.5、§10；F-339 同类：范围外与不存在同文案）。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { bodyOf, expectError, only } from './AC-OA-head-support.js';
import { itemsWorld, newOrg, rename } from './AC-OA-items-support.js';
import { flatten, orgName, reader } from './AC-OA-read-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();

describe('AC-OA-24 主体组织范围：列表先过滤再分页，详情范围外与不存在同一 404', () => {
  it('范围外的申请不出现、总数不含；筛选范围外主体与筛选不存在的组织结果相同', async () => {
    const w = await itemsWorld(testDb().db, 'oa24r');
    const r = reader(w);
    const other = await w.org(`主体二${uniqueSuffix()}`);
    w.setNow('2026-10-01T01:00:00.000Z');
    const hidden = await w.created(w.head({ approvalSubjectOrgId: other }));
    w.setNow('2026-10-02T01:00:00.000Z');
    const shown = await w.created(w.head());
    w.access.main = only(w.subject);

    const page = await r.list('pageSize=1');
    expect(page.items.map((row) => row.id)).toEqual([shown.id]);
    expect(page.total).toBe(1);
    const outside = await r.list(`approvalSubjectOrgId=${other}`);
    const missing = await r.list(`approvalSubjectOrgId=${randomUUID()}`);
    expect(outside).toEqual(missing);
    expect(outside).toMatchObject({ items: [], total: 0 });

    const notFound = await r.detailRes(randomUUID());
    await expectError(notFound, 404, 'NOT_FOUND');
    const message = (await bodyOf(notFound)).error!.message;
    for (const res of [
      await r.detailRes(hidden.id),
      await r.itemsRes(hidden.id),
      await r.previewRes(hidden.id),
      await r.itemsRes(randomUUID()),
      await r.previewRes(randomUUID()),
    ]) {
      await expectError(res, 404, 'NOT_FOUND');
      expect((await bodyOf(res)).error!.message).toBe(message);
    }
    expect((await r.detail(shown.id)).id).toBe(shown.id);
  });

  it('范围外的申请创建最晚（排在最前）→ pageSize=1 仍返回范围内那条，总数不含范围外', async () => {
    const w = await itemsWorld(testDb().db, 'oa24r');
    const r = reader(w);
    const other = await w.org(`主体二${uniqueSuffix()}`);
    w.setNow('2026-10-01T01:00:00.000Z');
    const shown = await w.created(w.head());
    w.setNow('2026-10-02T01:00:00.000Z');
    const hidden = await w.created(w.head({ approvalSubjectOrgId: other }));
    w.access.main = only(w.subject);

    const page = await r.list('pageSize=1');
    expect(page.items.map((row) => row.id)).toEqual([shown.id]);
    expect(page).toMatchObject({ total: 1, page: 1, pageSize: 1 });
    expect(JSON.stringify(page)).not.toContain(hidden.id);
    expect((await r.list('page=2&pageSize=1')).items).toEqual([]);
  });

  it('没有数据范围 → 列表为空（fail-closed）、详情 404；没有对象查看权 → 列表 403、详情 404', async () => {
    const w = await itemsWorld(testDb().db, 'oa24r');
    const r = reader(w);
    const view = await w.created(w.head());
    w.access.main = EMPTY_SCOPE;
    expect(await r.list()).toMatchObject({ items: [], total: 0 });
    await expectError(await r.detailRes(view.id), 404, 'NOT_FOUND');
    w.access.main = only(w.subject);
    w.access.viewDenied = true;
    await expectError(await r.listRes(), 403, 'FORBIDDEN');
    for (const res of [await r.detailRes(view.id), await r.itemsRes(view.id), await r.previewRes(view.id)]) {
      await expectError(res, 404, 'NOT_FOUND');
    }
  });
});

describe('AC-OA-24 明细组织范围：读时整行隐去，只计 hiddenRowCount', () => {
  it('目标 / 新上级 / 转移目标任一在组织范围外 → 明细不返回该行，详情计入隐藏行，预览不出现该节点', async () => {
    const w = await itemsWorld(testDb().db, 'oa24r');
    const r = reader(w);
    const view = await w.created(w.head({ adjustmentRange: [w.a, w.b] }));
    const inA = await w.item(view.id, newOrg(w.a));
    const inB = await w.item(view.id, newOrg(w.b));
    const renamedB = await w.item(view.id, rename(w.b));
    const movedA = await w.item(view.id, rename(w.a, { name: undefined, parent: { orgId: w.b } }));
    const [keepId, hideNew, hideRename, hideMove] = [inA, inB, renamedB, movedA].map((v) => v.items.at(-1)!.id);
    const hiddenNames = [inB.items.at(-1)!.name, renamedB.items.at(-1)!.name];
    w.access.org = only(w.a);

    const items = await r.items(view.id);
    expect(items.items.map((item) => item.id)).toEqual([keepId]);
    expect(items.hiddenRowCount).toBe(3);
    expect(JSON.stringify(items)).not.toContain(w.b);
    const detail = await r.detail(view.id);
    expect(detail.sections).toEqual({ org: { count: 1, hiddenRowCount: 3 } });

    const nodes = flatten((await r.preview(view.id)).roots);
    const itemIds = nodes.map((node) => node.itemId).filter(Boolean);
    expect(itemIds).toEqual([keepId]);
    for (const id of [hideNew, hideRename, hideMove]) expect(itemIds).not.toContain(id);
    const text = JSON.stringify(nodes);
    for (const name of hiddenNames) expect(text).not.toContain(name);
    // 范围外的组织本身也不出现在 HR 的预览树里；甲没有被隐藏行改动，标记为空
    expect(nodes.map((node) => node.orgId)).not.toContain(w.b);
    expect(nodes.find((node) => node.orgId === w.a)).toMatchObject({ mark: null });
  });

  it('全部明细行都在组织范围外 → 详情不返回组织分区（sections = {}，§10 分区为空不返回）', async () => {
    const w = await itemsWorld(testDb().db, 'oa24r');
    const r = reader(w);
    const view = await w.created(w.head({ adjustmentRange: [w.a, w.b] }));
    await w.item(view.id, newOrg(w.b));
    await w.item(view.id, rename(w.b));
    w.access.org = only(w.a);

    expect((await r.items(view.id)).items).toEqual([]);
    expect((await r.detail(view.id)).sections).toEqual({});
  });
});

describe('AC-OA-24 原上级（版本链上一条）同样按组织范围复核', () => {
  it('目标在范围内、原上级在范围外 → 行可见，但原上级 ID 与名称都给 null，不带出范围外组织名', async () => {
    const w = await itemsWorld(testDb().db, 'oa24r');
    const r = reader(w);
    const view = await w.created(w.head({ adjustmentRange: [w.a] }));
    const renamed = await w.item(view.id, rename(w.a));
    const itemId = renamed.items.at(-1)!.id;
    const rootName = await orgName(w, w.tenant.id);
    w.access.org = only(w.a);

    const items = await r.items(view.id);
    expect(items.items.map((item) => item.id)).toEqual([itemId]);
    expect(items.items[0]).toMatchObject({ originalParentOrgId: null, originalParentOrgName: null });
    expect(JSON.stringify(items)).not.toContain(w.tenant.id);
    expect(JSON.stringify(items)).not.toContain(rootName);
  });
});
