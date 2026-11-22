import { sql, withTenant, type Db } from '@italent/db';
import { CONTRACT_BOARD_OBJECT, HR_DASHBOARD_OBJECT } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, expect, it } from 'vitest';
import { CONTRACT_BOARD_BASE, contractKit, structureWorld, TODAY } from './AC-HA-13a-support.js';
import { parseCsv } from './AC-HA-roster-support.js';
import { offerWorld } from './AC-OF-BE14a-support.js';
import type { RequestOptions } from './support/tenant-api.js';

const database = useTestDb();
const DASH = '/api/tenant/analytics/hr-dashboard/indicators';
const CONTRACT = `${CONTRACT_BOARD_BASE}/components`;
const AS_OF = `asOf=${TODAY}`;
const EMPLOYEE_COLUMNS = ['明细行 ID', '员工 ID'];
const BOARD_CONTRACT_COLUMNS = ['合同记录 ID', '员工 ID', '组织 ID'];
type Get = (path: string, options?: RequestOptions) => Promise<Response>;
type Item = { id: string; employeeId: string | null; organizationId?: string | null };

async function buildWorld(db: Db, label: string) {
  const w = await structureWorld(db, label);
  const inside = await w.org('甲部门');
  const outside = await w.org('乙部门');
  const a = await w.hire('甲员工', { date: '2020-01-01', department: inside });
  const b = await w.hire('乙员工', { date: '2020-01-01', department: inside });
  const c = await w.hire('丙员工', { date: '2020-01-01', department: outside });
  const k = await contractKit(w);
  const company = await k.master('companies', '合成法人');
  const otherCompany = await k.master('companies', '另一法人');
  const labor = await k.master('types', '劳动合同');
  const multi = await k.master('types', '多点执业协议');
  const sign = (employeeId: string, typeId: string, effectiveDate: string, endDate: string, companyId = company.id) =>
    k.command({
      operation: 'create',
      employeeId,
      fields: { typeId, companyId, effectiveDate, endDate, termType: 'fixed', signingDate: effectiveDate },
    });
  const old = await sign(a.id, multi.id, '2025-01-01', '2026-12-31');
  const current = await sign(a.id, labor.id, '2026-06-01', '2026-10-20');
  const tie = await sign(a.id, multi.id, '2026-06-01', '2026-12-31');
  const single = await sign(b.id, labor.id, '2026-06-02', '2026-12-31');
  const out = await sign(c.id, labor.id, '2026-06-03', '2026-10-22');
  const competing = await sign(b.id, labor.id, '2026-06-02', '2026-12-31', otherCompany.id);
  return {
    w,
    k,
    inside,
    outside,
    a,
    b,
    c,
    company,
    labor,
    multi,
    old,
    current,
    tie,
    single,
    out,
    competing,
  };
}

let x: Awaited<ReturnType<typeof buildWorld>>;
beforeAll(async () => {
  x = await buildWorld(database().db, 'f547-a');
}, 300_000);

const get: Get = (path, options) => x.w.call('GET', path, options);
const pathOf = (base: string, code: string, query = AS_OF) => `${base}/${code}/export?${query}`;

async function csv(response: Response, board: string, code: string, asOf = TODAY) {
  expect(response.status, `${board}/${code} 下载必须成功`).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
  expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${board}-${code}-${asOf}.csv"`);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const text = new TextDecoder().decode(bytes.slice(3));
  expect(text).toMatch(/\r\n$/);
  expect(text.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/);
  return parseCsv(text);
}

async function detailRows(read: Get, base: string, code: string, query: string) {
  const rows: Item[] = [];
  for (let page = 1; page <= 10; page++) {
    const response = await read(`${base}/${code}?${query}&page=${page}&pageSize=1`);
    expect(response.status).toBe(200);
    const { total, items } = (await response.json()) as { total: number; items: Item[] };
    rows.push(...items);
    if (rows.length === total) return rows;
  }
  throw new Error('验收夹具明细超过 10 页');
}

function logs(w: typeof x.w, object: string, code: string) {
  return w.sqlRows<{
    tenant_id: string;
    actor_user_id: string;
    object_type: string;
    object_id: string;
    behavior: string;
    summary: string;
    total_count: number;
    success_count: number;
    failure_count: number;
    result: string;
    attachment: null;
    items: null;
    error_report: null;
    scope_employee_id: null;
    scope_org_id: null;
    source_page: string | null;
    occurred_at: string | Date;
  }>(sql`SELECT * FROM audit_operation_logs
    WHERE tenant_id=${w.tenantId} AND object_type=${object} AND object_id=${code} AND behavior='export'`);
}

function expectLog(row: Awaited<ReturnType<typeof logs>>[number], w: typeof x.w, object: string, code: string) {
  expect(row).toMatchObject({
    tenant_id: w.tenantId,
    actor_user_id: w.who.user,
    object_type: object,
    object_id: code,
    behavior: 'export',
    total_count: 1,
    success_count: 1,
    failure_count: 0,
    result: 'succeeded',
    attachment: null,
    items: null,
    error_report: null,
    scope_employee_id: null,
    scope_org_id: null,
  });
  expect(new Date(row.occurred_at).toISOString()).toBe(`${TODAY}T01:00:00.000Z`);
}

it('AC-HA-F547-01/04/06 B48 员工全量按 D 分页顺序，只有固定两列并审计一次', async () => {
  const code = 'regularEmployees';
  const detail = await detailRows(get, DASH, code, AS_OF);
  expect(detail.map(({ id }) => id)).toEqual([x.a.id, x.b.id, x.c.id].sort());
  const before = await logs(x.w, HR_DASHBOARD_OBJECT, code);
  const response = await get(pathOf(DASH, code), { headers: { 'x-source-page': '/hr-dashboard' } });
  expect(await csv(response, 'hr-dashboard', code)).toEqual([
    EMPLOYEE_COLUMNS,
    ...detail.map(({ id, employeeId }) => [id, employeeId]),
  ]);
  const after = await logs(x.w, HR_DASHBOARD_OBJECT, code);
  expect(after).toHaveLength(before.length + 1);
  const log = after.find(({ source_page }) => source_page === '/hr-dashboard')!;
  expectLog(log, x.w, HR_DASHBOARD_OBJECT, code);
  expect(log.summary).toBe('导出组件明细：在职员工数（正式）');
  for (const raw of [TODAY, x.a.id, x.b.id, x.c.id, x.inside.id]) {
    expect(JSON.stringify(log)).not.toContain(raw === TODAY ? AS_OF : raw);
  }
});

it('AC-HA-F547-01/04 B48 合同记录、申请、Offer 及部门各用自身的行 ID', async () => {
  const offer = await offerWorld(database().db, 'f547');
  const created = await offer.social();
  const readOffer: Get = (path) => offer.seeder.request('GET', path, { tenant: offer.tenant.id, user: offer.user.id });
  const pending = await x.k.rawRequest(x.a.id, null, {
    operation: 'create',
    status: 'in_review',
    typeId: x.labor.id,
    companyId: x.company.id,
    effectiveDate: '2026-06-01',
  });
  const cases = [
    { code: 'contractExpiring30', label: '合同记录 ID', ids: [x.current.id, x.out.id], read: get },
    { code: 'contractApproving', label: '申请单 ID', ids: [pending], read: get },
    { code: 'offerPending', label: 'Offer ID', ids: [created.id], read: readOffer },
    { code: 'departmentNoHead', label: '部门 ID', ids: [x.inside.id, x.outside.id], read: get },
  ];
  for (const { code, label, ids, read } of cases) {
    const detail = await detailRows(read, DASH, code, AS_OF);
    expect(detail.map(({ id }) => id)).toEqual(ids.sort());
    expect(await csv(await read(pathOf(DASH, code)), 'hr-dashboard', code)).toEqual([
      [label, '员工 ID'],
      ...detail.map(({ id, employeeId }) => [id, employeeId ?? '']),
    ]);
  }
});

it('AC-HA-F547-01/06 B55 签署按组取 D 的代表合同，下载逐行相等并留痕', async () => {
  const code = 'signByCompany';
  const query = `${AS_OF}&group=${x.company.id}`;
  const detail = await detailRows(get, CONTRACT, code, query);
  expect(detail.map(({ id }) => id)).toEqual([[x.current.id, x.tie.id].sort().at(-1), x.single.id, x.out.id].sort());
  const before = await logs(x.w, CONTRACT_BOARD_OBJECT, code);
  expect(await csv(await get(pathOf(CONTRACT, code, query)), 'contract-board', code)).toEqual([
    BOARD_CONTRACT_COLUMNS,
    ...detail.map(({ id, employeeId, organizationId }) => [id, employeeId, organizationId ?? '']),
  ]);
  const after = await logs(x.w, CONTRACT_BOARD_OBJECT, code);
  expect(after).toHaveLength(before.length + 1);
  expectLog(after[0]!, x.w, CONTRACT_BOARD_OBJECT, code);
  expect(JSON.stringify(after)).not.toContain(x.company.id);
});

it('AC-HA-F547-02 B55 合同变动叠加日期、法人、类型、期限，导出申请单而非合同记录', async () => {
  const code = 'changeCreate';
  const query =
    `${AS_OF}&changeFrom=2026-06-01&changeTo=2026-06-02` +
    `&companyId=${x.company.id}&typeId=${x.labor.id}&termType=fixed`;
  const detail = await detailRows(get, CONTRACT, code, query);
  expect(detail.map(({ id }) => id)).toEqual(
    await x.w
      .sqlRows<{ id: string }>(
        sql`SELECT id::text FROM contract_requests
      WHERE tenant_id=${x.w.tenantId} AND result_id IN (${x.current.id}, ${x.single.id}) ORDER BY id`,
      )
      .then((rows) => rows.map(({ id }) => id)),
  );
  expect(detail).toHaveLength(2);
  expect(await csv(await get(pathOf(CONTRACT, code, query)), 'contract-board', code)).toEqual([
    ['申请单 ID', '员工 ID', '组织 ID'],
    ...detail.map(({ id, employeeId, organizationId }) => [id, employeeId, organizationId ?? '']),
  ]);
});
