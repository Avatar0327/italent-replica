/**
 * R2-T08 BE-10d：AC-OA-42（读）——预览只展示调整范围子树并叠加增减标记；列表显示“组织名（包含下级）”
 * （设计 §5.6、§6.2 预览行、§10；F273A §4）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { itemsWorld, newOrg, rename, stop } from './AC-OA-items-support.js';
import { flatten, orgName, type PreviewNode, reader } from './AC-OA-read-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const shape = (node: PreviewNode): unknown => ({
  id: node.orgId ?? node.itemId,
  mark: node.mark,
  children: node.children.map(shape),
});

describe('AC-OA-42 预览：调整范围子树 + 增减标记', () => {
  it('根为所选组织（按选择顺序）、含下级；范围外组织不出现；本单新增挂在新上级下', async () => {
    const w = await itemsWorld(testDb().db, 'oa42r');
    const r = reader(w);
    const c = await w.org(`丙${uniqueSuffix()}`, w.a);
    const d = await w.org(`丁${uniqueSuffix()}`, w.a);
    const view = await w.created(w.head({ adjustmentRange: [w.b, w.a] }));
    const parent = (await w.item(view.id, newOrg(w.a))).items.at(-1)!;
    const child = (await w.item(view.id, newOrg(w.a, { parent: { itemId: parent.id } }))).items.at(-1)!;
    await w.item(view.id, rename(c));
    await w.item(view.id, stop(d));

    const preview = await r.preview(view.id);
    expect(preview).toMatchObject({ adjustmentId: view.id, effectiveDate: '2026-11-01' });
    const sortKids = (node: unknown): unknown => {
      const n = node as { id: string; children: unknown[] };
      return {
        ...n,
        children: n.children
          .map(sortKids)
          .sort((x, y) => ((x as { id: string }).id < (y as { id: string }).id ? -1 : 1)),
      };
    };
    expect(preview.roots.map(shape).map(sortKids)).toEqual([
      { id: w.b, mark: null, children: [] },
      sortKids({
        id: w.a,
        mark: null,
        children: [
          { id: c, mark: 'changed', children: [] },
          { id: d, mark: 'deactivated', children: [] },
          { id: parent.id, mark: 'added', children: [{ id: child.id, mark: 'added', children: [] }] },
        ],
      }),
    ]);
    const ids = flatten(preview.roots).map((node) => node.orgId);
    expect(ids).not.toContain(w.subject);
    expect(ids).not.toContain(w.tenant.id);
    expect(flatten(preview.roots).find((node) => node.itemId === parent.id)).toMatchObject({
      name: parent.name,
      masked: [],
    });
  });

  it('变更行改上级 → 节点挂到新上级下；列表调整范围列为“组织名（包含下级）”', async () => {
    const w = await itemsWorld(testDb().db, 'oa42r');
    const r = reader(w);
    const c = await w.org(`丙${uniqueSuffix()}`, w.a);
    const view = await w.created(w.head({ adjustmentRange: [w.a, w.b] }));
    await w.item(view.id, rename(c, { name: undefined, parent: { orgId: w.b } }));
    const roots = (await r.preview(view.id)).roots;
    expect(roots.map(shape)).toEqual([
      { id: w.a, mark: null, children: [] },
      { id: w.b, mark: null, children: [{ id: c, mark: 'changed', children: [] }] },
    ]);
    const [row] = (await r.list()).items;
    const aName = await orgName(w, w.a);
    expect((row!.adjustmentRange as { label: string }[])[0]!.label).toBe(`${aName}（包含下级）`);
  });
});
