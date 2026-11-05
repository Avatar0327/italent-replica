/**
 * R2-T08 F-442：预览节点的 `masked` 含 `name` 时，`name` 一律为 null（“名称未披露”只有一种含义）。
 * 变更行看不到新名称时节点仍显示可见的现名，此时改记 `newName`（调整后名称未披露），前端不得把它当成“名称被遮住”。
 * 范围外组织的整行隐去不受影响；新增行看不到名称时仍是 name = null + masked 含 `name`。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { itemsWorld, newOrg, rename } from './AC-OA-items-support.js';
import { flatten, orgName, reader } from './AC-OA-read-support.js';

const testDb = useTestDb();

describe('AC-OA-27 F-442 masked 含 name ⇒ name 为 null', () => {
  it('看不到新名称：变更行保留现名并记 newName；新增行 name 为 null 并记 name；任何节点不出现 name 非空且 masked 含 name', async () => {
    const w = await itemsWorld(testDb().db, 'oa27m');
    const view = await w.created(w.head({ adjustmentRange: [w.a] }));
    await w.item(view.id, newOrg(w.a));
    const renamed = (await w.item(view.id, rename(w.a))).items.at(-1)!;
    w.access.hiddenFields = new Set(['orgItems.name']);

    const nodes = flatten((await reader(w).preview(view.id)).roots);
    expect(nodes.length).toBeGreaterThanOrEqual(2);
    for (const node of nodes) if (node.masked.includes('name')) expect(node.name, node.key).toBeNull();

    const changed = nodes.find((node) => node.orgId === w.a)!;
    expect(changed).toMatchObject({ mark: 'changed', name: await orgName(w, w.a), itemId: renamed.id });
    expect(changed.masked).toContain('newName');
    expect(changed.masked).not.toContain('name');
    const added = nodes.find((node) => node.mark === 'added')!;
    expect(added).toMatchObject({ name: null });
    expect(added.masked).toContain('name');
  });

  it('看得到新名称：变更行 name 为新名称且 masked 不含 name / newName', async () => {
    const w = await itemsWorld(testDb().db, 'oa27m');
    const view = await w.created(w.head({ adjustmentRange: [w.a] }));
    const renamed = (await w.item(view.id, rename(w.a))).items.at(-1)!;

    const changed = flatten((await reader(w).preview(view.id)).roots).find((node) => node.orgId === w.a)!;
    expect(changed).toMatchObject({ name: renamed.name });
    expect(changed.masked).not.toContain('name');
    expect(changed.masked).not.toContain('newName');
  });
});
