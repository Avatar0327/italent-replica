/**
 * F-509（DEC-853 / DEC-855 口径 A，F-489 #636 后补）：统计报表导出日志的可见范围。
 * 有「日志审计」能力、又有该报表 object.view 的人，看全部人的导出记录——不再按报表数据范围或“本人导出”过滤；
 * 没有该报表 object.view 的仍查不到；没有日志审计能力的人进不了审计页（既有入口门禁 admin.audit_log，本改动不动）；
 * 失败导出照旧不写审计（DEC-846①）；跨租户仍 fail-closed；仍不带导出附件（F-489 AC-06 口径）。
 *
 * 单独成文件（而不是塞进 F489 文件）：F-489 的用例保留“导出日志能在审计页查到”的基本口径，
 * 本文件只表达 F-509 新增的“他人导出可见”口径，AC 编号分开，便于按任务追溯；两处共用同一夹具。
 * 期望值全部手写：查看人是另建的、没有导出过任何东西的租户成员（审计员），导出人是夹具用户。
 */
import { randomUUID } from 'node:crypto';
import { createUser, grantMembership } from '@italent/db';
import { HR_MOVEMENT_REPORT_OBJECT, HR_STRUCTURE_REPORT_OBJECT } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { auditApi } from './AC-AUD-support.js';
import { STRUCTURE_BASE, structureWorld, type StructureWorld, boardClient } from './AC-HA-13a-support.js';
import { MOVEMENT_BASE, movementClient, movementWorld, type MovementWorld } from './AC-HA-13b-support.js';
import { downloadXlsx, exportLogs, exportPath } from './AC-HA-F482-support.js';
import { restricted } from './AC-PT-http-support.js';
import { orgScope } from './support/revocable-rights.js';
import { cmd } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const AT = '2026-10-06T02:00:00.000Z';
const MOVEMENT_QUERY = 'asOf=2026-10-06&year=2026';
const STRUCTURE_QUERY = 'asOf=2026-10-01';

type Authorizer = ReturnType<typeof restricted>;
type Viewer = { tenant: string; user: string };

/** “使用用户”维度、创建人是别人的范围：基线实现下只能看到 creatorId 自己执行的导出。 */
const usingUser = (creatorId: string) => ({
  ...EMPTY_SCOPE,
  hasDataPermission: true,
  terms: [{ dimension: 'using_user' as const, orgIds: [], personIds: [], creatorId }],
});

describe('AC-AUD-F509 统计报表导出日志：有日志审计能力且有报表查看权者看全部人的导出', () => {
  let movement: MovementWorld;
  let structure: StructureWorld;
  let movementAuditor: Viewer;
  let structureAuditor: Viewer;

  /** 另建一名租户成员当审计员：与导出人不是同一个人。 */
  const member = async (tenant: string, label: string): Promise<Viewer> => {
    const user = await createUser(
      database().db,
      { email: `${label}-${uniqueSuffix()}@example.com`, displayName: label },
      cmd(),
    );
    await grantMembership(database().db, { tenantId: tenant, userId: user.id, expectedRevision: 0 }, cmd());
    return { tenant, user: user.id };
  };

  beforeAll(async () => {
    movement = await movementWorld(database().db);
    structure = await structureWorld(database().db, `f509-${uniqueSuffix()}`);
    movementAuditor = await member(movement.who.tenant, '流动审计员');
    structureAuditor = await member(structure.who.tenant, '结构审计员');
    expect(movementAuditor.user).not.toBe(movement.who.user);
    expect(structureAuditor.user).not.toBe(structure.who.user);
  }, 600_000);

  const audit = (authorize: Authorizer) => auditApi(database().db, AT, { authorize });
  const logs = (as: Viewer, query: Record<string, string>, authorize: Authorizer = restricted({})) =>
    audit(authorize).operationLogs(as, { behavior: 'export', ...query });
  /** 报表编码去重排序：同一张报表各用例可能导出多次，只关心哪些报表可见。 */
  const reportCodes = (items: { objectId: string | null }[]) => [...new Set(items.map((item) => item.objectId))].sort();
  const codes = async (as: Viewer, objectType: string, authorize: Authorizer) =>
    reportCodes((await logs(as, { objectType }, authorize)).items);

  const exportMovement = (code: 'monthly' | 'institution', mode: 'data' | 'formula') =>
    downloadXlsx(
      movementClient(movement.db, movement.who).get,
      exportPath(MOVEMENT_BASE, code, MOVEMENT_QUERY, mode),
      `${code === 'monthly' ? '各月' : '各机构'}入离职统计.xlsx`,
    );
  const exportQuality = () =>
    downloadXlsx(
      boardClient(structure.db, structure.who).get,
      exportPath(STRUCTURE_BASE, 'quality', STRUCTURE_QUERY, 'data'),
      '员工素质结构.xlsx',
    );

  const canView = (object: string) => (r: { action: string; resource?: unknown }) =>
    r.action === 'object.view' && r.resource === object;
  const scopes = (tenant: string): [string, Parameters<typeof restricted>[0]][] => [
    ['范围为空（fail-closed）', { scope: { ...EMPTY_SCOPE, hasDataPermission: true } }],
    ['管理单元范围（没有人员 / 组织归属可比）', { scope: orgScope(tenant, '2026-10-06', randomUUID()) }],
    ['别人的“使用用户”范围', { scope: usingUser(randomUUID()) }],
  ];

  it('AC-AUD-F509-01：流动情况报表——审计员（有日志审计 + 报表查看权）在任何数据范围下都查到别人执行的导出', async () => {
    await exportMovement('monthly', 'data');
    await exportMovement('institution', 'formula');
    expect(
      (await exportLogs(movement.db, movement.who.tenant, HR_MOVEMENT_REPORT_OBJECT)).length,
      '导出人确实写了日志',
    ).toBeGreaterThanOrEqual(2);

    for (const [label, restriction] of [['看全部', {}], ...scopes(movement.who.tenant)] as const) {
      const items = (await logs(movementAuditor, { objectType: HR_MOVEMENT_REPORT_OBJECT }, restricted(restriction)))
        .items;
      expect(reportCodes(items), label).toEqual(['institution', 'monthly']);
      for (const item of items) {
        expect(item.operator.userId, `${label}：导出人是别人，不是审计员`).toBe(movement.who.user);
        expect(item.operator.userId).not.toBe(movementAuditor.user);
        expect(item).toMatchObject({ behavior: 'export', objectLabel: '流动情况报表', result: 'succeeded' });
      }
    }
  });

  it('AC-AUD-F509-02：员工结构报表——同样在任何数据范围下查到别人执行的导出', async () => {
    await exportQuality();
    for (const [label, restriction] of [['看全部', {}], ...scopes(structure.who.tenant)] as const) {
      const items = (await logs(structureAuditor, { objectType: HR_STRUCTURE_REPORT_OBJECT }, restricted(restriction)))
        .items;
      expect(reportCodes(items), label).toEqual(['quality']);
      expect(items[0]!.operator.userId, label).toBe(structure.who.user);
      expect(items[0]).toMatchObject({ objectLabel: '员工结构报表', result: 'succeeded' });
    }
  });

  it('AC-AUD-F509-03：有日志审计能力但没有该报表的 object.view——查不到（两类报表各一例；另一类报表的查看权不通用）', async () => {
    await exportMovement('monthly', 'data');
    await exportQuality();
    const noMovement = restricted({ deny: canView(HR_MOVEMENT_REPORT_OBJECT) });
    const noStructure = restricted({ deny: canView(HR_STRUCTURE_REPORT_OBJECT) });
    expect(await codes(movementAuditor, HR_MOVEMENT_REPORT_OBJECT, noMovement)).toEqual([]);
    expect(await codes(structureAuditor, HR_STRUCTURE_REPORT_OBJECT, noStructure)).toEqual([]);
    // 只缺流动情况报表的查看权：员工结构报表照常可见，反之亦然
    expect(await codes(structureAuditor, HR_STRUCTURE_REPORT_OBJECT, noMovement)).toEqual(['quality']);
    expect((await codes(movementAuditor, HR_MOVEMENT_REPORT_OBJECT, noStructure)).length).toBeGreaterThan(0);
    // 上面的 restricted 默认数据范围就是“看全部”：缺查看权时范围不能代替查看权
  });

  it('AC-AUD-F509-04：没有日志审计能力——进不了审计页（入口门禁 admin.audit_log 未被放开，403），即使有报表查看权', async () => {
    await exportMovement('monthly', 'data');
    const noAudit = restricted({ deny: (r) => r.action === 'admin.audit_log' });
    const api = audit(noAudit);
    for (const path of ['/operation-logs?behavior=export', `/operation-logs?objectType=${HR_MOVEMENT_REPORT_OBJECT}`]) {
      expect((await api.get(path, movementAuditor)).status, path).toBe(403);
    }
    // 对照：同一审计员放行入口后就是 200（上面的 403 来自入口门禁而不是别的原因）
    expect((await audit(restricted({})).get('/operation-logs?behavior=export', movementAuditor)).status).toBe(200);
  });

  it('AC-AUD-F509-05：失败的导出仍不写审计（DEC-846①）——审计员看到的条数不变', async () => {
    await exportMovement('monthly', 'data');
    const settled = (await logs(movementAuditor, { objectType: HR_MOVEMENT_REPORT_OBJECT })).items.length;
    expect(settled).toBeGreaterThan(0);
    const mover = movementClient(movement.db, movement.who);
    const denied = movementClient(movement.db, movement.who, restricted({ deny: canView(HR_MOVEMENT_REPORT_OBJECT) }));
    expect((await mover.get(`${MOVEMENT_BASE}/reports/monthly/export?${MOVEMENT_QUERY}`)).status).toBe(400);
    expect((await mover.get(exportPath(MOVEMENT_BASE, 'unknown', MOVEMENT_QUERY, 'data'))).status).toBe(404);
    expect((await denied.get(exportPath(MOVEMENT_BASE, 'monthly', MOVEMENT_QUERY, 'data'))).status).toBe(403);
    expect((await logs(movementAuditor, { objectType: HR_MOVEMENT_REPORT_OBJECT })).items.length).toBe(settled);
  });

  it('AC-AUD-F509-06：跨租户仍 fail-closed——别的租户的审计员看不到本租户任何导出，借租户头也越权不了', async () => {
    await exportMovement('monthly', 'data');
    await exportQuality();
    expect((await codes(structureAuditor, HR_MOVEMENT_REPORT_OBJECT, restricted({}))).length).toBe(0);
    expect((await codes(movementAuditor, HR_STRUCTURE_REPORT_OBJECT, restricted({}))).length).toBe(0);
    // 结构租户的审计员带流动租户的租户头：拒绝，不是空页
    const response = await audit(restricted({})).get('/operation-logs?behavior=export', {
      user: structureAuditor.user,
      tenant: movement.who.tenant,
    });
    expect([400, 401, 403, 404]).toContain(response.status);
  });

  it('AC-AUD-F509-07：别人的导出对审计员可见，但仍不带导出附件（文件名 / 筛选条件 / 说明）', async () => {
    await exportMovement('institution', 'formula');
    const { items } = await logs(movementAuditor, {
      objectType: HR_MOVEMENT_REPORT_OBJECT,
      objectId: 'institution',
    });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.attachment ?? null).toBeNull();
      const text = JSON.stringify(item);
      for (const leaked of ['fileName', 'filter', 'note', '.xlsx']) expect(text).not.toContain(leaked);
    }
  });
});
