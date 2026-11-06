/**
 * F-411（BE-10d 预览未变更节点名称的字段遮罩，DEC-406；后补-权限，并入 F-087）：
 * 未变更节点的现名按“调整范围可见，或节点是一条可见明细的目标”披露（与明细 targetOrgName 同口径）：
 * ① 调整范围不可见且节点无可见明细 → 名称为 null 并记 masked；
 * ② 无 orgItems.name 查看权但范围可见 → 现名照常可见（不偏严）；
 * ③ 组织对象范围外的节点不出，名称不在响应里。
 * 基线（411be0fb0）已满足以上口径，本文件是回归，不改产品代码。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { only } from './AC-OA-head-support.js';
import { itemsWorld, rename } from './AC-OA-items-support.js';
import { flatten, orgName, reader } from './AC-OA-read-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();

/** 调整范围甲，甲下有未变更的下级；本单只改甲的名称。 */
async function previewWorld(label: string) {
  const w = await itemsWorld(testDb().db, label);
  const child = await w.org(`未变更下级${uniqueSuffix()}`, w.a);
  const view = await w.created(w.head({ adjustmentRange: [w.a] }));
  const written = await w.item(view.id, rename(w.a));
  return { w, r: reader(w), view, child, targetItemId: written.items.at(-1)!.id };
}

describe('F-411 未变更节点名称的遮罩口径', () => {
  it('正向对照：范围与 orgItems.name 都可见 → 未变更节点显示现名，不记 masked', async () => {
    const { w, r, view, child } = await previewWorld('f411-visible');
    const node = flatten((await r.preview(view.id)).roots).find((n) => n.orgId === child)!;
    expect(node).toMatchObject({ name: await orgName(w, child), mark: null });
    expect(node.masked).not.toContain('name');
  });

  it('① 看不到调整范围：未变更节点名称为 null 并记 masked，响应里没有它的现名；被可见明细指向的节点仍给现名', async () => {
    const { w, r, view, child, targetItemId } = await previewWorld('f411-range-hidden');
    const childName = await orgName(w, child);
    w.access.hiddenFields = new Set(['adjustmentRange']);
    const preview = await r.preview(view.id);
    const nodes = flatten(preview.roots);
    expect(nodes.find((n) => n.orgId === child)).toMatchObject({ name: null });
    expect(nodes.find((n) => n.orgId === child)!.masked).toContain('name');
    expect(JSON.stringify(preview)).not.toContain(childName);
    expect(nodes.find((n) => n.itemId === targetItemId)!.name).not.toBeNull();
  });

  it('② 无 orgItems.name 查看权但范围可见：未变更节点现名可见；明细 targetOrgName 同口径', async () => {
    const { w, r, view, child } = await previewWorld('f411-name-hidden');
    w.access.hiddenFields = new Set(['orgItems.name']);
    const nodes = flatten((await r.preview(view.id)).roots);
    expect(nodes.find((n) => n.orgId === child)).toMatchObject({ name: await orgName(w, child) });
    const target = nodes.find((n) => n.orgId === w.a)!;
    const [item] = (await r.items(view.id)).items;
    expect(target.name).toBe(item!.targetOrgName);
    // F-442：现名可见时 masked 记 newName（调整后名称未披露），name 只留给名称为 null 的节点
    expect(target.masked).toContain('newName');
    expect(target.masked).not.toContain('name');
  });

  it('③ 组织对象范围外的下级不出节点，名称不进响应', async () => {
    const { w, r, view, child } = await previewWorld('f411-scope');
    const childName = await orgName(w, child);
    w.access.org = only(w.a);
    const preview = await r.preview(view.id);
    expect(flatten(preview.roots).map((n) => n.orgId)).not.toContain(child);
    expect(JSON.stringify(preview)).not.toContain(childName);
  });
});
