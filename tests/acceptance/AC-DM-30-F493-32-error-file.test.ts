/**
 * AC-DM-30-F493-32/34/39/43：历史离职导入的错误文件与模板下载（S3c，设计 §8.2、§8.3、§3.1）。
 * 读写租户数据一律走 withTenant（x.q），app_owner 普通角色可过（DEC-568）。期望值手写，不拿被测实现的构造函数当参照。
 */
import './support/exit-gate-enforced.js';
import { createUser } from '@italent/db';
import { exitImportErrorText } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { H, importWorld, type ImportWorld } from './AC-DM-30-support.js';
import { importOperator } from './support/exit-import-operator.js';
import { cmd } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';
import { readXlsx, valueAt, type Xlsx } from './support/xlsx-read.js';

const database = useTestDb();
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 设计 §3.1 的 26 个列名（含「*」），手写。 */
const COLUMN_NAMES = [
  '导入结果',
  '*姓名',
  '*电子邮件',
  '*部门编码',
  '*入职日期',
  '职位名称',
  '职务名称',
  '职级',
  '参加工作日期',
  '工作地点',
  '身份证号',
  '手机号码',
  '个人邮箱',
  '性别',
  '出生日期',
  '民族',
  '政治面貌',
  '户籍所在地',
  '籍贯',
  '毕业学校',
  '专业',
  '*最后工作日',
  '离职类型',
  '离职原因',
  '离职后去向',
  '离职说明',
];
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

async function bookOf(response: Response, fileName: string): Promise<Xlsx> {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get('content-type')).toContain(XLSX_TYPE);
  expect(decodeURIComponent(response.headers.get('content-disposition') ?? '')).toContain(fileName);
  return readXlsx(Buffer.from(await response.arrayBuffer()));
}

const errorFile = (x: ImportWorld, batchId: string) =>
  x.session.request('GET', `/exits/import/batches/${batchId}/error-file`);

function expectHeaderRow(book: Xlsx) {
  LETTERS.forEach((letter, index) => expect(valueAt(book, `${letter}1`), `${letter}1`).toBe(COLUMN_NAMES[index]));
}

/** 数据行数：第 1 行之后 A 列有值的行。 */
const dataRows = (book: Xlsx) => [...book.cells.keys()].filter((ref) => /^A\d+$/.test(ref) && ref !== 'A1').length;

describe('AC-DM-30-F493-32 错误文件结构', () => {
  it('4 行批次：3 个数据行按 rowNo 排序，A 列为错误原文，其余为原始值，全部是文本', async () => {
    const db = database().db;
    const x = await importWorld(db, '32');
    const d = await x.dept('错误文件部门');
    const taken = `syn.taken.${uniqueSuffix()}@example.com`;
    await createUser(db, { email: taken, displayName: '合成他租户账号' }, cmd());
    const batchId = await x.imported([
      x.row(1, 'zzf496nope'),
      x.row(2, d.code, { name: null, entryDate: '2023/3/1' }),
      x.row(3, d.code, { email: taken }),
      x.row(4, d.code),
    ]);
    const batch = await x.batchOf(batchId);
    expect(batch).toMatchObject({ status: 'completed', created_count: 2, error_row_count: 3, error_count: 3 });

    const book = await bookOf(await errorFile(x, batchId), '下载导入错误报告.xlsx');
    expectHeaderRow(book);
    expect(dataRows(book)).toBe(3);
    expect(valueAt(book, 'A2')).toBe('[*部门编码]：*部门编码【zzf496nope】不存在或者已被删除，请检查');
    expect(String(valueAt(book, 'A3'))).toContain('[*姓名]：*姓名不能为空');
    expect(valueAt(book, 'E3')).toBe('2023/03/01');
    expect(valueAt(book, 'A4')).toBe('[*电子邮件]：当前邮箱已被使用，请更换邮箱');
    // 其余列是原始值，按 rowNo 排序
    expect(valueAt(book, 'B2')).toBe('合成甲');
    expect(valueAt(book, 'C2')).toBe('syn.r1.32@example.com');
    expect(valueAt(book, 'D2')).toBe('zzf496nope');
    expect(valueAt(book, 'E2')).toBe(H.replaceAll('-', '/'));
    expect(valueAt(book, 'C4')).toBe(taken);
    expect(valueAt(book, 'D3')).toBe(d.code);
    expect(book.cells.has('B3')).toBe(false); // 空值不写单元格
    // 成功行不在文件里
    expect([...book.cells.values()].some((cell) => cell.value === 'syn.r4.32@example.com')).toBe(false);
    // 所有单元格是文本，不是公式
    for (const [ref, cell] of book.cells) {
      expect(cell.type, ref).toBe('s');
      expect(cell.formula, ref).toBeUndefined();
    }
  });

  it('批次未结束 409 EXIT_IMPORT_NOT_FINISHED；没有错误 404 EXIT_IMPORT_NO_ERROR_FILE；他人的批次 404', async () => {
    const x = await importWorld(database().db, '32-state');
    const d = await x.dept('状态部门');
    const clean = await x.imported([x.row(1, d.code)]);
    const none = await errorFile(x, clean);
    expect(none.status).toBe(404);
    expect((await x.errorOf(none)).details?.reason).toBe('EXIT_IMPORT_NO_ERROR_FILE');

    const bad = await x.imported([x.row(1, 'zzf496nope')]);
    await x.q(x.sql`UPDATE exit_import_batches SET status='running', lease_until = now() + interval '1 hour'
      WHERE tenant_id=${x.tenantId} AND id=${bad}::uuid`);
    const running = await errorFile(x, bad);
    expect(running.status).toBe(409);
    expect((await x.errorOf(running)).details?.reason).toBe('EXIT_IMPORT_NOT_FINISHED');

    const missing = await errorFile(x, '00000000-0000-4000-8000-000000000001');
    expect(missing.status).toBe(404);
  });
});

describe('AC-DM-30-F493-34 错误文件 15 天到期（下载部分）', () => {
  it('expires_at 改到过去：下载 404 EXIT_IMPORT_FILE_EXPIRED（清理前就生效）', async () => {
    const x = await importWorld(database().db, '34');
    const batchId = await x.imported([x.row(1, 'zzf496nope')]);
    expect((await errorFile(x, batchId)).status).toBe(200);
    await x.q(x.sql`UPDATE exit_import_batches SET expires_at = now() - interval '1 second'
      WHERE tenant_id=${x.tenantId} AND id=${batchId}::uuid`);
    const expired = await errorFile(x, batchId);
    expect(expired.status).toBe(404);
    expect((await x.errorOf(expired)).details?.reason).toBe('EXIT_IMPORT_FILE_EXPIRED');
  });
});

describe('AC-DM-30-F493-39 模板下载', () => {
  it('只有第 1 行，26 个列名逐字等于 §3.1，没有数据行和批注；没有导入按钮 403', async () => {
    const x = await importWorld(database().db, '39');
    const book = await bookOf(await x.session.request('GET', '/exits/import/template'), '历史离职人员导入模板.xlsx');
    expectHeaderRow(book);
    expect(book.cells.size).toBe(26);
    expect([...book.cells.keys()].every((ref) => ref.endsWith('1'))).toBe(true);
    expect([...book.entries.keys()].filter((name) => /comments|drawing/i.test(name))).toEqual([]);
  });

  it('没有导入按钮 403，有按钮 200', async () => {
    const without = await importOperator(await importWorld(database().db, '39-nobtn'), { noButton: true });
    expect((await without.get('/exits/import/template')).status).toBe(403);
    const withButton = await importOperator(await importWorld(database().db, '39-btn'));
    expect((await withButton.get('/exits/import/template')).status).toBe(200);
  });
});

describe('AC-DM-30-F493-43 错误条数与错误行数分开（错误文件与操作日志部分）', () => {
  it('11 行批次：错误文件 8 个数据行，末行 A 列按 N、P、Q 顺序以「；」连接；下载写一条 export 操作日志', async () => {
    const x = await importWorld(database().db, '43');
    const d = await x.dept('条数部门');
    const cases: [string | null, string | null, string | null][] = [
      ['男', '汉族', '群众'],
      ['M', null, null],
      ['男性', null, null],
      ['abc', null, null],
      [null, '汉', null],
      [null, 'abc', null],
      [null, null, '党员'],
      [null, null, 'abc'],
      [null, null, null],
      ['女', '回族', '中共党员'],
      ['F', 'Han', '团员'],
    ];
    const batchId = await x.imported(
      cases.map(([gender, nation, politicalStatus], i) => x.row(i + 1, d.code, { gender, nation, politicalStatus })),
    );
    expect(await x.batchOf(batchId)).toMatchObject({ created_count: 3, error_row_count: 8, error_count: 10 });

    const book = await bookOf(await errorFile(x, batchId), '下载导入错误报告.xlsx');
    expect(dataRows(book)).toBe(8);
    const joined = [
      exitImportErrorText('N', 'OPTION_NOT_FOUND', 'F'),
      exitImportErrorText('P', 'OPTION_NOT_FOUND', 'Han'),
      exitImportErrorText('Q', 'OPTION_NOT_FOUND', '团员'),
    ].join('；');
    expect(valueAt(book, 'A9')).toBe(joined);
    expect(String(valueAt(book, 'A9')).split('；')).toHaveLength(3);

    // 收尾日志（计数按行、errorReport 按条）已由 AC-40 断言；这里核对本次下载单独记一条 export 日志
    const logs = await x.q<{ success_count: number; failure_count: number; actor: string }>(x.sql`
      SELECT success_count, failure_count, actor_user_id::text AS actor FROM audit_operation_logs
      WHERE tenant_id=${x.tenantId} AND behavior='export' AND object_id::text=${batchId}`);
    expect(logs).toEqual([{ success_count: 8, failure_count: 0, actor: x.session.user.id }]);
    const finish = await x.q<{ failure_count: number; success_count: number; total_count: number }>(x.sql`
      SELECT failure_count, success_count, total_count FROM audit_operation_logs
      WHERE tenant_id=${x.tenantId} AND object_type='exit-import' AND behavior<>'export'
        AND object_id::text=${batchId}`);
    expect(finish).toEqual([{ failure_count: 8, success_count: 3, total_count: 11 }]);
  });
});
