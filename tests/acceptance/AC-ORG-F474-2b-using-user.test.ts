/**
 * F-474-2b 返工 P2-1：数据范围为「本人创建」（using_user）时，在岗人数不得算成 0。
 * 组织查询按「组织创建人」判定范围；在岗人数要对任职部门对应的组织做同一套判定（不是按员工创建人），
 * 所以可见组织的人数正确，其他组织（非本人创建）下的人员不计入。列表、完整树、架构卡片三个出口同口径。
 * 其他范围类型核对结论：组织列表只传「组织」与「创建人」两列，management / organization 只看组织，
 * reporting 因没有人员列在两处都是 false（本来就看不到组织），只有 using_user 在人数查询里少传了创建人列。
 */
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { AT, orgWorld, type OrgNodeDto, type OrgWorld } from './support/f474-org-world.js';

const database = useTestDb();
const QUERY = `asOf=${AT}&dimension=admin&includeDisabled=false`;
const ORG = MODULE_OBJECTS.organization.code;

function flatten(nodes: OrgNodeDto[]): OrgNodeDto[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}
const named = (nodes: OrgNodeDto[], prefix: string) => nodes.find((node) => node.name?.startsWith(prefix));

describe('AC-ORG-F474-2b-P2-1 using_user 范围下的在岗人数', () => {
  let w: OrgWorld;
  let get: (path: string) => Promise<Response>;
  beforeAll(async () => {
    w = await orgWorld(database().db);
    const viewer = await w.viewer('本人创建视角', null);
    get = viewer.get;
    const policy = await w.world.api.request(
      'PUT',
      `/api/tenant/permission/scope-policies/TenantBase/${ORG}/entity/${ORG}`,
      { ...w.world.asAdmin, ifMatch: 0, body: { rules: [{ dimension: 'using_user' }] } },
    );
    expect(policy.status, await policy.clone().text()).toBe(200);
    // 查看人自己建：丙部 ─ 丙一组；管理员另在丙部下建「丙二组」（非本人创建，范围外）
    const c = await w.org('丙部', w.world.tenant.id, {}, viewer.as);
    const c1 = await w.org('丙一组', c.id, {}, viewer.as);
    const c2 = await w.org('丙二组', c.id);
    await w.hire('丙一甲', c1.id);
    await w.hire('丙一乙', c1.id);
    await w.hire('丙二甲', c2.id);
  });

  it('列表：可见组织人数正确，非本人创建的组织不出现、其人员不计入', async () => {
    const response = await get(`organizations?${QUERY}&pageSize=200`);
    expect(response.status, await response.clone().text()).toBe(200);
    const { items, total } = (await response.json()) as { items: OrgNodeDto[]; total: number };
    expect(items.map((item) => item.name?.replace(w.suffix, '')).sort()).toEqual(['丙一组', '丙部']);
    expect(total).toBe(2);
    expect(named(items, '丙一组')?.headcount).toBe(2);
    expect(named(items, '丙部')?.headcount).toBe(2); // 丙二组的 1 人不是范围内组织的人，不计入
  });

  it('完整树：节点按本人创建裁剪，人数同列表', async () => {
    const response = await get(`organizations/tree?${QUERY}`);
    expect(response.status, await response.clone().text()).toBe(200);
    const { roots } = (await response.json()) as { roots: OrgNodeDto[] };
    expect(roots.map((root) => root.name?.replace(w.suffix, ''))).toEqual(['丙部']);
    const all = flatten(roots);
    expect(all).toHaveLength(2);
    expect(named(all, '丙部')?.headcount).toBe(2);
    expect(named(all, '丙一组')?.headcount).toBe(2);
  });

  it('架构卡片：人数同列表', async () => {
    const response = await get(`organizations/chart?${QUERY}`);
    expect(response.status, await response.clone().text()).toBe(200);
    const { roots } = (await response.json()) as { roots: OrgNodeDto[] };
    const all = flatten(roots);
    expect(all).toHaveLength(2);
    expect(named(all, '丙部')?.headcount).toBe(2);
    expect(named(all, '丙一组')?.headcount).toBe(2);
  });
});
