import { randomUUID } from 'node:crypto';
import { ORG_ITEM_ENTRY_BUTTONS, type OrgItemEntry } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { BASE, expectError } from './AC-OA-head-support.js';
import { itemsWorld, newOrg, reasons, rename, stop } from './AC-OA-items-support.js';

const testDb = useTestDb();

describe('AC-OA-38 暂存行（DEC-644 A-8）', () => {
  it('暂存行跳过业务校验；非暂存行引用暂存行 → 校验 STAGED_REFERENCE（列出行）', async () => {
    const w = await itemsWorld(testDb().db, 'oa38');
    await w.person('在职员工', w.a);
    const view = await w.created();
    await w.item(view.id, stop(w.a, { isStaged: true }));
    const staged = await w.item(view.id, newOrg(w.a, { isStaged: true }));
    expect((await w.rows(view.id)).every((r) => r.is_staged)).toBe(true);
    expect((await w.checked(view.id)).valid).toBe(true);
    const referencing = await w.item(view.id, newOrg(w.a, { parent: { itemId: staged.items[0]!.id } }));
    const result = await w.checked(view.id);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        section: 'org',
        itemId: referencing.items[0]!.id,
        reason: 'ORG_ADJUSTMENT_STAGED_REFERENCE',
      }),
    );
    expect(reasons(result)).not.toContain('ORG_SUBTREE_NOT_EMPTY');
  });
});

describe('AC-OA-43 路由 4～6、8～9 的按钮与入口（§9.3）', () => {
  const payload = (w: Awaited<ReturnType<typeof itemsWorld>>, entry: OrgItemEntry) => {
    const type = ORG_ITEM_ENTRY_BUTTONS[entry].adjustType;
    const body = type === 1 ? newOrg(w.a) : type === 2 ? rename(w.a) : stop(w.a);
    return entry === 'editor.drag'
      ? { entry, adjustType: 2, targetOrgId: w.a, parent: { orgId: w.b }, addEmployment: false }
      : { ...body, entry };
  };

  it('每个入口缺其按钮 → 403 不写；入口与类型不符 → 400', async () => {
    const w = await itemsWorld(testDb().db, 'oa43');
    const view = await w.created({ ...w.head(), adjustmentRange: [w.a, w.b] });
    for (const entry of Object.keys(ORG_ITEM_ENTRY_BUTTONS) as OrgItemEntry[]) {
      w.access.deniedButtons = new Set([ORG_ITEM_ENTRY_BUTTONS[entry].code]);
      await expectError(await w.addItem(view.id, payload(w, entry)), 403, 'FORBIDDEN');
      w.access.deniedButtons = new Set();
      const wrong = ORG_ITEM_ENTRY_BUTTONS[entry].adjustType === 1 ? 3 : 1;
      await expectError(
        await w.addItem(view.id, { ...payload(w, entry), adjustType: wrong }),
        400,
        'VALIDATION_FAILED',
      );
    }
    expect(await w.rows(view.id)).toEqual([]);
  });

  it('改行缺 EditOrgApprovalDetail、删行缺 DelteOrgApprovalDetail、刷新缺 EditAdjustOrgDetailBtn → 403；字段无编辑权 → 403', async () => {
    const w = await itemsWorld(testDb().db, 'oa43');
    const view = await w.created();
    const itemId = (await w.item(view.id, newOrg(w.a))).items[0]!.id;
    w.access.deniedButtons = new Set(['EditOrgApprovalDetail']);
    await expectError(await w.patchItem(view.id, itemId, { name: '改' }), 403, 'FORBIDDEN');
    w.access.deniedButtons = new Set(['DelteOrgApprovalDetail']);
    await expectError(await w.deleteItem(view.id, itemId), 403, 'FORBIDDEN');
    w.access.deniedButtons = new Set(['EditAdjustOrgDetailBtn']);
    await expectError(await w.rebaseAll(view.id), 403, 'FORBIDDEN');
    w.access.deniedButtons = new Set();
    w.access.deniedFields = new Set(['orgItems.shortName']);
    await expectError(await w.addItem(view.id, newOrg(w.a, { shortName: '简' })), 403, 'FORBIDDEN');
    await expectError(await w.patchItem(view.id, itemId, { shortName: '简' }), 403, 'FORBIDDEN');
    expect(await w.rows(view.id)).toHaveLength(1);
  });

  it('非草稿 / 非申请人 → 409 / 403；行不属于本单 → 404；明细路由与提交路由注册状态', async () => {
    const w = await itemsWorld(testDb().db, 'oa43');
    const view = await w.created();
    const other = await w.created();
    const itemId = (await w.item(view.id, newOrg(w.a))).items[0]!.id;
    await expectError(await w.patchItem(other.id, itemId, { name: '串单' }), 404, 'NOT_FOUND');
    const stranger = await w.member(`他人${randomUUID()}`);
    await expectError(await w.addItem(view.id, newOrg(w.a), undefined, stranger), 403, 'FORBIDDEN');
    await w.setStatus(view.id, 1);
    await expectError(await w.addItem(view.id, newOrg(w.a)), 409, 'CONFLICT');
    for (const path of ['submit', 'withdraw'])
      expect((await w.call('POST', `${BASE}/${view.id}/${path}`, { ifMatch: 2, body: {} })).status, path).toBe(404);
  });
});

describe('AC-OA-47 拖拽生成改上级明细（DEC-659②）', () => {
  it('拖拽只改上级、必填是否新增任职；带其它字段 → 400；已有本组织明细则更新该行（200）', async () => {
    const w = await itemsWorld(testDb().db, 'oa47');
    const view = await w.created({ ...w.head(), adjustmentRange: [w.a, w.b] });
    const drag = { entry: 'editor.drag', adjustType: 2, targetOrgId: w.a, parent: { orgId: w.b } };
    await expectError(await w.addItem(view.id, drag), 400, 'VALIDATION_FAILED');
    await expectError(
      await w.addItem(view.id, { ...drag, addEmployment: false, name: '拖拽不许改名' }),
      400,
      'VALIDATION_FAILED',
    );
    const created = await w.item(view.id, { ...drag, addEmployment: true });
    expect(created.items[0]).toMatchObject({ adjustType: 2, targetOrgId: w.a, parentOrgId: w.b, name: null });
    const child = await w.org(`下级${randomUUID()}`, w.b);
    const again = await w.addItem(view.id, { ...drag, parent: { orgId: child }, addEmployment: false });
    expect(again.status, await again.clone().text()).toBe(200);
    const rows = await w.rows(view.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: created.items[0]!.id, parent_org_id: child });
    expect(await w.itemAudits(view.id)).toEqual(['org-adjustment.item.create', 'org-adjustment.item.update']);
  });

  it('拖到自己下级（成环）/ 范围外 → 400；缺 DragToGenerateOrgApprovalDetails → 403', async () => {
    const w = await itemsWorld(testDb().db, 'oa47');
    const child = await w.org(`下级${randomUUID()}`, w.a);
    const view = await w.created();
    const drag = (parentOrgId: string) => ({
      entry: 'editor.drag',
      adjustType: 2,
      targetOrgId: w.a,
      parent: { orgId: parentOrgId },
      addEmployment: false,
    });
    await expectError(await w.addItem(view.id, drag(child)), 400, 'VALIDATION_FAILED', 'ORG_ADJUSTMENT_CYCLE');
    await expectError(await w.addItem(view.id, drag(w.b)), 400, 'VALIDATION_FAILED', 'ORG_ADJUSTMENT_OUT_OF_RANGE');
    w.access.deniedButtons = new Set(['DragToGenerateOrgApprovalDetails']);
    await expectError(await w.addItem(view.id, drag(w.subject)), 403, 'FORBIDDEN');
    expect(await w.rows(view.id)).toEqual([]);
  });
});
