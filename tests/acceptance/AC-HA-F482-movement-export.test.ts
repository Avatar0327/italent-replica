/**
 * F-482 / DEC-803②、DEC-809、DEC-810：流动情况里两张统计报表（各月入离职统计、各机构入离职统计）的 xlsx 导出。
 * 原站取证（evidence §4～5）：同步下载、单 sheet「Sheet1」、文件名 = 报表名.xlsx、A 列空从 B 列起、合计行 /「月均」行、
 * 填报人 / 填报日期 / 说明行、数值不取整（离职率是小数）、只回显时间筛选不回显部门；导出 = 页面当前已运行的结果。
 * 复刻口径（原站未测）：能看就能导出（不新增授权项）、每次成功导出记一条对象操作日志。
 * 固定夹具沿用 BE-13b（asOf = 2026-10-06）；期望值手写，页面接口只作“逐行相等”的对照。
 */
import { randomUUID } from 'node:crypto';
import { eq, users, withPlatform } from '@italent/db';
import { HR_MOVEMENT_REPORT_OBJECT } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Authorizer } from '../../apps/api/src/authorization.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { managementScope, restrictedAuthorizer, TODAY } from './AC-HA-13a-support.js';
import {
  MOVEMENT_BASE as BASE,
  movementClient,
  movementWorld,
  type MovementReport,
  type MovementWorld,
} from './AC-HA-13b-support.js';
import {
  downloadXlsx,
  exportLogs,
  exportPath,
  expectModesEqual,
  newRows,
  refOf,
  stringsOf,
} from './AC-HA-F482-support.js';
import { formulaCells, valueAt, type Xlsx } from './support/xlsx-read.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const AS_OF = 'asOf=2026-10-06';
const NOTE = '离职率=离职人数/(期初人数+期末人数)*2*100%';
const HEADER = ['期初人数', '入职人数', '离职人数', '期末人数', '离职率'];
const VALUE_COLUMNS = ['C', 'D', 'E', 'F', 'G'];
const KEYS = ['opening', 'hires', 'exits', 'closing', 'rate'] as const;

const table = (report: MovementReport, key: string) => report.tables!.find((item) => item.key === key)!;
/** 文件与页面逐格相等；只有离职率允许差页面的 4 位取整（文件不取整，页面取整到 4 位）。 */
function expectLikePage(
  actual: readonly (number | string | undefined)[],
  page: Readonly<Record<string, number | null | undefined>>,
  label: string,
) {
  expect(actual.slice(0, 4), label).toEqual(KEYS.slice(0, 4).map((key) => page[key] ?? undefined));
  const shown = page.rate;
  if (shown === null || shown === undefined) expect(actual[4], label).toBeUndefined();
  else expect(Math.abs((actual[4] as number) - shown), `${label} 离职率`).toBeLessThanOrEqual(5e-5 + 1e-12);
}
const cellsAt = (book: Xlsx, row: number) => VALUE_COLUMNS.map((column) => valueAt(book, `${column}${row}`));

describe('AC-HA-F482 流动情况两张统计报表导出', () => {
  let w: MovementWorld;
  let c: ReturnType<typeof movementClient>;
  let exporter = '';
  beforeAll(async () => {
    w = await movementWorld(database().db);
    c = movementClient(w.db, w.who);
    const [user] = await withPlatform(w.db, (tx) => tx.select().from(users).where(eq(users.id, w.who.user)));
    exporter = user!.displayName;
  }, 600_000);

  const download = (code: string, query: string, mode: 'data' | 'formula', client = c) =>
    downloadXlsx(
      client.get,
      exportPath(BASE, code, query, mode),
      `${code === 'monthly' ? '各月' : '各机构'}入离职统计.xlsx`,
    );

  /** 页脚三行：填报人（导出人姓名）、填报日期（导出当天，租户时区）、说明行（整行合并）。 */
  function expectFooter(book: Xlsx, lastColumn: string) {
    const person = refOf(book, '填报人：');
    expect(valueAt(book, person)).toBe(`填报人：${exporter}`);
    expect(person.startsWith('B')).toBe(true);
    expect(valueAt(book, refOf(book, '填报日期：'))).toBe(`填报日期：${TODAY}`);
    const note = refOf(book, NOTE);
    expect(note.startsWith('B')).toBe(true);
    expect(book.merges).toContain(`B${note.slice(1)}:${lastColumn}${note.slice(1)}`);
  }

  it('AC-HA-F482-01：各月入离职统计——Sheet1、标题行、单行表头、12 个月、月均行、页脚；离职率不取整；没有隐藏行列', async () => {
    const query = `${AS_OF}&year=2026`;
    const page = table(await c.report('monthly', query), 'monthly');
    const { book } = await download('monthly', query, 'data');

    expect(book.sheetNames).toEqual(['Sheet1']);
    // 标题行：年份在单独一格（C1），后接「年各月入离职统计」（D1:G1 合并）；A 列空
    expect(valueAt(book, 'C1')).toBe(2026);
    expect(valueAt(book, 'D1')).toBe('年各月入离职统计');
    expect(book.merges).toContain('D1:G1');
    expect([...book.cells.keys()].some((ref) => ref.startsWith('A'))).toBe(false);
    expect(['B', ...VALUE_COLUMNS].map((column) => valueAt(book, `${column}2`))).toEqual(['月份', ...HEADER]);

    // 12 个月逐行等于页面；asOf 之后的月份（11、12 月）留空，不写 0
    expect(page.rows).toHaveLength(12);
    page.rows.forEach((row, index) => {
      expect(valueAt(book, `B${3 + index}`), row.key).toBe(row.label);
      expectLikePage(cellsAt(book, 3 + index), row.cells, row.key);
    });
    expect(cellsAt(book, 3)).toEqual([5, 0, 1, 5, 0.2]); // 手写：1 月 期初 5、入职 0、离职 1、期末 5
    expect(cellsAt(book, 4)).toEqual([5, 2, 0, 6, 0]); // 2 月
    expect(cellsAt(book, 12)).toEqual([6, 1, 0, 6, 0]); // 10 月（期初 ≠ 9 月期末）
    expect(cellsAt(book, 13)).toEqual([undefined, undefined, undefined, undefined, undefined]);

    // 「月均」行 = 已到月份的月均（计数列取平均，离职率 = 离职人数 / (期初 + 期末) * 2，不取整）
    expect(valueAt(book, 'B15')).toBe('月均');
    const arrived = page.rows.filter((row) => row.cells.opening !== null);
    expect(arrived).toHaveLength(10);
    const mean = (key: (typeof KEYS)[number]) =>
      arrived.reduce((sum, row) => sum + row.cells[key]!, 0) / arrived.length;
    for (const [index, key] of KEYS.slice(0, 4).entries())
      expect(valueAt(book, `${VALUE_COLUMNS[index]}15`) as number, `月均 ${key}`).toBeCloseTo(mean(key), 12);
    expect(valueAt(book, 'G15') as number).toBeCloseTo((mean('exits') * 2) / (mean('opening') + mean('closing')), 12);
    expectFooter(book, 'G');

    expect(book.hiddenRows).toEqual([]);
    expect(book.hiddenColumns).toEqual([]);
    // 原站不冻结窗格、没有定义名称、没有超链接
    expect(book.entries.get('xl/workbook.xml')).not.toContain('definedName');
    expect(book.entries.get('xl/worksheets/sheet1.xml')).not.toMatch(/<pane|<hyperlink/);
  });

  it('AC-HA-F482-02：各机构入离职统计——标题 B1:G1、年份 / 月份行、表头、一级机构行、合计行；离职率是不取整的小数', async () => {
    const query = `${AS_OF}&year=2026&month=4`;
    const page = table(await c.report('institution', query), 'institution');
    const { book } = await download('institution', query, 'data');

    expect(book.sheetNames).toEqual(['Sheet1']);
    expect(valueAt(book, 'B1')).toBe('各机构入离职统计');
    expect(book.merges).toContain('B1:G1');
    expect(valueAt(book, 'B2')).toBe('年份：2026');
    expect(valueAt(book, 'C2')).toBe('月份：4');
    expect(['B', ...VALUE_COLUMNS].map((column) => valueAt(book, `${column}3`))).toEqual(['一级机构', ...HEADER]);

    page.rows.forEach((row, index) => {
      expect(valueAt(book, `B${4 + index}`)).toBe(row.label);
      expect(cellsAt(book, 4 + index).slice(0, 4)).toEqual(KEYS.slice(0, 4).map((key) => row.cells[key]));
    });
    // 手写：4 月 乙部 期初 2、入职 0、离职 1、期末 1 → 离职率 2/3，页面显示 0.6667，文件里是 0.6666…
    const b = page.rows.findIndex((row) => row.key === w.B.id);
    expect(cellsAt(book, 4 + b).slice(0, 4)).toEqual([2, 0, 1, 1]);
    expect(valueAt(book, `G${4 + b}`) as number).toBeCloseTo(2 / 3, 12);
    expect(Math.abs((valueAt(book, `G${4 + b}`) as number) - 0.6667)).toBeGreaterThan(1e-6);

    // 合计行：计数列 = 各行之和（也等于页面合计），离职率按合计重算
    const total = 4 + page.rows.length;
    expect(valueAt(book, `B${total}`)).toBe('合计');
    for (const [index, key] of KEYS.slice(0, 4).entries()) {
      const sum = page.rows.reduce((acc, row) => acc + row.cells[key]!, 0);
      expect(valueAt(book, `${VALUE_COLUMNS[index]}${total}`), `合计 ${key}`).toBe(sum);
      expect(sum, `页面合计 ${key}`).toBe(page.summary.cells[key]);
    }
    const [opening, , exits, closing] = cellsAt(book, total) as number[];
    expect(valueAt(book, `G${total}`) as number).toBeCloseTo((exits! * 2) / (opening! + closing!), 12);
    expectFooter(book, 'G');
    expect(book.hiddenRows).toEqual([]);
    expect(book.hiddenColumns).toEqual([]);
  });

  it('AC-HA-F482-03：页面筛选带进导出——改时间与部门后文件 = 页面结果；文件只回显时间，不写部门条件（DEC-810①）', async () => {
    const cases = [
      { code: 'institution', query: `${AS_OF}&year=2026&month=3` },
      { code: 'institution', query: `${AS_OF}&year=2026&month=3&departmentId=${w.A.id}` },
      { code: 'institution', query: `${AS_OF}&year=2026&month=4&departmentId=${w.B.id}` },
    ];
    for (const { code, query } of cases) {
      const page = table(await c.report(code, query), code);
      const { book } = await download(code, query, 'data');
      const month = /month=(\d+)/.exec(query)![1];
      expect(valueAt(book, 'C2'), query).toBe(`月份：${month}`);
      page.rows.forEach((row, index) => {
        expect(valueAt(book, `B${4 + index}`), query).toBe(row.label);
        expect(cellsAt(book, 4 + index).slice(0, 4), query).toEqual(KEYS.slice(0, 4).map((key) => row.cells[key]));
      });
      expect(cellsAt(book, 4 + page.rows.length).slice(0, 4), `${query} 合计`).toEqual(
        KEYS.slice(0, 4).map((key) => page.summary.cells[key]),
      );
      // 文件里所有文字 = 标题 + 时间筛选值 + 表头 + 页面上的一级机构名 + 合计 + 页脚；没有任何部门条件
      expect(stringsOf(book), query).toEqual(
        [
          '各机构入离职统计',
          '年份：2026',
          `月份：${month}`,
          '一级机构',
          ...HEADER,
          ...page.rows.map((row) => row.label),
          '合计',
          `填报人：${exporter}`,
          `填报日期：${TODAY}`,
          NOTE,
        ]
          .filter((text, index, all) => all.indexOf(text) === index)
          .sort(),
      );
    }
    // 各月：换年份后标题年份与 12 个月都跟着变
    const monthly = table(await c.report('monthly', `${AS_OF}&year=2025`), 'monthly');
    const { book } = await download('monthly', `${AS_OF}&year=2025&departmentId=${w.A.id}`, 'data');
    expect(valueAt(book, 'C1')).toBe(2025);
    expect(valueAt(book, 'B3')).toBe('2025-01');
    expect(stringsOf(book).filter((text) => text.includes(w.A.id))).toEqual([]);
    const filtered = table(await c.report('monthly', `${AS_OF}&year=2025&departmentId=${w.A.id}`), 'monthly');
    filtered.rows.forEach((row, index) => expectLikePage(cellsAt(book, 3 + index), row.cells, row.key));
    expect(monthly.rows).toHaveLength(12);
  });

  it('AC-HA-F482-04：两种下载方式——数据版 0 个公式；公式版离职率是 IFERROR、合计 / 月均是 SUM / AVERAGE，结果与数据版一致', async () => {
    const monthlyQuery = `${AS_OF}&year=2026`;
    const [data, formula] = [
      (await download('monthly', monthlyQuery, 'data')).book,
      (await download('monthly', monthlyQuery, 'formula')).book,
    ];
    expect(formulaCells(data)).toEqual([]);
    expectModesEqual(data, formula);
    const texts = formulaCells(formula).map(([ref, cell]) => [ref, cell.formula]);
    // 1～10 月各一个离职率（11、12 月留空不写公式）+ 月均行 4 个 AVERAGE 与 1 个离职率
    expect(texts.filter(([, text]) => String(text).startsWith('IFERROR('))).toHaveLength(11);
    expect(texts.filter(([, text]) => String(text).startsWith('AVERAGE('))).toHaveLength(4);
    expect(Object.fromEntries(texts)).toMatchObject({
      G3: 'IFERROR(E3/(C3+F3)*2,0)',
      G15: 'IFERROR(E15/(C15+F15)*2,0)',
      C15: 'AVERAGE(C3:C14)',
    });
    expect(formula.hiddenRows).toEqual([]);
    expect(formula.hiddenColumns).toEqual([]);

    const institutionQuery = `${AS_OF}&year=2026&month=4`;
    const rows = table(await c.report('institution', institutionQuery), 'institution').rows.length;
    const [plain, withFormula] = [
      (await download('institution', institutionQuery, 'data')).book,
      (await download('institution', institutionQuery, 'formula')).book,
    ];
    expect(formulaCells(plain)).toEqual([]);
    expectModesEqual(plain, withFormula);
    const total = 4 + rows;
    expect(Object.fromEntries(formulaCells(withFormula).map(([ref, cell]) => [ref, cell.formula]))).toMatchObject({
      G4: 'IFERROR(E4/(C4+F4)*2,0)',
      [`C${total}`]: `SUM(C4:C${total - 1})`,
      [`F${total}`]: `SUM(F4:F${total - 1})`,
      [`G${total}`]: `IFERROR(E${total}/(C${total}+F${total})*2,0)`,
    });
    expect(formulaCells(withFormula)).toHaveLength(rows + 1 + 4);
  });

  it('AC-HA-F482-05：管理单元范围——只导出范围内的行，逐行等于同参数的页面；选范围外组织得全 0，不报错也不越权', async () => {
    const scope = managementScope(w.tenantId, [w.A.id, w.A1.id, w.B.id]);
    const limited = movementClient(w.db, w.who, restrictedAuthorizer({ scope }));

    const monthlyQuery = `${AS_OF}&year=2026`;
    const monthly = table(await limited.report('monthly', monthlyQuery), 'monthly');
    const { book } = await download('monthly', monthlyQuery, 'data', limited);
    monthly.rows.forEach((row, index) => expectLikePage(cellsAt(book, 3 + index), row.cells, row.key));
    expect(valueAt(book, 'E10')).toBe(0); // 8 月：范围外部门 8/31 的离职不计（全范围这一格是 1）
    expect(valueAt(book, 'E3')).toBe(1);
    const all = (await download('monthly', monthlyQuery, 'data')).book;
    expect(valueAt(all, 'E10')).toBe(1);

    const query = `${AS_OF}&year=2026&month=8`;
    const institution = table(await limited.report('institution', query), 'institution');
    const file = (await download('institution', query, 'data', limited)).book;
    expect(institution.rows.map((row) => row.key).sort()).toEqual([w.A.id, w.B.id].sort());
    institution.rows.forEach((row, index) => expect(valueAt(file, `B${4 + index}`)).toBe(row.label));
    expect(stringsOf(file)).not.toContain('范围外部');
    expect(stringsOf((await download('institution', query, 'data')).book)).toContain('范围外部');

    // 部门筛选选了范围外组织：200，没有数据行，合计全 0
    const outside = `${query}&departmentId=${w.H.id}`;
    const outsidePage = table(await limited.report('institution', outside), 'institution');
    const outsideFile = (await download('institution', outside, 'data', limited)).book;
    expect(outsidePage.rows).toEqual([]);
    expect(cellsAt(outsideFile, 4).slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(valueAt(outsideFile, 'B4')).toBe('合计');
    expect(valueAt(outsideFile, 'G4')).toBe(0);

    // 空范围（默认）fail-closed：不退回“全部”，只有合计 0
    const empty = movementClient(w.db, w.who, restrictedAuthorizer({ scope: { ...EMPTY_SCOPE } }));
    const emptyFile = (await download('institution', query, 'data', empty)).book;
    expect(valueAt(emptyFile, 'B4')).toBe('合计');
    expect(cellsAt(emptyFile, 4).slice(0, 4)).toEqual([0, 0, 0, 0]);
  });

  it('AC-HA-F482-06：每次成功导出记一条对象操作日志（谁、何时、哪张报表、哪种下载方式、筛选摘要）；失败的导出不记成功', async () => {
    const logs = () => exportLogs(w.db, w.tenantId, HR_MOVEMENT_REPORT_OBJECT);
    const before = await logs();
    const query = `${AS_OF}&year=2026&month=4&departmentId=${w.A.id}`;
    await download('institution', query, 'data');
    await download('monthly', `${AS_OF}&year=2025`, 'formula');
    // 读页面不记导出日志
    await c.report('institution', query);
    // 测试时钟固定，日志没有稳定的先后；按内容做多重集差，取本用例新增的两条
    const written = newRows(before, await logs());
    expect(written).toHaveLength(2);
    const logOf = (code: string) => written.find((row) => row.object_id === code)!;
    const institution = logOf('institution');
    const monthly = logOf('monthly');
    expect(institution).toMatchObject({
      actor_user_id: w.who.user,
      behavior: 'export',
      object_type: HR_MOVEMENT_REPORT_OBJECT,
      object_id: 'institution',
      result: 'succeeded',
      total_count: 1,
    });
    expect(institution.summary).toContain('各机构入离职统计');
    expect(institution.attachment).toMatchObject({
      fileName: '各机构入离职统计.xlsx',
      mode: 'data',
      filter: { asOf: '2026-10-06', year: 2026, month: 4, departmentId: w.A.id },
    });
    expect(String((institution.attachment as { note?: string }).note)).toContain('原站未测、按复刻口径实现');
    expect(institution.occurred_at).toBeTruthy();
    expect(monthly).toMatchObject({ object_id: 'monthly', behavior: 'export' });
    expect(monthly.attachment).toMatchObject({ fileName: '各月入离职统计.xlsx', mode: 'formula' });
    // 审计筛选摘要 = 实际生效的筛选项，不多不少（审查 P2-1 顺带核对：两张入离职统计没有漏项）
    expect((institution.attachment as { filter: unknown }).filter).toEqual({
      asOf: '2026-10-06',
      year: 2026,
      month: 4,
      departmentId: w.A.id,
    });
    expect((monthly.attachment as { filter: unknown }).filter).toEqual({
      asOf: '2026-10-06',
      year: 2025,
      departmentId: null,
    });

    // 失败的导出（下载方式缺失 / 非法、报表没有导出、参数非法、没有查看权）一条都不记
    const count = async () => (await logs()).length;
    const settled = await count();
    const bad: [string, number, typeof c?][] = [
      [`${BASE}/reports/monthly/export?${AS_OF}`, 400],
      [exportPath(BASE, 'monthly', AS_OF, 'pdf'), 400],
      [exportPath(BASE, 'institution', `${AS_OF}&year=2026&month=13`, 'data'), 400],
      [exportPath(BASE, 'flow', AS_OF, 'data'), 404],
      [exportPath(BASE, 'unknown', AS_OF, 'data'), 404],
      [
        exportPath(BASE, 'monthly', AS_OF, 'data'),
        403,
        movementClient(w.db, w.who, restrictedAuthorizer({ deny: HR_MOVEMENT_REPORT_OBJECT })),
      ],
    ];
    for (const [path, status, client] of bad) expect((await (client ?? c).get(path)).status, path).toBe(status);
    expect(await count()).toBe(settled);
  });

  it('AC-HA-F482-07：能看就能导出（只认报表对象的查看权，不新增授权项）；缺租户头 / 跨租户 / 无身份一律拒绝，与页面接口同状态', async () => {
    const path = exportPath(BASE, 'institution', `${AS_OF}&year=2026&month=4`, 'data');
    const page = `${BASE}/reports/institution?${AS_OF}&year=2026&month=4`;

    // 只放行“报表对象的查看”，其余动作一概拒绝：页面能打开，导出（两种方式）也能下载 → 导出没有另要按钮 / 下载授权项
    const onlyView: Authorizer = (request) =>
      request.action === 'object.view' && request.resource === HR_MOVEMENT_REPORT_OBJECT;
    registerScopeProvider(onlyView, {
      scope: async () => ({ ...EMPTY_SCOPE, all: true, hasDataPermission: true }),
      authorize: async (request) => onlyView(request),
      fields: async () => new Set(),
    });
    const viewer = movementClient(w.db, w.who, onlyView);
    expect((await viewer.get(page)).status).toBe(200);
    for (const mode of ['data', 'formula'] as const)
      expect((await viewer.get(exportPath(BASE, 'institution', `${AS_OF}&year=2026&month=4`, mode))).status).toBe(200);
    // 没有报表对象的查看权 → 403；只有看板对象的查看权不够（两个对象互不放行）
    const denied = movementClient(w.db, w.who, restrictedAuthorizer({ deny: HR_MOVEMENT_REPORT_OBJECT }));
    expect((await denied.get(page)).status).toBe(403);
    expect((await denied.get(path)).status).toBe(403);

    const api = tenantApi(w.db, { clock: () => new Date(`${TODAY}T01:00:00Z`) });
    const calls: [string, { user?: string; tenant?: string }][] = [
      ['缺租户头', { user: w.who.user }],
      ['跨租户', { user: w.who.user, tenant: randomUUID() }],
      ['无身份', { tenant: w.who.tenant }],
    ];
    for (const [label, headers] of calls) {
      const pageStatus = (await api.request('GET', page, headers)).status;
      const exportStatus = (await api.request('GET', path, headers)).status;
      expect(exportStatus, `${label} 导出`).toBe(pageStatus);
      expect([400, 401, 403, 404], `${label} 状态`).toContain(exportStatus);
    }
  });
});
