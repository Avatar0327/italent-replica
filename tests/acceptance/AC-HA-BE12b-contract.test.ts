/**
 * BE-12b 人事看板指标 6、8、19（合同）：未来 30 天合同到期、合同已过期、合同审批中（规格 35 §2.1）。
 * 固定夹具（租户今天 = 2026-10-06）：到期窗口 [asOf, asOf+30] 含两端；已有后续合同接上的不算到期 / 过期；
 * 已发起续签但未生效的合同仍计入“未来 30 天合同到期”（规格 #6“尚未续签生效”，与合同列表“即将到期”视图的在途续签排除不同）；
 * 合同审批中 = 申请单审批中或审批通过未生效，退回 / 已生效 / 撤回不计。每个指标都断言数字 = 明细。
 */
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import type { Authorizer } from '@italent/api';
import { dayAt } from './AC-EXIT-activation-support.js';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';
import { dashboardClient, type DashboardClient } from './AC-HA-BE12b-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';

async function buildWorld() {
  const x = await downstreamWorld(database().db, 'ha-12b-contract', TODAY);
  const tenant = x.session.tenant.id;
  const user = x.session.user.id;
  const type = await x.contractType('劳动合同');
  const company = (await (
    await x.contracts('POST', '/master-data/companies', { ifMatch: 0, body: { code: randomUUID(), name: '合成法人' } })
  ).json()) as { id: string };

  async function contract(name: string, fields: Record<string, unknown>) {
    const { employee } = await x.hired(name);
    const response = await x.contracts('POST', '/commands', {
      ifMatch: 0,
      body: {
        operation: 'create',
        mode: 'direct',
        employeeId: employee.id,
        fields: {
          typeId: type,
          companyId: company.id,
          effectiveDate: '2025-01-01',
          termType: 'fixed',
          termMonths: 12,
          signingDate: '2024-12-20',
          ...fields,
        },
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return { employee, ...((await response.json()) as { id: string }) };
  }
  /** 针对某份合同的在途 / 已办结申请（直接造数：申请单状态由审批中心推进，这里只要状态）。 */
  async function request(target: { id: string; employee: { id: string } }, status: string, operation = 'renew') {
    const id = randomUUID();
    await x.sqlRows(sql`INSERT INTO contract_requests(id,tenant_id,employee_id,number,type_id,company_id,term_type,
        effective_date,end_date,signing_count,operation,mode,status,created_by,target_id)
      VALUES (${id}::uuid,${tenant},${target.employee.id}::uuid,${`REQ-${randomUUID()}`},${type}::uuid,
        ${company.id}::uuid,'fixed','2026-10-27','2027-10-26',2,${operation},'application',${status},${user}::uuid,
        ${target.id}::uuid)`);
    return id;
  }

  const c = {
    in20: await contract('二十天后到期', { endDate: '2026-10-26' }),
    day30: await contract('第三十天到期', { endDate: '2026-11-05' }),
    day31: await contract('第三十一天到期', { endDate: '2026-11-06' }),
    today: await contract('今天到期', { endDate: '2026-10-06' }),
    expired: await contract('昨天已过期', { endDate: '2026-10-05' }),
    renewed: await contract('已有后续合同', { endDate: '2026-09-30' }),
    inFlight: await contract('已发起续签', { endDate: '2026-10-20' }),
  };
  // 后续合同：同类型、生效日 = 上一份终止日次日（合同列表同一口径）
  await x.contracts('POST', '/commands', {
    ifMatch: 0,
    body: {
      operation: 'create',
      mode: 'direct',
      employeeId: c.renewed.employee.id,
      fields: {
        typeId: type,
        companyId: company.id,
        effectiveDate: '2026-10-01',
        endDate: '2027-09-30',
        termType: 'fixed',
        termMonths: 12,
        signingDate: '2026-09-20',
      },
    },
  });
  const requests = {
    review: await request(c.inFlight, 'in_review'),
    approved: await request(c.in20, 'approved'),
    returned: await request(c.day30, 'returned'),
    effective: await request(c.day31, 'effective'),
    withdrawn: await request(c.expired, 'withdrawn'),
  };
  return { x, tenant, user, c, requests };
}
type World = Awaited<ReturnType<typeof buildWorld>>;

describe('BE-12b 人事看板 合同指标', () => {
  let w: World;
  let board: DashboardClient;
  beforeAll(async () => {
    w = await buildWorld();
    board = dashboardClient(database().db, { tenant: w.tenant, user: w.user }, { now: () => dayAt(TODAY) });
  }, 300_000);

  it('指标 6：未来 30 天合同到期，含 asOf 当天与第 30 天，第 31 天不计；已发起续签但未生效的仍计，已有后续合同的不计', async () => {
    const { in20, day30, today, inFlight } = w.c;
    await board.expectIndicator(
      'contractExpiring30',
      [in20, day30, today, inFlight].map((item) => item.id),
    );
    const ids = (await board.detail('contractExpiring30')).ids;
    expect(ids).not.toContain(w.c.day31.id);
    expect(ids).not.toContain(w.c.expired.id);
    expect(ids).not.toContain(w.c.renewed.id);
  });

  it('指标 8：合同已过期 = 已过到期日仍未续签；到期日当天不算过期，已有后续合同的不计', async () => {
    await board.expectIndicator('contractOverdue', [w.c.expired.id]);
    // 时点：asOf 往后拨到 10-21，已发起续签但没生效的合同也已过期；还没到期的不计
    await board.expectIndicator(
      'contractOverdue',
      [w.c.expired, w.c.today, w.c.inFlight].map((item) => item.id),
      '2026-10-21',
    );
    await board.expectIndicator(
      'contractExpiring30',
      [w.c.in20, w.c.day30, w.c.day31].map((item) => item.id),
      '2026-10-21',
    );
  });

  it('指标 19：合同审批中 = 申请审批中或审批通过未生效；退回、已生效、撤回的申请不计', async () => {
    await board.expectIndicator('contractApproving', [w.requests.review, w.requests.approved]);
    const row = (await board.page('contractApproving')).items.find((item) => item.id === w.requests.review)!;
    expect(row.employeeId).toBe(w.c.inFlight.employee.id);
  });

  it('数据范围：范围内没有这些员工时合同指标都是 0（按员工与创建人裁剪，不回退到全部）', async () => {
    const authorize: Authorizer = () => true;
    registerScopeProvider(authorize, {
      scope: async () => ({
        ...EMPTY_SCOPE,
        hasDataPermission: true,
        orgIds: [w.x.to.id],
        terms: [
          {
            dimension: 'management',
            orgIds: [w.x.to.id],
            personIds: [],
            personQuery: { kind: 'organization', tenantId: w.tenant, asOf: TODAY },
          },
        ],
      }),
      authorize: async (request) => authorize(request),
      fields: async () => new Set(),
    });
    const scoped = dashboardClient(
      database().db,
      { tenant: w.tenant, user: w.user },
      { now: () => dayAt(TODAY), authorize },
    );
    for (const code of ['contractExpiring30', 'contractOverdue', 'contractApproving'] as const)
      await scoped.expectIndicator(code, []);
  });
});
