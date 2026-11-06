/**
 * F-482 / DEC-803②、DEC-809、DEC-810：员工素质结构报表的 xlsx 导出。
 * 原站取证（evidence §4）：标题「员工素质结构统计」B1:X1（23 列）、两级表头靠合并单元格（一级组织 / 序号 / 合计 / 平均司龄 /
 * 平均年龄纵向合并，性别 / 学历 / 司龄段 / 年龄段横向合并）、「合计」行（序号列空）、页脚说明 B～J 合并；
 * 数值不取整；含公式版 19 个公式（合计行的 19 个计数列），平均值不是可加的，不写公式。
 * 固定夹具沿用 BE-13a 员工结构（asOf = 2026-10-01）：机构A（甲、乙）、部门B（丙、丁）、实习生戊在机构A；期望值手写。
 */
import { eq, users, withPlatform } from '@italent/db';
import { HR_STRUCTURE_REPORT_OBJECT } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  boardClient,
  managementScope,
  restrictedAuthorizer,
  STRUCTURE_BASE as BASE,
  structureWorld,
  TODAY,
  type BoardClient,
  type Report,
} from './AC-HA-13a-support.js';
import {
  downloadXlsx,
  exportLogs,
  exportPath,
  expectModesEqual,
  newRows,
  refOf,
  stringsOf,
} from './AC-HA-F482-support.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { formulaCells, valueAt, type Xlsx } from './support/xlsx-read.js';
import { tenantApi } from './support/tenant-api.js';
import { randomUUID } from 'node:crypto';

const database = useTestDb();
const AS_OF = 'asOf=2026-10-01';
const FILE = '员工素质结构.xlsx';
const COLUMNS = 'DEFGHIJKLMNOPQRSTUVWX'.split(''); // 合计 … 平均年龄，与页面 21 列一一对应
const COUNT_COLUMNS = COLUMNS.filter((column) => !['Q', 'X'].includes(column)); // 19 个计数列

async function buildWorld() {
  const w = await structureWorld(database().db, 'f482-quality');
  const a = await w.org('机构A', undefined, '机构');
  const a1 = await w.org('部门A1', a);
  const b = await w.org('部门B');
  await w.hire('导出甲', {
    date: '2026-04-01',
    department: a1,
    profile: { gender: '男', birthday: '2001-10-01', educationLevel: '本科' },
  });
  await w.hire('导出乙', {
    date: '2025-10-01',
    department: a,
    profile: { gender: '女', birthday: '1996-10-01', educationLevel: '硕士' },
    probationMonths: 6,
  });
  await w.hire('导出丙', { date: '2026-04-02', department: b, profile: { gender: '保密', birthday: '1975-10-01' } });
  await w.hire('导出丁', { date: '2015-10-01', department: b, profile: { educationLevel: '大专' } });
  await w.hire('导出实习', {
    date: '2026-01-01',
    department: a1,
    profile: { gender: '男', birthday: '2004-01-01', educationLevel: '本科' },
    fields: { employType: 'intern' },
  });
  return { w, a, a1, b };
}
type World = Awaited<ReturnType<typeof buildWorld>>;

const rowOf = (book: Xlsx, row: number) => COLUMNS.map((column) => valueAt(book, `${column}${row}`));
/** 一行等于页面：计数列相等；平均司龄 / 平均年龄页面取整到 1 位，文件是不取整的值，差不超过 0.05。 */
function expectRow(book: Xlsx, row: number, page: Report, cells: Record<string, number | null>, label: string) {
  page.columns.forEach((column, index) => {
    const actual = valueAt(book, `${COLUMNS[index]}${row}`);
    if (column.key === 'avgTenure' || column.key === 'avgAge') {
      if (cells[column.key] === null) expect(actual, `${label} ${column.key}`).toBeUndefined();
      else
        expect(Math.abs((actual as number) - cells[column.key]!), `${label} ${column.key}`).toBeLessThanOrEqual(
          0.05 + 1e-9,
        );
    } else expect(actual, `${label} ${column.key}`).toBe(cells[column.key] ?? undefined);
  });
}

describe('AC-HA-F482 员工素质结构报表导出', () => {
  let x: World;
  let c: BoardClient;
  let exporter = '';
  beforeAll(async () => {
    x = await buildWorld();
    c = boardClient(database().db, x.w.who);
    const [user] = await withPlatform(x.w.db, (tx) => tx.select().from(users).where(eq(users.id, x.w.who.user)));
    exporter = user!.displayName;
  }, 300_000);

  const download = (query: string, mode: 'data' | 'formula', client = c) =>
    downloadXlsx(client.get, exportPath(BASE, 'quality', query, mode), FILE);

  it('AC-HA-F482-08：文件结构——Sheet1、标题 B1:X1、两级表头合并、一级组织行（序号从 1）、合计行（序号空）、页脚；平均值不取整', async () => {
    const page = await c.report('quality', AS_OF);
    const { book } = await download(AS_OF, 'data');

    expect(book.sheetNames).toEqual(['Sheet1']);
    expect(valueAt(book, 'B1')).toBe('员工素质结构统计');
    expect(book.merges).toEqual(
      expect.arrayContaining([
        'B1:X1',
        'B2:B3',
        'C2:C3',
        'D2:D3',
        'E2:F2',
        'G2:J2',
        'K2:P2',
        'Q2:Q3',
        'R2:W2',
        'X2:X3',
      ]),
    );
    expect([...book.cells.keys()].some((ref) => ref.startsWith('A'))).toBe(false);
    const top = Object.fromEntries(
      ['B', 'C', 'D', 'E', 'G', 'K', 'Q', 'R', 'X'].map((l) => [l, valueAt(book, `${l}2`)]),
    );
    expect(top).toEqual({
      B: '一级组织',
      C: '序号',
      D: '合计',
      E: '性别',
      G: '学历',
      K: '司龄段',
      Q: '平均司龄',
      R: '年龄段',
      X: '平均年龄',
    });
    expect(COLUMNS.slice(1, 6).map((column) => valueAt(book, `${column}3`))).toEqual([
      '男',
      '女',
      '博士',
      '硕士',
      '本科',
    ]);
    expect(valueAt(book, 'J3')).toBe('大专及以下');
    expect('KLMNOP'.split('').map((column) => valueAt(book, `${column}3`))).toEqual([
      '6月以下',
      '6月~1年',
      '1~2年',
      '2~5年',
      '5~10年',
      '10年及以上',
    ]);
    expect('RSTUVW'.split('').map((column) => valueAt(book, `${column}3`))).toEqual([
      '25岁以下',
      '25-30岁',
      '31-35岁',
      '36-40岁',
      '41-50岁',
      '51岁及以上',
    ]);

    // 一级组织行逐行等于页面；序号从 1 起；手写：机构A 合计 2（男 1 女 1，硕士 1 本科 1）
    // 行序以页面为准（页面按组织顺序号排，不是名称顺序）；手写断言按名称找到机构A所在行
    expect(page.rows.map((row) => row.organizationName).sort()).toEqual(['机构A', '部门B']);
    const a = 4 + page.rows.findIndex((row) => row.organizationName === '机构A');
    page.rows.forEach((row, index) => {
      expect(valueAt(book, `B${4 + index}`)).toBe(row.organizationName);
      expect(valueAt(book, `C${4 + index}`)).toBe(index + 1);
      expectRow(book, 4 + index, page, row.cells, row.organizationName);
    });
    expect(rowOf(book, a).slice(0, 7)).toEqual([2, 1, 1, 0, 1, 1, 0]);
    // 平均司龄 / 平均年龄不取整：机构A 平均司龄 (0.5 + 1.0) / 2 = 0.75（页面显示 0.8）；合计平均年龄 106 / 3（页面显示 35.3）
    expect(valueAt(book, `Q${a}`) as number).toBeCloseTo(0.75, 10);
    expect(Math.abs((valueAt(book, `Q${a}`) as number) - 0.8)).toBeGreaterThan(0.02);
    expect(valueAt(book, `X${a}`)).toBe(27.5);

    const total = 4 + page.rows.length;
    expect(valueAt(book, `B${total}`)).toBe('合计');
    expect(book.cells.has(`C${total}`)).toBe(false);
    page.columns.forEach((column, index) => {
      if (column.key === 'avgTenure' || column.key === 'avgAge') return;
      expect(valueAt(book, `${COLUMNS[index]}${total}`), `合计 ${column.key}`).toBe(page.summary.cells[column.key]);
    });
    expect(valueAt(book, `Q${total}`) as number).toBeCloseTo(3.225, 10);
    expect(valueAt(book, `X${total}`) as number).toBeCloseTo(106 / 3, 10);

    expect(valueAt(book, refOf(book, '填报人：'))).toBe(`填报人：${exporter}`);
    expect(valueAt(book, refOf(book, '填报日期：'))).toBe(`填报日期：${TODAY}`);
    const note = refOf(book, '司龄段统计规则为向下包含');
    expect(book.merges).toContain(`B${note.slice(1)}:J${note.slice(1)}`);
    expect(book.hiddenRows).toEqual([]);
    expect(book.hiddenColumns).toEqual([]);
  });

  it('AC-HA-F482-09：页面筛选带进导出——雇佣关系 / 部门 / 时点；文件不写部门条件，也没有序号错位', async () => {
    for (const query of [
      `${AS_OF}&employType=all`,
      `${AS_OF}&employType=intern`,
      `${AS_OF}&departmentId=${x.a.id}`,
      `${AS_OF}&departmentId=${x.b.id}&employType=all`,
      'asOf=2026-03-31',
    ]) {
      const page = await c.report('quality', query);
      const { book } = await download(query, 'data');
      page.rows.forEach((row, index) => {
        expect(valueAt(book, `B${4 + index}`), query).toBe(row.organizationName);
        expect(valueAt(book, `C${4 + index}`), query).toBe(index + 1);
        expectRow(book, 4 + index, page, row.cells, query);
      });
      const total = 4 + page.rows.length;
      expect(valueAt(book, `D${total}`), `${query} 合计`).toBe(page.summary.cells.total);
      // 文件里的文字只有标题、表头、一级组织名、合计与页脚：没有部门 / 雇佣关系条件
      const text = stringsOf(book);
      expect(
        text.filter((item) => item.includes(x.a.id) || item.includes(x.b.id) || item.includes('内部员工')),
      ).toEqual([]);
      expect(text.filter((item) => item.includes('部门：') || item.includes('雇佣关系'))).toEqual([]);
    }
    const intern = await download(`${AS_OF}&employType=intern`, 'data');
    expect(valueAt(intern.book, 'D5')).toBe(1);
  });

  it('AC-HA-F482-10：两种下载方式——数据版 0 个公式；公式版合计行 19 个 SUM（平均值不写公式），结果与数据版一致', async () => {
    const data = (await download(AS_OF, 'data')).book;
    const formula = (await download(AS_OF, 'formula')).book;
    expect(formulaCells(data)).toEqual([]);
    expectModesEqual(data, formula);
    const rows = (await c.report('quality', AS_OF)).rows.length;
    const total = 4 + rows;
    const formulas = Object.fromEntries(formulaCells(formula).map(([ref, cell]) => [ref, cell.formula]));
    expect(Object.keys(formulas).sort()).toEqual(COUNT_COLUMNS.map((column) => `${column}${total}`).sort());
    expect(formulas).toMatchObject({ [`D${total}`]: `SUM(D4:D${total - 1})`, [`W${total}`]: `SUM(W4:W${total - 1})` });
    expect(formula.hiddenRows).toEqual([]);
    expect(formula.hiddenColumns).toEqual([]);

    // 没有数据行时没有可求和的区域：合计行写 0 的数值，不写 SUM(D4:D3) 这类无效公式
    const none = (await download(`${AS_OF}&departmentId=${x.b.id}&employType=intern`, 'formula')).book;
    expect(formulaCells(none)).toEqual([]);
    expect(valueAt(none, 'B4')).toBe('合计');
    expect(valueAt(none, 'D4')).toBe(0);
  });

  it('AC-HA-F482-11：管理单元范围——只导出范围内的一级组织行，逐行等于同参数的页面；选范围外组织得全 0；空范围 fail-closed', async () => {
    const scope = managementScope(x.w.tenantId, [x.a.id, x.a1.id]);
    const limited = boardClient(x.w.db, x.w.who, restrictedAuthorizer({ scope }));
    const page = await limited.report('quality', AS_OF);
    const { book } = await download(AS_OF, 'data', limited);
    expect(page.rows.map((row) => row.organizationName)).toEqual(['机构A']);
    expectRow(book, 4, page, page.rows[0]!.cells, '机构A');
    expect(valueAt(book, 'B5')).toBe('合计');
    expect(valueAt(book, 'D5')).toBe(2);
    expect(stringsOf(book)).not.toContain('部门B');

    const outside = `${AS_OF}&departmentId=${x.b.id}`;
    const outsidePage = await limited.report('quality', outside);
    const outsideFile = (await download(outside, 'data', limited)).book;
    expect(outsidePage.rows).toEqual([]);
    expect(valueAt(outsideFile, 'B4')).toBe('合计');
    expect(rowOf(outsideFile, 4).filter((_, i) => i !== 13 && i !== 20)).toEqual(new Array(19).fill(0));

    const empty = boardClient(x.w.db, x.w.who, restrictedAuthorizer({ scope: { ...EMPTY_SCOPE } }));
    const emptyFile = (await download(AS_OF, 'data', empty)).book;
    expect(valueAt(emptyFile, 'B4')).toBe('合计');
    expect(valueAt(emptyFile, 'D4')).toBe(0);
  });

  it('AC-HA-F482-12：成功导出记一条对象操作日志（谁、何时、哪张报表、下载方式、筛选摘要）；失败的导出不记成功；不是报表的页签 404', async () => {
    const logs = () => exportLogs(x.w.db, x.w.tenantId, HR_STRUCTURE_REPORT_OBJECT);
    const before = await logs();
    const query = `${AS_OF}&employType=all&departmentId=${x.a.id}`;
    await download(query, 'formula');
    await c.report('quality', query);
    const written = newRows(before, await logs());
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      actor_user_id: x.w.who.user,
      behavior: 'export',
      object_type: HR_STRUCTURE_REPORT_OBJECT,
      object_id: 'quality',
      result: 'succeeded',
      total_count: 1,
    });
    expect(written[0]!.summary).toContain('员工素质结构');
    expect(written[0]!.attachment).toMatchObject({
      fileName: FILE,
      mode: 'formula',
      filter: { asOf: '2026-10-01', employType: 'all', departmentId: x.a.id },
    });
    expect(String((written[0]!.attachment as { note?: string }).note)).toContain('原站未测、按复刻口径实现');

    const settled = (await logs()).length;
    const denied = boardClient(x.w.db, x.w.who, restrictedAuthorizer({ deny: HR_STRUCTURE_REPORT_OBJECT }));
    const bad: [string, number, BoardClient?][] = [
      [`${BASE}/reports/quality/export?${AS_OF}`, 400],
      [exportPath(BASE, 'quality', AS_OF, 'csv'), 400],
      [exportPath(BASE, 'quality', `${AS_OF}&employType=external`, 'data'), 400],
      [exportPath(BASE, 'quality', `${AS_OF}&departmentId=bad`, 'data'), 400],
      [exportPath(BASE, 'position', AS_OF, 'data'), 404],
      [exportPath(BASE, 'unknown', AS_OF, 'data'), 404],
      [exportPath(BASE, 'quality', AS_OF, 'data'), 403, denied],
    ];
    for (const [path, status, client] of bad) expect((await (client ?? c).get(path)).status, path).toBe(status);
    expect((await logs()).length).toBe(settled);
  });

  it('AC-HA-F482-14：“包含下级”开关（true / false / 缺省）取数范围不同，文件人数与审计筛选摘要都要区分（审查 P2-1）', async () => {
    const logs = () => exportLogs(x.w.db, x.w.tenantId, HR_STRUCTURE_REPORT_OBJECT);
    // 机构A 本级 1 人（导出乙）、下级部门A1 内部员工 1 人（导出甲）；实习生默认不计
    const cases: [string, number, boolean][] = [
      ['departmentIncludeChildren=true', 2, true],
      ['departmentIncludeChildren=false', 1, false],
      ['', 2, true], // 缺省 = 勾选
    ];
    for (const [flag, people, effective] of cases) {
      const query = [AS_OF, `departmentId=${x.a.id}`, flag].filter(Boolean).join('&');
      const before = await logs();
      const { book } = await download(query, 'data');
      const page = await c.report('quality', query);
      expect(page.summary.cells.total, `${query} 页面人数`).toBe(people);
      expect(valueAt(book, `D${4 + page.rows.length}`), `${query} 文件合计人数`).toBe(people);
      const written = newRows(before, await logs());
      expect(written, query).toHaveLength(1);
      expect((written[0]!.attachment as { filter: unknown }).filter, `${query} 审计筛选摘要`).toEqual({
        asOf: '2026-10-01',
        employType: 'internal',
        departmentId: x.a.id,
        departmentIncludeChildren: effective,
      });
    }
    // 没选部门时开关不起作用，但摘要仍写出实际生效值，口径固定
    const before = await logs();
    await download(AS_OF, 'data');
    const [written] = newRows(before, await logs());
    expect((written!.attachment as { filter: unknown }).filter).toEqual({
      asOf: '2026-10-01',
      employType: 'internal',
      departmentId: null,
      departmentIncludeChildren: true,
    });
  });

  it('AC-HA-F482-13：缺租户头 / 跨租户 / 无身份一律拒绝，与页面接口同状态', async () => {
    const path = exportPath(BASE, 'quality', AS_OF, 'data');
    const page = `${BASE}/reports/quality?${AS_OF}`;
    const api = tenantApi(x.w.db, { clock: () => new Date(`${TODAY}T01:00:00Z`) });
    const calls: [string, { user?: string; tenant?: string }][] = [
      ['缺租户头', { user: x.w.who.user }],
      ['跨租户', { user: x.w.who.user, tenant: randomUUID() }],
      ['无身份', { tenant: x.w.who.tenant }],
    ];
    for (const [label, headers] of calls) {
      const exportStatus = (await api.request('GET', path, headers)).status;
      expect(exportStatus, label).toBe((await api.request('GET', page, headers)).status);
      expect([400, 401, 403, 404], label).toContain(exportStatus);
    }
  });
});
