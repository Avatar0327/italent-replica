/**
 * BE-13a / AC-HA-13a-10 + AC-HA-05（DEC-763②，F-466 改写口径）：三个只读授权对象（人员结构分析 / 员工结构报表 / 合同情况）与数据范围。
 * - 没有对象“查看”→ 403（看板、明细、报表都拦）；
 * - 员工结构报表（B53）：人事管理员按管理单元取数——只统计范围内人员，数字 = 明细；
 * - 人员结构分析（B49）/ 合同情况（B55）是看板类（B55 与 B49～B51 共用看板外壳，DEC-768）：只给 HR 专员 / HR 经理 / 管理员，
 *   人事管理员没有人事看板；
 *   这里只验有权看的身份“按其数据范围统计、数字 = 明细”；
 * - 空范围（默认）全为 0、hasDataPermission = false，不退回“全部”；
 * - 预置授权（F-472 已对齐）：看板类对象给 HR 专员 / HR 经理 / 管理员并预置看全部，人事管理员没有，见最后一条。
 */
import {
  CONTRACT_BOARD_OBJECT,
  HR_STRUCTURE_OBJECT,
  HR_STRUCTURE_REPORT_OBJECT,
  presetSeeAllTargets,
  STANDARD_PROFILES,
} from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import {
  boardClient,
  CONTRACT_BOARD_BASE,
  contractKit,
  ids,
  managementScope,
  restrictedAuthorizer,
  STRUCTURE_BASE,
  structureWorld,
} from './AC-HA-13a-support.js';

const database = useTestDb();
const AS_OF = 'asOf=2026-10-01';

async function buildWorld() {
  const w = await structureWorld(database().db, 'ha13a-access');
  const k = await contractKit(w);
  const inside = await w.org('范围内部门');
  const outside = await w.org('范围外部门');
  const company = await k.master('companies', '合成法人');
  const type = await k.master('types', '劳动合同');
  const hire = (name: string, department: { id: string }) => w.hire(name, { date: '2020-01-01', department });
  const p = {
    in1: await hire('范围内甲', inside),
    in2: await hire('范围内乙', inside),
    out: await hire('范围外', outside),
  };
  const contract = (employeeId: string) =>
    k.command({
      operation: 'create',
      employeeId,
      fields: {
        typeId: type.id,
        companyId: company.id,
        effectiveDate: '2026-01-01',
        endDate: '2026-10-15',
        termType: 'fixed',
        signingDate: '2026-01-01',
      },
    });
  const contracts = { in1: await contract(p.in1.id), out: await contract(p.out.id) };
  return { w, k, inside, outside, company, p, contracts };
}
type World = Awaited<ReturnType<typeof buildWorld>>;

describe('AC-HA-13a 授权与数据范围', () => {
  let x: World;
  beforeAll(async () => {
    x = await buildWorld();
  }, 300_000);

  it('AC-HA-13a-10：没有对象“查看”授权项 → 403（看板、明细、报表都拦）；各对象互不放行', async () => {
    const paths: [string, string[]][] = [
      [HR_STRUCTURE_OBJECT, [`${STRUCTURE_BASE}?${AS_OF}`, `${STRUCTURE_BASE}/components/6.01?${AS_OF}`]],
      [
        HR_STRUCTURE_REPORT_OBJECT,
        [`${STRUCTURE_BASE}/reports/quality?${AS_OF}`, `${STRUCTURE_BASE}/reports/position`],
      ],
      [CONTRACT_BOARD_OBJECT, [`${CONTRACT_BOARD_BASE}?${AS_OF}`, `${CONTRACT_BOARD_BASE}/components/3.1.17`]],
    ];
    for (const [object, denied] of paths) {
      const c = boardClient(x.w.db, x.w.who, restrictedAuthorizer({ deny: object }));
      for (const path of denied) expect((await c.get(path)).status, `${object} ${path}`).toBe(403);
      // 其它两个对象不受影响
      for (const [other, allowed] of paths)
        if (other !== object) expect((await c.get(allowed[0]!)).status, `${object} → ${other}`).toBe(200);
    }
  });

  it('AC-HA-05：人事管理员按管理单元看员工结构报表——只统计范围内人员，范围外不出现，数字 = 明细', async () => {
    const c = boardClient(
      x.w.db,
      x.w.who,
      restrictedAuthorizer({ scope: managementScope(x.w.tenantId, [x.inside.id]) }),
    );
    const report = await c.report('position', AS_OF);
    expect(report.hasDataPermission).toBe(true);
    expect(report.rows.map((row) => row.organizationId)).toEqual([x.inside.id]);
    expect(report.summary.cells).toMatchObject({ total: 2 });

    // 同一批数据，全范围看到范围外的组织
    const admin = boardClient(x.w.db, x.w.who);
    expect((await admin.report('position', AS_OF)).rows.map((row) => row.organizationId)).toContain(x.outside.id);
  });

  it('AC-HA-05：看板类（人员结构分析 B49、合同情况 B55，DEC-768）按调用者的数据范围统计，数字 = 明细；谁有看板由授权决定，不由管理单元', async () => {
    // 管理单元范围在这里只是“一份受限数据范围”的夹具：看板只给 HR 专员 / HR 经理 / 管理员，人事管理员没有（DEC-763②）
    const c = boardClient(
      x.w.db,
      x.w.who,
      restrictedAuthorizer({ scope: managementScope(x.w.tenantId, [x.inside.id]) }),
    );
    expect((await c.board(STRUCTURE_BASE, AS_OF)).hasDataPermission).toBe(true);
    await c.expectCount(STRUCTURE_BASE, '6.01', ids(x.p.in1, x.p.in2), AS_OF);
    await c.expectCount(STRUCTURE_BASE, '6.08', ids(x.p.in1, x.p.in2), AS_OF, '5to10y');
    await c.expectCount(CONTRACT_BOARD_BASE, 'signByCompany', [x.contracts.in1.id], AS_OF, x.company.id);
    await c.expectCount(CONTRACT_BOARD_BASE, 'changeCreate', await x.k.requestIds(x.p.in1.id, 'create'), AS_OF);
    await c.expectCount(CONTRACT_BOARD_BASE, '3.1.17', [x.contracts.in1.id], AS_OF);

    // 同一批数据，全范围看到范围外的人
    const admin = boardClient(x.w.db, x.w.who);
    await admin.expectCount(STRUCTURE_BASE, '6.01', ids(x.p.in1, x.p.in2, x.p.out), AS_OF);
    await admin.expectCount(CONTRACT_BOARD_BASE, '3.1.17', [x.contracts.in1.id, x.contracts.out.id], AS_OF);
  });

  it('AC-HA-05：空范围（默认）fail-closed——报表与看板全为 0，hasDataPermission = false，不退回“全部”', async () => {
    const c = boardClient(x.w.db, x.w.who, restrictedAuthorizer({ scope: { ...EMPTY_SCOPE } }));
    const board = await c.board(STRUCTURE_BASE, AS_OF);
    expect(board.hasDataPermission).toBe(false);
    await c.expectCount(STRUCTURE_BASE, '6.01', [], AS_OF);
    expect(board.components.find((item) => item.code === '6.02')!.value).toBeNull();
    const report = await c.report('quality', AS_OF);
    expect({ rows: report.rows, permission: report.hasDataPermission }).toEqual({ rows: [], permission: false });
    const contract = await c.board(CONTRACT_BOARD_BASE, AS_OF);
    expect(contract.hasDataPermission).toBe(false);
    for (const code of ['changeCreate', '3.1.17']) await c.expectCount(CONTRACT_BOARD_BASE, code, [], AS_OF);
  });

  // 预置授权（F-472，DEC-767 / DEC-768 / DEC-763②）：看板类对象（人员结构分析、合同情况）只给 HR 专员 / HR 经理 / 管理员并预置看全部；
  // 人事管理员没有这两个对象，也没有看全部；员工结构报表（B53）人事管理员仍可查看，但按管理单元取数，不预置看全部。
  // 人事管理员调看板接口 403 的真实授权器用例见 AC-HA-05-board-grants.test.ts。
  it('AC-HA-13a-10：预置授权——看板类对象给 HR 专员 / HR 经理 / 管理员并看全部；人事管理员只留员工结构报表且按管理单元取数', () => {
    const profile = (code: string) => STANDARD_PROFILES.find((item) => item.code === code)!;
    const seeAll = (code: string) => presetSeeAllTargets(profile(code)).map((target) => target.targetCode);
    const held = (code: string) => profile(code).objects.map((item) => item.objectCode);
    for (const object of [HR_STRUCTURE_OBJECT, CONTRACT_BOARD_OBJECT]) {
      for (const code of [
        'standard_org_system_admin',
        'standard_hr_dashboard_specialist',
        'standard_hr_dashboard_manager',
      ]) {
        expect(held(code), `${code} ${object}`).toContain(object);
        expect(seeAll(code), `${code} 看全部 ${object}`).toContain(object);
      }
      expect(held('standard_hr_admin'), `hr_admin ${object}`).not.toContain(object);
      expect(seeAll('standard_hr_admin'), `hr_admin 看全部 ${object}`).not.toContain(object);
      expect(seeAll('standard_hr_specialist')).not.toContain(object);
    }
    expect(held('standard_hr_admin')).toContain(HR_STRUCTURE_REPORT_OBJECT);
    expect(seeAll('standard_hr_admin')).not.toContain(HR_STRUCTURE_REPORT_OBJECT);
    expect(held('standard_hr_specialist')).toContain(HR_STRUCTURE_REPORT_OBJECT);
    expect(seeAll('standard_org_system_admin')).toContain(HR_STRUCTURE_REPORT_OBJECT);
  });
});
