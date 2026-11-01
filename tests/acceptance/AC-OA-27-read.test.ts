/**
 * R2-T08 BE-10d：AC-OA-27（读接口）——详情、明细、预览按 §4.5 同一可见集裁剪：
 * HR 按字段查看权；可打开审批实例的人按披露集（节点 formFields ∩ 可见集），不要求对象权限与范围。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { expectError } from './AC-OA-head-support.js';
import { itemsWorld, newOrg, rename } from './AC-OA-items-support.js';
import { approvalFixture, flatten, orgName, reader } from './AC-OA-read-support.js';

const testDb = useTestDb();

describe('AC-OA-27 HR 读接口按字段查看权裁剪（§4.5 第一行）', () => {
  it('看不到的头字段与明细字段在列表 / 详情 / 明细 / 预览都不出现；派生名称跟随源字段', async () => {
    const w = await itemsWorld(testDb().db, 'oa27r');
    const r = reader(w);
    const view = await w.created(w.head({ adjustmentRange: [w.a] }));
    const added = await w.item(view.id, newOrg(w.a));
    const renamed = await w.item(view.id, rename(w.a));
    const [addedId, renamedId] = [added.items.at(-1)!.id, renamed.items.at(-1)!.id];
    const secrets = [view.subject, added.items.at(-1)!.name!, renamed.items.at(-1)!.name!];
    w.access.hiddenFields = new Set(['subject', 'approvalSubjectOrgId', 'orgItems.name', 'orgItems.parentOrgId']);

    const [row] = (await r.list()).items;
    expect(row).not.toHaveProperty('subject');
    expect(row).not.toHaveProperty('approvalSubjectOrgId');
    expect(row).not.toHaveProperty('approvalSubjectOrgName');
    expect(row).toMatchObject({ id: view.id, code: view.code });

    const detail = await r.detail(view.id);
    expect(detail).not.toHaveProperty('subject');
    expect(detail).not.toHaveProperty('approvalSubjectOrgName');
    expect(detail).toMatchObject({ code: view.code, content: '调整说明', sections: { org: { count: 2 } } });

    const items = await r.items(view.id);
    for (const item of items.items) {
      expect(item).not.toHaveProperty('name');
      expect(item).not.toHaveProperty('parentOrgId');
      expect(item).not.toHaveProperty('parentOrgName');
    }
    expect(items.items.find((item) => item.id === renamedId)).toMatchObject({ targetOrgId: w.a });

    const nodes = flatten((await r.preview(view.id)).roots);
    const addedNode = nodes.find((node) => node.itemId === addedId);
    expect(addedNode).toMatchObject({ mark: 'added', name: null });
    expect(addedNode!.masked).toEqual(expect.arrayContaining(['name', 'parentOrgId']));
    // 看不到新名称时保留可见的现名（调整范围可见），masked 记 name 表示调整后名称未披露
    expect(nodes.find((node) => node.orgId === w.a)).toMatchObject({ mark: 'changed', name: await orgName(w, w.a) });
    expect(nodes.find((node) => node.orgId === w.a)!.masked).toContain('name');

    const text = JSON.stringify([row, detail, items, nodes]);
    for (const secret of secrets) expect(text).not.toContain(secret);
  });
});

describe('AC-OA-27 审批人读接口按披露集（§4.5 第二行）', () => {
  it('无对象权限、无范围的当前审批人可读；只给 formFields ∩ 可见集；非参与人 404', async () => {
    const w = await itemsWorld(testDb().db, 'oa27r');
    const r = reader(w);
    const approver = await w.member('合成审批人');
    const stranger = await w.member('合成旁人');
    const view = await w.created(w.head({ adjustmentRange: [w.a] }));
    const added = await w.item(view.id, newOrg(w.a, { shortName: '隐藏简称' }));
    const addedId = added.items.at(-1)!.id;
    const instanceId = await approvalFixture(w, view.id, approver, [
      'subject',
      'effectiveDate',
      'orgItems.adjustType',
      'orgItems.name',
      'orgItems.parentOrgId',
    ]);
    w.access.hiddenFields = new Set(['effectiveDate']);
    w.access.viewDenied = true;
    w.access.main = EMPTY_SCOPE;
    w.access.org = EMPTY_SCOPE;

    const detail = await r.detail(view.id, approver);
    expect(detail).toMatchObject({ id: view.id, subject: view.subject, approvalInstanceId: instanceId });
    for (const hidden of ['effectiveDate', 'content', 'code', 'approvalSubjectOrgId', 'adjustmentRange']) {
      expect(detail).not.toHaveProperty(hidden);
    }
    expect(detail.sections).toEqual({ org: { count: 1, hiddenRowCount: 0 } });

    const items = await r.items(view.id, approver);
    expect(items.items).toHaveLength(1);
    expect(items.items[0]).toMatchObject({ id: addedId, name: added.items.at(-1)!.name, parentOrgId: w.a });
    expect(items.items[0]).not.toHaveProperty('shortName');
    expect(JSON.stringify(items)).not.toContain('隐藏简称');

    const addedNode = flatten((await r.preview(view.id, approver)).roots).find((node) => node.itemId === addedId);
    expect(addedNode).toMatchObject({ mark: 'added', name: added.items.at(-1)!.name, masked: [] });

    await expectError(await r.listRes('', approver), 403, 'FORBIDDEN');
    for (const res of [
      await r.detailRes(view.id, stranger),
      await r.itemsRes(view.id, 'org', stranger),
      await r.previewRes(view.id, stranger),
    ]) {
      await expectError(res, 404, 'NOT_FOUND');
    }
  });

  it('节点没有勾组织分区字段 → 详情不返回该分区，明细 404', async () => {
    const w = await itemsWorld(testDb().db, 'oa27r');
    const r = reader(w);
    const approver = await w.member('合成审批人');
    const view = await w.created(w.head({ adjustmentRange: [w.a] }));
    await w.item(view.id, newOrg(w.a));
    await approvalFixture(w, view.id, approver, ['subject']);
    w.access.viewDenied = true;

    const detail = await r.detail(view.id, approver);
    expect(detail).toMatchObject({ subject: view.subject, sections: {} });
    await expectError(await r.itemsRes(view.id, 'org', approver), 404, 'NOT_FOUND');
  });
});
