/**
 * R2-T08 BE-10d：AC-OA-42（读）——预览只展示调整范围子树并叠加增减标记；列表显示“组织名（包含下级）”
 * （设计 §5.6、§6.2 预览行、§10；F273A §4）。
 */
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { type ItemsWorld, itemsWorld, newOrg, rename, stop } from './AC-OA-items-support.js';
import { insertPartTimeRecord } from './AC-PT-support.js';
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

describe('AC-OA-42 暂存行不执行：不进预览，但计入明细与分区行数', () => {
  it('暂存的新建 / 改名不出节点、不改名；明细返回该行，详情分区计数含暂存行', async () => {
    const w = await itemsWorld(testDb().db, 'oa42r');
    const r = reader(w);
    const view = await w.created(w.head({ adjustmentRange: [w.a] }));
    const staged = (await w.item(view.id, newOrg(w.a, { isStaged: true }))).items.at(-1)!;
    const stagedRename = (await w.item(view.id, rename(w.a, { isStaged: true }))).items.at(-1)!;
    const kept = (await w.item(view.id, newOrg(w.a))).items.at(-1)!;

    const nodes = flatten((await r.preview(view.id)).roots);
    expect(nodes.map((node) => node.itemId).filter(Boolean)).toEqual([kept.id]);
    expect(nodes.find((node) => node.orgId === w.a)).toMatchObject({ mark: null, name: await orgName(w, w.a) });
    expect(JSON.stringify(nodes)).not.toContain(staged.name!);
    expect(JSON.stringify(nodes)).not.toContain(stagedRename.name!);

    expect((await r.items(view.id)).items.map((item) => item.id)).toEqual([staged.id, stagedRename.id, kept.id]);
    expect((await r.detail(view.id)).sections).toEqual({ org: { count: 3, hiddenRowCount: 0 } });
  });
});

/** 在 parent 下建一个带行政顺序号的组织（组织模块写入口，与界面同路径）。 */
async function orgWithSequence(w: ItemsWorld, name: string, parentId: string, sequence: number) {
  const created = await w.json<{ id: string }>(
    await w.request(w.hr.id, 'POST', '/api/tenant/org/organizations', {
      ifMatch: 0,
      body: { name, establishedOn: '2020-01-01', parents: { admin: { parentId, sequence } } },
    }),
    201,
  );
  return created.id;
}

describe('AC-OA-42 预览节点带在岗 / 兼岗原值（§6.2:475；口径同组织停用校验）', () => {
  it('HR 读预览：既有节点给直属在岗与兼岗原值，0 也返回；本单新增节点为 0', async () => {
    const w = await itemsWorld(testDb().db, 'oa42r');
    const r = reader(w);
    const c = await w.org(`丙${uniqueSuffix()}`, w.a);
    const d = await w.org(`丁${uniqueSuffix()}`, w.a);
    await w.person('甲在岗', w.a);
    await w.person('丙在岗一', c);
    const cStaff = await w.person('丙在岗二', c);
    const other = await w.person('乙在岗', w.b);
    await withTenant(w.db, w.tenant.id, async (tx) => {
      await insertPartTimeRecord(tx, {
        tenantId: w.tenant.id,
        employeeId: other.employeeId,
        departmentId: c,
        startDate: '2026-09-01',
        endDate: null,
      });
      // 生效日前已结束的兼职不计（同 countDepartmentPartTimes）
      await insertPartTimeRecord(tx, {
        tenantId: w.tenant.id,
        employeeId: cStaff.employeeId,
        departmentId: d,
        startDate: '2026-09-01',
        endDate: '2026-10-31',
      });
    });
    const view = await w.created(w.head({ adjustmentRange: [w.a] }));
    const added = (await w.item(view.id, newOrg(w.a))).items.at(-1)!;

    const nodes = flatten((await r.preview(view.id)).roots);
    const counts = (id: string) => {
      const n = nodes.find((node) => node.orgId === id || node.itemId === id)!;
      return { onDutyCount: n.onDutyCount, partTimeCount: n.partTimeCount };
    };
    expect(counts(w.a)).toEqual({ onDutyCount: 1, partTimeCount: 0 });
    expect(counts(c)).toEqual({ onDutyCount: 2, partTimeCount: 1 });
    expect(counts(d)).toEqual({ onDutyCount: 0, partTimeCount: 0 });
    expect(counts(added.id)).toEqual({ onDutyCount: 0, partTimeCount: 0 });
  });

  it('HR 看不到调整范围：未被可见明细指向的既有节点名称与人数都给 null 并记入 masked', async () => {
    const w = await itemsWorld(testDb().db, 'oa42r');
    const r = reader(w);
    const c = await w.org(`丙${uniqueSuffix()}`, w.a);
    await w.person('丙在岗', c);
    const view = await w.created(w.head({ adjustmentRange: [w.a] }));
    await w.item(view.id, rename(c));
    w.access.hiddenFields = new Set(['adjustmentRange']);

    const nodes = flatten((await r.preview(view.id)).roots);
    const a = nodes.find((node) => node.orgId === w.a)!;
    expect(a).toMatchObject({ name: null, onDutyCount: null, partTimeCount: null });
    expect(a.masked).toEqual(expect.arrayContaining(['name', 'onDutyCount', 'partTimeCount']));
    // 明细目标本身可见（targetOrgId 披露）：人数按同口径给出
    expect(nodes.find((node) => node.orgId === c)).toMatchObject({ onDutyCount: 1, partTimeCount: 0 });
    expect(JSON.stringify(a)).not.toContain(await orgName(w, w.a));
  });
});

describe('AC-OA-42 预览同级按行政顺序号排序（明细指定值优先，其次组织现值；新增与变更同一规则）', () => {
  it('同一上级下新增顺序号 100、-100 两个节点 → [-100, 100]', async () => {
    const w = await itemsWorld(testDb().db, 'oa42r');
    const r = reader(w);
    const view = await w.created(w.head({ adjustmentRange: [w.b] }));
    const plus = (await w.item(view.id, newOrg(w.b, { displayOrder: 100 }))).items.at(-1)!;
    const minus = (await w.item(view.id, newOrg(w.b, { displayOrder: -100 }))).items.at(-1)!;
    const kids = (await r.preview(view.id)).roots[0]!.children.map((n) => n.itemId);
    expect(kids).toEqual([minus.id, plus.id]);
  });

  it('既有组织按现顺序号排（不按名称）；变更行改顺序号后按新值排，与新增节点同一规则', async () => {
    const w = await itemsWorld(testDb().db, 'oa42r');
    const r = reader(w);
    // 名称与顺序号反着排，名称排序不能碰巧通过
    const x = await orgWithSequence(w, `A${uniqueSuffix()}`, w.a, 30);
    const y = await orgWithSequence(w, `Z${uniqueSuffix()}`, w.a, 10);
    const z = await orgWithSequence(w, `M${uniqueSuffix()}`, w.a, 20);
    const view = await w.created(w.head({ adjustmentRange: [w.a] }));
    const kids = async () => (await r.preview(view.id)).roots[0]!.children.map((n) => n.orgId ?? n.itemId);
    expect(await kids()).toEqual([y, z, x]);

    const plus = (await w.item(view.id, newOrg(w.a, { displayOrder: 25 }))).items.at(-1)!;
    await w.item(view.id, { entry: 'detail.change', adjustType: 2, targetOrgId: x, displayOrder: 5 });
    expect(await kids()).toEqual([x, y, z, plus.id]);
  });
});
