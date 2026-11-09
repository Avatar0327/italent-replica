/**
 * F-474-2b #1（R1a §2.2；DEC-778②）：组织列表「在岗人数」与完整组织树。
 * - 在岗人数 = 主职、人员状态试用 / 正式、数据日期有效的任职人数，含下级（docs/02_业务建模/18 §11）；
 * - 按查看人的组织范围计数（范围外的人不计），不读继任统计缓存；
 * - 完整组织树由服务端按查看人范围组装：范围外节点不出现，列表与树的 total 同口径；
 * - 在岗人数是组织字段目录里的系统字段，撤销查看即被裁剪。
 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { AT, orgWorld, type OrgNodeDto, type OrgWorld } from './support/f474-org-world.js';

const database = useTestDb();
const QUERY = `asOf=${AT}&dimension=admin&includeDisabled=false&pageSize=200`;

async function listOf(get: (path: string) => Promise<Response>) {
  const response = await get(`organizations?${QUERY}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as { items: OrgNodeDto[]; total?: number };
}
const byName = (items: OrgNodeDto[], prefix: string) => items.find((item) => item.name?.startsWith(prefix));
function flatten(nodes: OrgNodeDto[]): OrgNodeDto[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

describe('AC-ORG-F474-2b 组织列表在岗人数与完整组织树', () => {
  let w: OrgWorld;
  beforeAll(async () => {
    w = await orgWorld(database().db);
  });

  it('2b-1a 在岗人数含下级，离职人员不计', async () => {
    const { items } = await listOf(w.full);
    expect(byName(items, '甲一组')?.headcount).toBe(2);
    expect(byName(items, '甲部')?.headcount).toBe(3);
    expect(byName(items, '乙部')?.headcount).toBe(1);
  });

  it('2b-1b 范围含下级：看得到的节点按范围内人员计数，范围外节点不出现', async () => {
    const viewer = await w.viewer('范围甲含下级', [{ orgId: w.a.id, includeDescendants: true }]);
    const { items, total } = await listOf(viewer.get);
    expect(items.map((item) => item.name?.replace(w.suffix, '')).sort()).toEqual(['甲一组', '甲部']);
    expect(byName(items, '甲部')?.headcount).toBe(3);
    expect(byName(items, '甲一组')?.headcount).toBe(2);
    expect(total).toBe(2);
  });

  it('2b-1c 范围只含上级本身：下级的人不计入上级人数（无计数侧信道）', async () => {
    const viewer = await w.viewer('范围甲仅本级', [{ orgId: w.a.id, includeDescendants: false }]);
    const { items, total } = await listOf(viewer.get);
    expect(items.map((item) => item.name?.replace(w.suffix, ''))).toEqual(['甲部']);
    expect(byName(items, '甲部')?.headcount).toBe(1);
    expect(total).toBe(1);
  });

  it('2b-1d 完整组织树：范围外上级缺席时可见下级挂到最近的可见祖先，缺祖先则成为根', async () => {
    const viewer = await w.viewer('范围甲一与乙', [
      { orgId: w.a1.id, includeDescendants: false },
      { orgId: w.b.id, includeDescendants: false },
    ]);
    const response = await viewer.get(`organizations/tree?${QUERY}`);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as { roots: OrgNodeDto[]; total: number };
    expect(body.roots.map((node) => node.name?.replace(w.suffix, '')).sort()).toEqual(['乙部', '甲一组']);
    expect(body.total).toBe(2);
    expect(flatten(body.roots).map((node) => node.headcount)).toEqual(expect.arrayContaining([1, 2]));
  });

  it('2b-1e 完整组织树按层级嵌套，合计与列表同口径', async () => {
    const viewer = await w.viewer('范围甲含下级树', [{ orgId: w.a.id, includeDescendants: true }]);
    const response = await viewer.get(`organizations/tree?${QUERY}`);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as { roots: OrgNodeDto[]; total: number };
    expect(body.roots).toHaveLength(1);
    expect(body.roots[0]).toMatchObject({ headcount: 3 });
    expect(body.roots[0]!.children).toHaveLength(1);
    expect(body.roots[0]!.children![0]).toMatchObject({ headcount: 2 });
    expect(body.total).toBe((await listOf(viewer.get)).total);
  });

  it('2b-1f 未配置组织范围时（fail-closed）列表与树都为空，不暴露人数', async () => {
    const viewer = await w.viewer('无范围', null);
    expect((await listOf(viewer.get)).items).toEqual([]);
    const tree = await viewer.get(`organizations/tree?${QUERY}`);
    expect(tree.status).toBe(200);
    expect(await tree.json()).toMatchObject({ roots: [], total: 0 });
  });

  it('2b-1g 在岗人数是字段权限控制的系统字段：撤销查看后列表与树都不返回', async () => {
    const viewer = await w.viewer('撤销人数', [{ orgId: w.a.id, includeDescendants: true }], ['headcount']);
    const { items } = await listOf(viewer.get);
    expect(items).toHaveLength(2);
    for (const item of items) expect(item).not.toHaveProperty('headcount');
    const tree = (await (await viewer.get(`organizations/tree?${QUERY}`)).json()) as { roots: OrgNodeDto[] };
    for (const node of flatten(tree.roots)) expect(node).not.toHaveProperty('headcount');
  });
});
