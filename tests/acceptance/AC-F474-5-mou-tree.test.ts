/**
 * F-474-5 #24（R1bd §2.11，转03）：管理单元树由服务端组装完整层级，平面分页列表不能拼出完整树。
 * 树与平面列表同一可见集合（配置对象，持 mou_manage）；没有隐藏节点的计数；租户隔离；停用 / 已删除按筛选处理。
 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { addMember, BASE, type PermissionWorld, seedPermissionWorld } from './AC-PRM-support.js';
import { memberWithAdminRole } from './AC-PRM-users-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();

interface TreeNode {
  id: string;
  code: string;
  name: string;
  description: string;
  status: string;
  revision: number;
  parentId: string | null;
  matched: boolean;
  children: TreeNode[];
}
interface TreeBody {
  items: TreeNode[];
  total: number;
}

async function createMou(world: PermissionWorld, body: Record<string, unknown>) {
  const response = await world.api.request('POST', `${BASE}/mous`, { ...world.asAdmin, ifMatch: 0, body });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { id: string; code: string; revision: number };
}

const flat = (nodes: TreeNode[]): TreeNode[] => nodes.flatMap((node) => [node, ...flat(node.children)]);

describe('F-474-5 #24 管理单元树', () => {
  let world: PermissionWorld;
  const tag = uniqueSuffix();
  const ids: Record<string, string> = {};

  async function tree(query: Record<string, string> = {}, as = world.asAdmin) {
    const response = await world.api.request('GET', `${BASE}/mous/tree?${new URLSearchParams(query)}`, as);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as TreeBody;
  }

  beforeAll(async () => {
    world = await seedPermissionWorld(database().db);
    const make = async (key: string, body: Record<string, unknown>) => {
      const created = await createMou(world, { code: `${key}-${tag}`, name: `名-${key}`, orgRanges: [], ...body });
      ids[key] = created.id;
    };
    await make('root', { description: '根' });
    await make('childA', { parentId: ids.root });
    await make('grand', { parentId: ids.childA });
    await make('childB', { parentId: ids.root, status: 'disabled' });
    await make('lone', {});
    await make('gone', {});
    const removed = await world.api.request('DELETE', `${BASE}/mous/${ids.gone}`, { ...world.asAdmin, ifMatch: 1 });
    expect(removed.status, await removed.clone().text()).toBeLessThan(300);
  });

  it('返回完整层级：根 → 子 → 孙，默认只含启用，已删除永不出现', async () => {
    const body = await tree();
    const root = body.items.find((node) => node.id === ids.root)!;
    expect(root.children.map((node) => node.id)).toEqual([ids.childA]);
    expect(root.children[0]!.children.map((node) => node.id)).toEqual([ids.grand]);
    expect(body.items.map((node) => node.id)).toContain(ids.lone);
    const all = flat(body.items).map((node) => node.id);
    expect(all).not.toContain(ids.gone);
    expect(all).not.toContain(ids.childB);
    expect(body.total).toBe(all.length);
    expect(root).toMatchObject({ code: `root-${tag}`, name: '名-root', description: '根', status: 'active' });
  });

  it('status=all 含停用节点；status=disabled 只留停用节点及其祖先链', async () => {
    const everything = flat((await tree({ status: 'all' })).items).map((node) => node.id);
    expect(everything).toContain(ids.childB);
    const disabled = await tree({ status: 'disabled' });
    const nodes = flat(disabled.items);
    expect(nodes.filter((node) => node.matched).map((node) => node.id)).toEqual([ids.childB]);
    expect(nodes.map((node) => node.id)).toContain(ids.root);
  });

  it('按名称 / 编码筛选：命中节点连同祖先保留，兄弟节点不出现', async () => {
    const body = await tree({ q: `grand-${tag}` });
    const nodes = flat(body.items);
    expect(nodes.map((node) => node.id).sort()).toEqual([ids.root, ids.childA, ids.grand].sort());
    expect(nodes.filter((node) => node.matched).map((node) => node.id)).toEqual([ids.grand]);
    expect(body.total).toBe(3);
    expect((await tree({ q: '名-grand' })).items).toHaveLength(1);
  });

  it('平面分页列表仍可用，且与树口径一致', async () => {
    const response = await world.api.request('GET', `${BASE}/mous?limit=200`, world.asAdmin);
    expect(response.status).toBe(200);
    const items = ((await response.json()) as { items: { id: string }[] }).items.map((item) => item.id);
    expect(items).toEqual(expect.arrayContaining([ids.root, ids.childA, ids.grand, ids.childB, ids.lone]));
    expect(items).not.toContain(ids.gone);
  });

  it('参数不合法 → 400；没有管理单元查看能力 → 403', async () => {
    const bad = await world.api.request('GET', `${BASE}/mous/tree?status=bogus`, world.asAdmin);
    expect(bad.status).toBe(400);
    const plain = await addMember(world, 'f474-5-plain');
    const denied = await world.api.request('GET', `${BASE}/mous/tree`, { user: plain.id, tenant: world.tenant.id });
    expect(denied.status).toBe(403);
  });

  it('持 mou_manage 的权限管理员可看；另一租户的管理单元不会出现', async () => {
    const other = await seedPermissionWorld(world.db);
    const foreign = await createMou(other, { code: `foreign-${tag}`, name: '外租户', orgRanges: [] });
    const viewer = await memberWithAdminRole(world, 'permission_admin', 'f474-5-perm');
    const mine = flat((await tree({ status: 'all' }, viewer.as)).items).map((node) => node.id);
    expect(mine).toContain(ids.root);
    expect(mine).not.toContain(foreign.id);
  });
});
