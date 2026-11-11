/**
 * AC-DM-30-F493-42（及 AC-34 的原文件时效部分）：导入历史的原文件下载（S3d，设计 §8.4、§8.3、DEC-840②）。
 * 原文件 = 由 exit_import_rows 全部行的原始值按模板重建，不是用户上传的原始字节；与错误文件同一权限链。
 * 读写租户数据一律走 withTenant（x.q），app_owner 普通角色可过（DEC-568）。期望值手写。
 */
import './support/exit-gate-enforced.js';
import { createUser } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installExitImportTestHooks,
  purgeExpiredExitImports,
} from '../../apps/api/src/modules/employment/exit-import-worker.js';
import { H, importWorld, L, type ImportWorld } from './AC-DM-30-support.js';
import {
  EMPLOYEE_OBJECT_CODE,
  importOperator,
  PROFILE_OBJECT_CODE,
  RECORD_OBJECT_CODE,
} from './support/exit-import-operator.js';
import { cmd } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';
import { readXlsx, valueAt, type Xlsx } from './support/xlsx-read.js';

const database = useTestDb();
afterEach(() => installExitImportTestHooks(database().db, {}));
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
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
const PHONE = '13800000001';

const sourceFile = (x: ImportWorld, batchId: string) =>
  x.session.request('GET', `/exits/import/batches/${batchId}/source-file`);
const bookOf = async (response: Response): Promise<Xlsx> => {
  expect(response.status, await response.clone().text()).toBe(200);
  return readXlsx(Buffer.from(await response.arrayBuffer()));
};

/** 第 2 行：全部 25 列都有手写的原始文本（D 列无效，所以整行 failed；日期写成非规整的 2023/3/1 以区分错误文件）。 */
const FULL_ROW = {
  B: '合成乙',
  C: 'syn.full@example.com',
  D: 'zzf496nope',
  E: '2023/3/1',
  F: '合成职位',
  G: '合成职务',
  H: '合成职级',
  I: '2015-7-1',
  J: '合成地点',
  K: '11010119900101001X',
  L: PHONE,
  M: 'syn.personal@example.com',
  N: '男',
  O: '1990/1/1',
  P: '汉族',
  Q: '群众',
  R: '合成户籍',
  S: '合成籍贯',
  T: '合成学校',
  U: '合成专业',
  V: '2025/6/30',
  W: '合成类型',
  X: '合成原因',
  Y: '合成去向',
  Z: '合成说明',
} as const;

async function threeRowBatch(x: ImportWorld, op?: { submit: (rows: readonly unknown[]) => Promise<Response> }) {
  const db = x.db;
  const d = await x.dept('原文件部门');
  const taken = `syn.taken.${uniqueSuffix()}@example.com`;
  await createUser(db, { email: taken, displayName: '合成他租户账号' }, cmd());
  const rows = [
    x.row(1, d.code, { mobilePhone: PHONE, school: '合成学校', major: '合成专业' }),
    x.row(2, 'zzf496nope', {
      name: FULL_ROW.B,
      email: FULL_ROW.C,
      entryDate: FULL_ROW.E,
      positionName: FULL_ROW.F,
      postName: FULL_ROW.G,
      levelName: FULL_ROW.H,
      workDate: FULL_ROW.I,
      place: FULL_ROW.J,
      idNumber: FULL_ROW.K,
      mobilePhone: FULL_ROW.L,
      personalEmail: FULL_ROW.M,
      gender: FULL_ROW.N,
      birthday: FULL_ROW.O,
      nation: FULL_ROW.P,
      politicalStatus: FULL_ROW.Q,
      householdAddress: FULL_ROW.R,
      registAddress: FULL_ROW.S,
      school: FULL_ROW.T,
      major: FULL_ROW.U,
      lastWorkDate: FULL_ROW.V,
      exitTypeName: FULL_ROW.W,
      exitReasonName: FULL_ROW.X,
      whereaboutsName: FULL_ROW.Y,
      exitNote: FULL_ROW.Z,
    }),
    x.row(3, d.code, { email: taken, mobilePhone: PHONE }),
  ];
  const batchId = op ? await submittedBy(x, op, rows) : await x.imported(rows);
  expect(await x.batchOf(batchId)).toMatchObject({ status: 'completed', created_count: 2, error_row_count: 2 });
  return { batchId, deptCode: d.code, taken };
}

async function submittedBy(
  x: ImportWorld,
  op: { submit: (rows: readonly unknown[]) => Promise<Response> },
  rows: readonly unknown[],
) {
  const response = await op.submit(rows);
  expect(response.status, await response.clone().text()).toBe(202);
  const { batchId } = (await response.json()) as { batchId: string };
  await x.settle();
  return batchId;
}

describe('AC-DM-30-F493-42 原文件内容', () => {
  it('3 行（成功、D 列无效、b 类）完成后：文件名 = 合成导入.xlsx，26 个列名，全部行按 rowNo 排序，A 列全空，B～Z 为提交的原始文本', async () => {
    const x = await importWorld(database().db, '42');
    const { batchId, deptCode, taken } = await threeRowBatch(x);
    const response = await sourceFile(x, batchId);
    expect(response.headers.get('content-type')).toContain(XLSX_TYPE);
    expect(decodeURIComponent(response.headers.get('content-disposition') ?? '')).toContain('合成导入.xlsx');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const book = await readXlsx(Buffer.from(await response.arrayBuffer()));

    LETTERS.forEach((letter, index) => expect(valueAt(book, `${letter}1`), `${letter}1`).toBe(COLUMN_NAMES[index]));
    // A 列整列没有单元格（导入结果留空）；一共 3 个数据行
    expect([...book.cells.keys()].filter((ref) => /^A\d+$/.test(ref))).toEqual(['A1']);
    expect(Math.max(...[...book.cells.keys()].map((ref) => Number(ref.slice(1))))).toBe(4);

    // 第 1 行（成功行）：含成功行的原始值，日期按提交文本原样
    expect(valueAt(book, 'B2')).toBe('合成甲');
    expect(valueAt(book, 'C2')).toBe('syn.r1.42@example.com');
    expect(valueAt(book, 'D2')).toBe(deptCode);
    expect(valueAt(book, 'E2')).toBe(H);
    expect(valueAt(book, 'L2')).toBe(PHONE);
    expect(valueAt(book, 'T2')).toBe('合成学校');
    expect(valueAt(book, 'U2')).toBe('合成专业');
    expect(valueAt(book, 'V2')).toBe(L);
    // 第 2 行（D 列无效）：25 列全部原样，日期不规整成 yyyy/mm/dd
    for (const [letter, value] of Object.entries(FULL_ROW))
      expect(valueAt(book, `${letter}3`), `${letter}3`).toBe(value);
    // 第 3 行（b 类，created_with_error）
    expect(valueAt(book, 'B4')).toBe('合成甲');
    expect(valueAt(book, 'C4')).toBe(taken);
    expect(valueAt(book, 'D4')).toBe(deptCode);
    // 空值不写格
    expect(book.cells.has('F2')).toBe(false);
    expect(book.cells.has('Z4')).toBe(false);
    // 全部是文本，没有公式
    for (const [ref, cell] of book.cells) {
      expect(cell.type, ref).toBe('s');
      expect(cell.formula, ref).toBeUndefined();
    }
  });

  it('提交值以公式前缀开头时仍是文本（不会被表格软件执行）', async () => {
    const x = await importWorld(database().db, '42-formula');
    const d = await x.dept('公式部门');
    const batchId = await x.imported([x.row(1, d.code, { exitNote: '=1+1', place: '@SUM(A1)' })]);
    const book = await bookOf(await sourceFile(x, batchId));
    expect(valueAt(book, 'Z2')).toBe('=1+1');
    expect(valueAt(book, 'J2')).toBe('@SUM(A1)');
    for (const [ref, cell] of book.cells) expect(cell.formula, ref).toBeUndefined();
  });

  it('执行中（屏障暂停）的批次也能下载，且是全部行', async () => {
    const db = database().db;
    const x = await importWorld(db, '42-running');
    const d = await x.dept('执行中部门');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    installExitImportTestHooks(db, { beforeBatch: () => gate });
    const response = await x.submit([1, 2].map((n) => x.row(n, d.code)));
    expect(response.status, await response.clone().text()).toBe(202);
    const { batchId } = (await response.json()) as { batchId: string };
    try {
      const book = await bookOf(await sourceFile(x, batchId));
      expect(valueAt(book, 'C2')).toBe('syn.r1.42-running@example.com');
      expect(valueAt(book, 'C3')).toBe('syn.r2.42-running@example.com');
    } finally {
      release();
    }
    await x.settle();
  });
});

describe('AC-DM-30-F493-42 权限与租户隔离', () => {
  it('同租户另一位有导入权的用户 404；租户 T2 404；不存在的批次 404；非 UUID 400', async () => {
    const db = database().db;
    const x = await importWorld(db, '42-iso');
    const op = await importOperator(x);
    const { batchId } = await threeRowBatch(x, op);
    expect((await op.get(`/exits/import/batches/${batchId}/source-file`)).status).toBe(200);
    expect((await sourceFile(x, batchId)).status).toBe(404); // 世界管理员有全部权限，但不是提交人
    const x2 = await importWorld(db, '42-iso-t2');
    expect((await sourceFile(x2, batchId)).status).toBe(404);
    expect((await sourceFile(x, '00000000-0000-4000-8000-000000000001')).status).toBe(404);
    expect((await sourceFile(x, 'not-a-uuid')).status).toBe(400);
  });

  it('撤提交人档案对象看全部范围 403；撤人员对象 403；只撤任职对象看全部仍 200；没有导入按钮 403', async () => {
    const x = await importWorld(database().db, '42-scope');
    const op = await importOperator(x);
    const { batchId } = await threeRowBatch(x, op);
    const url = `/exits/import/batches/${batchId}/source-file`;
    await op.revokeScope(RECORD_OBJECT_CODE);
    expect((await op.get(url)).status).toBe(200); // DEC-874：任职对象不要求看全部
    await op.reconfigure({ noButton: true });
    expect((await op.get(url)).status).toBe(403);
    await op.reconfigure({});
    expect((await op.get(url)).status).toBe(200);
    await op.revokeScope(PROFILE_OBJECT_CODE);
    expect((await op.get(url)).status).toBe(403);
  });

  it('只撤人员对象看全部：403', async () => {
    const x = await importWorld(database().db, '42-scope-emp');
    const op = await importOperator(x);
    const { batchId } = await threeRowBatch(x, op);
    await op.revokeScope(EMPLOYEE_OBJECT_CODE);
    expect((await op.get(`/exits/import/batches/${batchId}/source-file`)).status).toBe(403);
  });

  it('按当前字段权裁剪：只撤档案 mobilePhone 查看权时 L 列全空，其余列不变', async () => {
    const x = await importWorld(database().db, '42-trim');
    const op = await importOperator(x);
    const { batchId, deptCode } = await threeRowBatch(x, op);
    const url = `/exits/import/batches/${batchId}/source-file`;
    const before = await bookOf(await op.get(url));
    for (const ref of ['L2', 'L3', 'L4']) expect(valueAt(before, ref)).toBe(PHONE);

    await op.reconfigure({ noView: [[PROFILE_OBJECT_CODE, 'mobilePhone']] });
    const after = await bookOf(await op.get(url));
    for (const ref of ['L2', 'L3', 'L4']) expect(after.cells.has(ref), ref).toBe(false);
    expect(valueAt(after, 'D2')).toBe(deptCode);
    expect(valueAt(after, 'K3')).toBe(FULL_ROW.K);
    expect(valueAt(after, 'M3')).toBe(FULL_ROW.M);
  });

  it('按当前字段权裁剪：撤任职 departmentId / effectiveDate 与人员 name，对应列留空；错误原文不出现（A 列本来就空）', async () => {
    const x = await importWorld(database().db, '42-trim2');
    const op = await importOperator(x);
    const { batchId } = await threeRowBatch(x, op);
    await op.reconfigure({
      noView: [
        [RECORD_OBJECT_CODE, 'departmentId'],
        [RECORD_OBJECT_CODE, 'effectiveDate'],
        [EMPLOYEE_OBJECT_CODE, 'name'],
      ],
    });
    const book = await bookOf(await op.get(`/exits/import/batches/${batchId}/source-file`));
    for (const letter of ['B', 'D', 'E'])
      for (const line of [2, 3, 4]) expect(book.cells.has(`${letter}${line}`)).toBe(false);
    expect(valueAt(book, 'C2')).toBe('syn.r1.42-trim2@example.com');
    expect(valueAt(book, 'Z3')).toBe(FULL_ROW.Z);
  });

  it('下载记一条 behavior = export 操作日志（对象为该批次，成功数 = total，操作人 = 提交人）', async () => {
    const x = await importWorld(database().db, '42-log');
    const { batchId } = await threeRowBatch(x);
    await bookOf(await sourceFile(x, batchId));
    const logs = await x.q<{ success_count: number; failure_count: number; actor: string; object_type: string }>(x.sql`
      SELECT success_count, failure_count, actor_user_id::text AS actor, object_type FROM audit_operation_logs
      WHERE tenant_id=${x.tenantId} AND behavior='export' AND object_id::text=${batchId}`);
    expect(logs).toEqual([
      { success_count: 3, failure_count: 0, actor: x.session.user.id, object_type: 'exit-import' },
    ]);
    // 失败的下载（404）不记日志
    await sourceFile(x, '00000000-0000-4000-8000-000000000001');
    const total = await x.q<{ n: string }>(x.sql`SELECT count(*) AS n FROM audit_operation_logs
      WHERE tenant_id=${x.tenantId} AND behavior='export'`);
    expect(Number(total[0]!.n)).toBe(1);
  });
});

describe('AC-DM-30-F493-34 原文件时效', () => {
  it('收尾后到期前成功行原值仍在；expires_at 到期 → 404 EXIT_IMPORT_FILE_EXPIRED（清理前就生效）；清理后同样 404', async () => {
    const x = await importWorld(database().db, '34-src');
    const { batchId } = await threeRowBatch(x);
    expect(valueAt(await bookOf(await sourceFile(x, batchId)), 'C2')).toBe('syn.r1.34-src@example.com');

    await x.q(x.sql`UPDATE exit_import_batches SET expires_at = now() - interval '1 second'
      WHERE tenant_id=${x.tenantId} AND id=${batchId}::uuid`);
    const expired = await sourceFile(x, batchId);
    expect(expired.status).toBe(404);
    expect((await x.errorOf(expired)).details?.reason).toBe('EXIT_IMPORT_FILE_EXPIRED');

    expect(await purgeExpiredExitImports(x.db, x.tenantId)).toBe(1);
    const purged = await sourceFile(x, batchId);
    expect(purged.status).toBe(404);
    expect((await x.errorOf(purged)).details?.reason).toBe('EXIT_IMPORT_FILE_EXPIRED');
  });

  it('purged_at 非空即使 expires_at 还没到也 404 EXIT_IMPORT_FILE_EXPIRED（防御）', async () => {
    const x = await importWorld(database().db, '34-src-purged');
    const { batchId } = await threeRowBatch(x);
    await x.q(x.sql`UPDATE exit_import_batches SET purged_at = now()
      WHERE tenant_id=${x.tenantId} AND id=${batchId}::uuid`);
    const response = await sourceFile(x, batchId);
    expect(response.status).toBe(404);
    expect((await x.errorOf(response)).details?.reason).toBe('EXIT_IMPORT_FILE_EXPIRED');
  });
});
