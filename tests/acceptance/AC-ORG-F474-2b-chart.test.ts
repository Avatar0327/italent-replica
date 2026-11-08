/**
 * F-474-2b #2（R1a §2.3；DEC-778②）：架构图卡片的负责人与「在岗 / 编制」。
 * - 卡片 = 组织名称 + 负责人姓名 + 在岗人数 + 编制，由服务端按查看人组织范围组装（范围外节点缺席）；
 * - 负责人姓名只给姓名，不带人员 ID 或其他人员字段；负责人在查看人范围外时仍显示姓名
 *   （与 main 现有口径一致：DEC-325③ 范围外上级、DEC-339② 范围外负责人只给姓名）；
 * - 负责人由组织字段「负责人」的查看权控制，编制、在岗人数各是组织字段目录里的系统字段，撤销即裁剪。
 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { AT, orgWorld, type OrgNodeDto, type OrgWorld } from './support/f474-org-world.js';

const database = useTestDb();
const QUERY = `asOf=${AT}&dimension=admin&includeDisabled=false`;
type Chart = { roots: OrgNodeDto[]; total: number };

async function chartOf(get: (path: string) => Promise<Response>) {
  const response = await get(`organizations/chart?${QUERY}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Chart;
}
const named = (nodes: OrgNodeDto[], prefix: string) => nodes.find((node) => node.name?.startsWith(prefix));

describe('AC-ORG-F474-2b 架构图卡片负责人与在岗 / 编制', () => {
  let w: OrgWorld;
  beforeAll(async () => {
    w = await orgWorld(database().db);
  });

  it('2b-2a 卡片带负责人姓名、在岗人数与编制，按层级嵌套', async () => {
    const { roots, total } = await chartOf(w.full);
    expect(total).toBe(3);
    const a = named(roots, '甲部')!;
    expect(a).toMatchObject({ headcount: 3, establishment: 10, personInChargeName: w.regular.name });
    expect(a.children).toHaveLength(1);
    // 甲一没有编制 → null（前端显示“--”，与调整预览同口径）；没有负责人 → null
    expect(a.children![0]).toMatchObject({ headcount: 2, establishment: null, personInChargeName: null });
    expect(named(roots, '乙部')).toMatchObject({ headcount: 1, establishment: 5, personInChargeName: null });
  });

  it('2b-2b 按查看人组织范围组装：范围外节点缺席，人数只含范围内人员', async () => {
    const viewer = await w.viewer('图范围甲', [{ orgId: w.a.id, includeDescendants: true }]);
    const { roots, total } = await chartOf(viewer.get);
    expect(total).toBe(2);
    expect(roots.map((node) => node.name?.replace(w.suffix, ''))).toEqual(['甲部']);
    expect(roots[0]).toMatchObject({ headcount: 3, establishment: 10 });
  });

  it('2b-2c 负责人在查看人范围外：只给姓名，不带人员 ID 或其他人员字段', async () => {
    // 负责人（甲一正式）任职甲一组，不在“仅甲部本级”范围内
    const viewer = await w.viewer('图范围仅甲', [{ orgId: w.a.id, includeDescendants: false }]);
    const { roots } = await chartOf(viewer.get);
    const card = named(roots, '甲部')!;
    expect(card.personInChargeName).toBe(w.regular.name);
    expect(card).not.toHaveProperty('personInChargeId');
    expect(Object.keys(card).sort()).toEqual(
      ['children', 'code', 'enabled', 'establishment', 'headcount', 'id', 'name', 'personInChargeName'].sort(),
    );
    expect(card.headcount).toBe(1);
  });

  it('2b-2d 撤销「负责人」查看权后不返回负责人姓名；撤销编制 / 在岗人数同理', async () => {
    const noHead = await w.viewer('图撤负责人', [{ orgId: w.a.id, includeDescendants: true }], ['personInChargeId']);
    const headCard = named((await chartOf(noHead.get)).roots, '甲部')!;
    expect(headCard).not.toHaveProperty('personInChargeName');
    expect(headCard).toMatchObject({ headcount: 3, establishment: 10 });

    const noNumbers = await w.viewer(
      '图撤数值',
      [{ orgId: w.a.id, includeDescendants: true }],
      ['establishment', 'headcount'],
    );
    const numberCard = named((await chartOf(noNumbers.get)).roots, '甲部')!;
    expect(numberCard).not.toHaveProperty('establishment');
    expect(numberCard).not.toHaveProperty('headcount');
    expect(numberCard.personInChargeName).toBe(w.regular.name);
  });

  it('2b-2e 未配置组织范围时（fail-closed）不出卡片，也不暴露编制与人数', async () => {
    const viewer = await w.viewer('图无范围', null);
    expect(await chartOf(viewer.get)).toMatchObject({ roots: [], total: 0 });
  });
});
