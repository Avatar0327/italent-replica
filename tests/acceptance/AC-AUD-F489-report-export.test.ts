/**
 * F-489（DEC-830③，F-482 #606 遗留）：统计报表导出日志要在审计页（操作日志）里查得到。
 * F-482 每次成功导出写一条 behavior=export 的对象操作日志（对象类型 = 报表所属的人事分析对象，对象编号 = 报表编码），
 * 但审计页对未登记查看规则的对象类型 fail-closed，行写进了 audit_operation_logs，页面却一条也查不到。
 * 本用例走真 HTTP：先在导出接口导出，再用审计接口（/api/tenant/audit/operation-logs）查；
 * 口径沿用审计页既有“需要归属的对象”规则（personRule + 执行人回退，visibility.ts 第四轮 N2）：
 * 看全部可见；非看全部只在“使用用户”维度下看到自己执行的导出；没有该报表对象的查看权 / 范围为空 / 别的租户一律看不到。
 * 失败的导出（F-482 AC-HA-F482-06/12/13 约定一条都不记）在审计页同样查不到。
 */
import { randomUUID } from 'node:crypto';
import { HR_MOVEMENT_REPORT_OBJECT, HR_STRUCTURE_REPORT_OBJECT } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { auditApi, type OperationLog } from './AC-AUD-support.js';
import { STRUCTURE_BASE, structureWorld, type StructureWorld, boardClient } from './AC-HA-13a-support.js';
import { MOVEMENT_BASE, movementClient, movementWorld, type MovementWorld } from './AC-HA-13b-support.js';
import { downloadXlsx, exportLogs, exportPath } from './AC-HA-F482-support.js';
import { restricted } from './AC-PT-http-support.js';
import { orgScope } from './support/revocable-rights.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const AT = '2026-10-06T02:00:00.000Z';
const MOVEMENT_QUERY = 'asOf=2026-10-06&year=2026';
const STRUCTURE_QUERY = 'asOf=2026-10-01';

describe('AC-AUD-F489 审计页显示统计报表导出日志', () => {
  let movement: MovementWorld;
  let structure: StructureWorld;
  let mover: ReturnType<typeof movementClient>;
  let boarder: ReturnType<typeof boardClient>;
  const movementAs = () => ({ tenant: movement.who.tenant, user: movement.who.user });
  const structureAs = () => ({ tenant: structure.who.tenant, user: structure.who.user });

  beforeAll(async () => {
    movement = await movementWorld(database().db);
    structure = await structureWorld(database().db, `f489-${uniqueSuffix()}`);
    mover = movementClient(movement.db, movement.who);
    boarder = boardClient(structure.db, structure.who);
  }, 600_000);

  /** 审计页：默认看全部，可给受限授权器。只取导出行为，对象类型过滤交给调用方。 */
  const page = (as: { tenant: string; user: string }, query: Record<string, string>, authorize = restricted({})) =>
    auditApi(database().db, AT, { authorize }).operationLogs(as, { behavior: 'export', ...query });
  const idsOf = (items: OperationLog[]) => items.map((item) => item.objectId).sort();

  const exportMovement = async (code: 'monthly' | 'institution', mode: 'data' | 'formula') =>
    downloadXlsx(
      mover.get,
      exportPath(MOVEMENT_BASE, code, MOVEMENT_QUERY, mode),
      `${code === 'monthly' ? '各月' : '各机构'}入离职统计.xlsx`,
    );
  const exportQuality = async (mode: 'data' | 'formula') =>
    downloadXlsx(boarder.get, exportPath(STRUCTURE_BASE, 'quality', STRUCTURE_QUERY, mode), '员工素质结构.xlsx');

  it('AC-AUD-F489-01：流动情况两张报表导出成功后，审计页（看全部）按对象类型 / 报表编码查得到，展示中文对象名与导出人', async () => {
    const before = await exportLogs(movement.db, movement.who.tenant, HR_MOVEMENT_REPORT_OBJECT);
    await exportMovement('monthly', 'data');
    await exportMovement('institution', 'formula');
    const written =
      (await exportLogs(movement.db, movement.who.tenant, HR_MOVEMENT_REPORT_OBJECT)).length - before.length;
    expect(written, '导出接口写了两条日志').toBe(2);

    const { items } = await page(movementAs(), { objectType: HR_MOVEMENT_REPORT_OBJECT });
    // 旧实现：对象类型未登记 → 审计页 fail-closed，上面的两行在 audit_operation_logs 里却返回 []
    expect(idsOf(items)).toEqual(['institution', 'monthly']);
    for (const item of items) {
      expect(item).toMatchObject({
        behavior: 'export',
        objectType: HR_MOVEMENT_REPORT_OBJECT,
        objectLabel: '流动情况报表',
        result: 'succeeded',
        totalCount: 1,
      });
      expect(item.operator.userId).toBe(movement.who.user);
      expect(item.summary).toContain('入离职统计');
    }
    // 不带对象类型过滤也在
    const all = await page(movementAs(), {});
    expect(idsOf(all.items.filter((item) => item.objectType === HR_MOVEMENT_REPORT_OBJECT))).toEqual([
      'institution',
      'monthly',
    ]);
    // 报表编码（对象编号）可筛
    expect(
      idsOf((await page(movementAs(), { objectType: HR_MOVEMENT_REPORT_OBJECT, objectId: 'monthly' })).items),
    ).toEqual(['monthly']);
  });

  it('AC-AUD-F489-02：员工素质结构报表导出成功后，审计页查得到（对象 = 员工结构报表）', async () => {
    await exportQuality('formula');
    expect((await exportLogs(structure.db, structure.who.tenant, HR_STRUCTURE_REPORT_OBJECT)).length).toBeGreaterThan(
      0,
    );

    const { items } = await page(structureAs(), { objectType: HR_STRUCTURE_REPORT_OBJECT });
    expect(idsOf(items)).toEqual(['quality']);
    expect(items[0]).toMatchObject({
      behavior: 'export',
      objectLabel: '员工结构报表',
      result: 'succeeded',
      summary: expect.stringContaining('员工素质结构'),
    });
    expect(items[0]!.operator.userId).toBe(structure.who.user);
  });

  it('AC-AUD-F489-03：失败的导出不写日志，审计页条数不变（下载方式缺失 / 非法、没有查看权）', async () => {
    await exportMovement('monthly', 'data');
    const settled = (await page(movementAs(), { objectType: HR_MOVEMENT_REPORT_OBJECT })).items.length;
    expect(settled, '成功的导出在审计页可见，下面才有对比意义').toBeGreaterThan(0);

    const bad: [string, number, typeof mover | undefined][] = [
      [`${MOVEMENT_BASE}/reports/monthly/export?${MOVEMENT_QUERY}`, 400],
      [exportPath(MOVEMENT_BASE, 'monthly', MOVEMENT_QUERY, 'pdf'), 400],
      [exportPath(MOVEMENT_BASE, 'unknown', MOVEMENT_QUERY, 'data'), 404],
      [
        exportPath(MOVEMENT_BASE, 'monthly', MOVEMENT_QUERY, 'data'),
        403,
        movementClient(
          movement.db,
          movement.who,
          restricted({ deny: (r) => r.action === 'object.view' && r.resource === HR_MOVEMENT_REPORT_OBJECT }),
        ),
      ],
    ];
    for (const [path, status, client] of bad) expect((await (client ?? mover).get(path)).status, path).toBe(status);
    expect((await page(movementAs(), { objectType: HR_MOVEMENT_REPORT_OBJECT })).items.length).toBe(settled);
  });

  it('AC-AUD-F489-04：没有该报表对象查看权的人、范围为空 / 非“使用用户”维度 / 别人的“使用用户”范围，都查不到', async () => {
    await exportMovement('institution', 'data');
    const own = (await page(movementAs(), { objectType: HR_MOVEMENT_REPORT_OBJECT })).items;
    expect(own.length, '看全部可见，下面的空才是裁剪的结果').toBeGreaterThan(0);

    const seen = async (authorize: ReturnType<typeof restricted>) =>
      (await page(movementAs(), { objectType: HR_MOVEMENT_REPORT_OBJECT }, authorize)).items;
    // 没有报表对象的查看权（只放行别的对象）
    expect(
      await seen(restricted({ deny: (r) => r.action === 'object.view' && r.resource === HR_MOVEMENT_REPORT_OBJECT })),
    ).toEqual([]);
    // 数据范围为空（fail-closed）、管理单元范围（没有人员 / 组织归属可比）
    expect(await seen(restricted({ scope: { ...EMPTY_SCOPE, hasDataPermission: true } }))).toEqual([]);
    expect(await seen(restricted({ scope: orgScope(movement.who.tenant, '2026-10-06', randomUUID()) }))).toEqual([]);
    // “使用用户”维度只认执行人：别人的范围看不到，自己的看得到（本人执行的导出对本人可见）
    const usingUser = (creatorId: string) => ({
      ...EMPTY_SCOPE,
      hasDataPermission: true,
      terms: [{ dimension: 'using_user' as const, orgIds: [], personIds: [], creatorId }],
    });
    expect(await seen(restricted({ scope: usingUser(randomUUID()) }))).toEqual([]);
    expect(idsOf(await seen(restricted({ scope: usingUser(movement.who.user) })))).toEqual(idsOf(own));
  });

  it('AC-AUD-F489-05：跨租户 fail-closed——别的租户的审计页看不到本租户的导出日志，也不能借租户头越权', async () => {
    await exportQuality('data');
    await exportMovement('monthly', 'data');
    expect((await page(movementAs(), { objectType: HR_MOVEMENT_REPORT_OBJECT })).items.length).toBeGreaterThan(0);
    expect((await page(structureAs(), { objectType: HR_STRUCTURE_REPORT_OBJECT })).items.length).toBeGreaterThan(0);

    // 结构租户的审计页：流动租户的导出一条都没有；反过来也一样
    expect((await page(structureAs(), { objectType: HR_MOVEMENT_REPORT_OBJECT })).items).toEqual([]);
    expect((await page(movementAs(), { objectType: HR_STRUCTURE_REPORT_OBJECT })).items).toEqual([]);
    // 用结构租户的账号带流动租户的租户头：拒绝，不是空页
    const api = tenantApi(database().db, { clock: () => new Date(AT), authorize: restricted({}) });
    const response = await api.request('GET', '/api/tenant/audit/operation-logs?behavior=export', {
      user: structure.who.user,
      tenant: movement.who.tenant,
    });
    expect([400, 401, 403, 404]).toContain(response.status);
  });
});
