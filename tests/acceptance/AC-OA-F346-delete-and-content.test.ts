import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { orgVersion } from './AC-APV-F318c-support.js';
import { expectError } from './AC-OA-head-support.js';
import { type ItemsWorld, itemsWorld, newOrg, reasons, rename } from './AC-OA-items-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();

const move = (targetOrgId: string, parentOrgId: string) => ({
  entry: 'detail.change',
  adjustType: 2,
  targetOrgId,
  parent: { orgId: parentOrgId },
  addEmployment: false,
});

/** 可信夹具：组织被外部改名（追加一条同开始日的新版本 + revision + 1，模拟直接改组织）。 */
async function renameExternally(w: ItemsWorld, orgId: string, name: string) {
  await orgVersion(w, orgId, { name });
  await w.touchOrg(orgId);
}

async function currentName(w: ItemsWorld, orgId: string): Promise<string> {
  return withTenant(w.db, w.tenant.id, async (tx) => {
    const [row] = resultRows<{ name: string }>(
      await tx.execute(sql`SELECT name FROM org_versions WHERE org_id = ${orgId} ORDER BY version_no DESC LIMIT 1`),
    );
    return row!.name;
  });
}

describe('F-346 ① 删除明细行也做调整前后组织树校验（与新增 / 修改行同口径）', () => {
  it('删除“把深层子树移到浅层”的改上级行，会让本单新增行落到第 11 层 → 400 LEVEL_EXCEEDED，行 / revision / 审计不变', async () => {
    const w = await itemsWorld(testDb().db, 'oaf346del');
    // a 第 1 层；链到第 8 层；t 原在第 9 层、t2 在第 10 层（原树合法）。
    let deepest = w.a;
    for (let level = 2; level <= 8; level++) deepest = await w.org(`链${level}-${uniqueSuffix()}`, deepest);
    const t = await w.org(`深层子树${uniqueSuffix()}`, deepest);
    const t2 = await w.org(`深层子树下${uniqueSuffix()}`, t);
    const view = await w.created();
    const moveItem = (await w.item(view.id, move(t, w.a))).items[0]!.id;
    // 移到 a 下后 t2 在第 3 层，新增行在 t2 下为第 4 层：保存时合法。
    const created = (await w.item(view.id, newOrg(t2))).items[0]!.id;
    const revision = (await w.stored(view.id))!.revision;
    const audits = await w.itemAudits(view.id);
    // 删掉改上级行，t 回到第 9 层，新增行到第 11 层。
    await expectError(await w.deleteItem(view.id, moveItem), 400, 'VALIDATION_FAILED', 'ORG_ADJUSTMENT_LEVEL_EXCEEDED');
    expect((await w.rows(view.id)).map((r) => r.id)).toEqual([moveItem, created]);
    expect((await w.stored(view.id))!.revision).toBe(revision);
    expect(await w.itemAudits(view.id)).toEqual(audits);
  });

  it('删除改上级行使本单另一改上级行成环 → 400 CYCLE；不引入新问题的删除照常', async () => {
    const w = await itemsWorld(testDb().db, 'oaf346del');
    const child = await w.org(`下级${uniqueSuffix()}`, w.a);
    const view = await w.created();
    const x = await w.org(`甲${uniqueSuffix()}`, w.a);
    const y = await w.org(`乙${uniqueSuffix()}`, x);
    // 行 1：y 移到 a 下（原在 x 下）；行 2：x 移到 y 下 —— 只有行 1 在时 y 已脱离 x，行 2 合法。
    const first = (await w.item(view.id, move(y, w.a))).items[0]!.id;
    await w.item(view.id, move(x, y));
    // 删行 1：y 回到 x 下，x 又移到 y 下 → 成环。
    await expectError(await w.deleteItem(view.id, first), 400, 'VALIDATION_FAILED', 'ORG_ADJUSTMENT_CYCLE');
    expect(await w.rows(view.id)).toHaveLength(2);
    // 不引入新问题：删掉没有被依赖的行照常。
    const free = (await w.item(view.id, rename(child))).items[0]!.id;
    expect((await w.deleteItem(view.id, free)).status).toBe(200);
  });
});

describe('F-346 ② 外部改名后整单校验与保存时同口径重判内容（改名 / 改上级须选是否新增任职）', () => {
  it('保存时是改名（选了“否”）→ 外部先改成同名并刷新基线 → 整单校验报内容问题，与保存时同一条规则', async () => {
    const w = await itemsWorld(testDb().db, 'oaf346name');
    const view = await w.created();
    const target = `新名${uniqueSuffix()}`;
    const itemId = (await w.item(view.id, rename(w.a, { name: target }))).items[0]!.id;
    expect(await w.checked(view.id)).toMatchObject({ valid: true });
    await renameExternally(w, w.a, target);
    expect(reasons(await w.checked(view.id))).toContain('ORG_ADJUSTMENT_BASELINE_CHANGED');
    expect((await w.rebaseAll(view.id)).status).toBe(200);
    const result = await w.checked(view.id);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({
        itemId,
        reason: 'ORG_ADJUSTMENT_ITEM_INVALID',
        message: '只有改名或改行政上级时才能选择是否新增任职',
      }),
    ]);
    // 保存时（改同一行）也是这条规则：把“是否新增任职”清掉后整单校验通过。
    const res = await w.patchItem(view.id, itemId, { addEmployment: null });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await w.checked(view.id)).toMatchObject({ valid: true });
  });

  it('保存时不是改名（名称等于现名、没选）→ 外部改名并刷新基线后变成改名 → 整单校验要求选择是否新增任职', async () => {
    const w = await itemsWorld(testDb().db, 'oaf346name');
    const view = await w.created();
    const same = await currentName(w, w.a);
    const body = { entry: 'detail.change', adjustType: 2, targetOrgId: w.a, name: same };
    const itemId = (await w.item(view.id, body)).items[0]!.id;
    expect(await w.checked(view.id)).toMatchObject({ valid: true });
    await renameExternally(w, w.a, `外部新名${uniqueSuffix()}`);
    expect((await w.rebaseAll(view.id)).status).toBe(200);
    const result = await w.checked(view.id);
    expect(result.errors).toEqual([
      expect.objectContaining({
        itemId,
        reason: 'ORG_ADJUSTMENT_ITEM_INVALID',
        message: '改名或改行政上级时必须选择是否新增任职',
      }),
    ]);
    // 提交 / 审批前的整单关口复用同一份判断：补选后通过。
    expect((await w.patchItem(view.id, itemId, { addEmployment: false })).status).toBe(200);
    expect(await w.checked(view.id)).toMatchObject({ valid: true });
  });
});
