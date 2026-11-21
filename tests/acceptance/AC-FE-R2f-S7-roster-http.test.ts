/** AC-FE-R2f-06：前端 URL 适配器接真实租户 HTTP，夹具通过既有业务命令写入。 */
import './support/exit-gate-enforced.js';
import type { Authorizer } from '@italent/api';
import { ROSTER_EXPORT_MAX_ROWS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, expect, it, vi } from 'vitest';
import type * as RosterQuery from '../../apps/api/src/modules/hr-analysis/roster-query.js';
import { reportOf, reportUrl, rosterResultFilters, tablesOf } from '../../apps/web/src/hr-reports/model.js';
import {
  parseCsv,
  PERSON_OBJECT,
  ROSTER_HEADERS,
  ROSTER_OBJECT,
  rosterWorld,
  stripBom,
  type RosterPage,
  type RosterWorld,
} from './AC-HA-roster-support.js';

// 上限用可控计数触发。权限、路由与响应均执行生产代码，名单查询用实际数据库计数。
const forced = vi.hoisted(() => ({ total: undefined as number | undefined }));
vi.mock('../../apps/api/src/modules/hr-analysis/roster-query.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RosterQuery>();
  return {
    ...actual,
    countRoster: async (...args: Parameters<typeof actual.countRoster>) => forced.total ?? actual.countRoster(...args),
  };
});

const database = useTestDb();
const historical = '2025-07-01';
const today = '2026-10-06';
const prefix = 'ZZ_FER2F_';
const report = reportOf('roster')!;
const allow: Authorizer = () => true;
let world: RosterWorld;
let employeeId: string;

beforeAll(async () => {
  world = await rosterWorld(database().db, prefix + 'S7');
  const group = await world.org(prefix + '集团');
  const previous = await world.org(prefix + '原部门', group);
  const current = await world.org(prefix + '现部门', group);
  const employee = await world.hire(prefix + '01', prefix + '员工甲', '2025-01-01', previous, {
    workDate: '2020-02-02',
    backupMail: 'zz_fer2f@example.com',
  });
  employeeId = employee.id;
  const first = await world.contract(employeeId, { effectiveDate: '2025-01-01', endDate: '2025-12-31' });
  await world.contract(employeeId, { effectiveDate: '2026-01-01', endDate: '2026-12-31' }, first);
  await world.rename(previous, prefix + '原部门改名', '2026-01-01');
  await world.session.business(
    employeeId,
    { kind: 'transfer', mode: 'direct', effectiveDate: '2026-03-01', fields: { departmentId: current.id } },
    (await world.session.getEmployee(employeeId)).revision,
  );
  for (const [code, employType] of [
    ['02', 'intern'],
    ['03', 'external'],
  ] as const) {
    const next = await world.session.employee(prefix + employType, prefix + code);
    const result = await world.session.business(
      next.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2025-02-01', fields: { departmentId: previous.id, employType } },
      next.revision,
    );
    expect(result.status).toBe('effective');
  }
}, 120_000);

async function read(path: string, request = world.call) {
  const response = await request('GET', path);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as RosterPage;
}

it('AC-FE-R2f-06 两个时点取各自的部门、组织全称、合同，预设群体含实习生', async () => {
  const past = await read(reportUrl(report, { asOf: historical }, 1));
  const current = await read(reportUrl(report, { asOf: today }, 1));
  expect(past).toMatchObject({ asOf: historical, page: 1, pageSize: 20, total: 2 });
  expect(past.items.map(({ code }) => code)).toEqual([prefix + '01', prefix + '02']);
  expect(past.items[0]).toMatchObject({
    employeeId,
    orgLevel2: prefix + '原部门',
    contractEffectiveDate: '2025-01-01',
    contractEndDate: '2025-12-31',
  });
  expect(past.items[0]!.orgFullName).toMatch(/ZZ_FER2F_集团\/ZZ_FER2F_原部门$/);
  const currentEmployee = current.items.find((item) => item.employeeId === employeeId);
  expect(currentEmployee).toMatchObject({
    employeeId,
    orgLevel2: prefix + '现部门',
    contractEffectiveDate: '2026-01-01',
    contractEndDate: '2026-12-31',
  });
  expect(currentEmployee!.orgFullName).toMatch(/ZZ_FER2F_集团\/ZZ_FER2F_现部门$/);
  expect(tablesOf(report.code, past)[0]!.columns.map(({ label }) => label)).toEqual([
    '姓名',
    '工号',
    ...ROSTER_HEADERS,
  ]);
});

it('AC-FE-R2f-06 授权列与 CSV 同序，日期、状态筛选及第二页沿用回执上下文', async () => {
  const request = world.restricted(allow, { hidden: { [PERSON_OBJECT]: ['name', 'backupMail'] } });
  const filters = { asOf: historical, workDateFrom: '2020-02-01', workDateTo: '2020-03-01', employeeStatus: '3' };
  const first = await read(reportUrl(report, filters, 1), request);
  const visible = first.columns.map(({ key }) => key);
  expect(visible).not.toContain('employeeName');
  expect(visible).not.toContain('backupMail');
  expect(first.items[0]).toMatchObject({ employeeId, workDate: '2020-02-02', employeeStatus: 3 });
  expect(first.items[0]).not.toHaveProperty('employeeName');
  expect(first.items[0]).not.toHaveProperty('backupMail');
  expect(first.total).toBe(1);

  const applied = rosterResultFilters(filters, first)!;
  const next = await read(reportUrl(report, applied, 2), request);
  expect(next).toMatchObject({ asOf: historical, page: 2, pageSize: 20, total: 1, items: [] });
  const csv = await request('GET', reportUrl(report, applied, undefined, true));
  expect(csv.status).toBe(200);
  expect(csv.headers.get('content-disposition')).toBe('attachment; filename="roster-2025-07-01.csv"');
  const bytes = new Uint8Array(await csv.arrayBuffer());
  expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const rows = parseCsv(stripBom(new TextDecoder().decode(bytes)));
  expect(rows).toHaveLength(2);
  expect(rows[0]).toEqual(first.columns.map(({ label }) => label));
  expect(rows[1]![rows[0]!.indexOf('人员状态')]).toBe('正式');
  expect(rows[1]![rows[0]!.indexOf('工号')]).toBe(prefix + '01');
  expect(await read(reportUrl(report, { ...applied, employeeStatus: '2' }, 1), request)).toMatchObject({ total: 0 });
  const revoked = await request('GET', reportUrl(report, { ...applied, name: prefix }, undefined, true));
  expect(revoked.status).toBe(403);
  expect(revoked.headers.get('content-disposition')).toBeNull();
});

it('AC-FE-R2f-06 两个对象分别准入，导出按钮改权与超限返回机器错误而无附件', async () => {
  const filters = { asOf: historical };
  const list = reportUrl(report, filters, 1);
  const csv = reportUrl(report, filters, undefined, true);
  for (const object of [ROSTER_OBJECT, PERSON_OBJECT]) {
    const denied = world.restricted(({ action, resource }) => action !== 'object.view' || resource !== object);
    expect((await denied('GET', list)).status).toBe(403);
  }
  let exportAllowed = true;
  const request = world.restricted(
    ({ action, resource }) =>
      exportAllowed || action !== 'object.button' || resource !== ROSTER_OBJECT + '#export@list',
  );
  await read(list, request);
  exportAllowed = false;
  const denied = await request('GET', csv);
  expect(denied.status).toBe(403);
  expect(denied.headers.get('content-disposition')).toBeNull();
  expect(await denied.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });

  exportAllowed = true;
  forced.total = ROSTER_EXPORT_MAX_ROWS + 1;
  try {
    const limited = await request('GET', csv);
    expect(limited.status).toBe(422);
    expect(limited.headers.get('content-disposition')).toBeNull();
    expect(await limited.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', details: { reason: 'EXPORT_ROW_LIMIT' } },
    });
  } finally {
    forced.total = undefined;
  }
});
