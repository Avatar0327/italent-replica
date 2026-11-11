/**
 * AC-DM-30-F493-41（及 AC-34 的“历史列表该批仍在且 filesExpired”、AC-43 的“导入历史 errorCount = 10”）：
 * 历史离职导入的导入历史列表（S3d，设计 §8.4、DEC-840②）。
 * 列表 = 功能权 + 导入按钮 + own（提交人），不要求任何看全部范围，不含行数据。
 * 读写租户数据一律走 withTenant（x.q），app_owner 普通角色可过（DEC-568）。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  drainExitImports,
  installExitImportTestHooks,
  purgeExpiredExitImports,
} from '../../apps/api/src/modules/employment/exit-import-worker.js';
import { importWorld, type ImportWorld } from './AC-DM-30-support.js';
import { EMPLOYEE_OBJECT_CODE, importOperator, RECORD_OBJECT_CODE } from './support/exit-import-operator.js';

const database = useTestDb();
afterEach(() => installExitImportTestHooks(database().db, {}));

interface HistoryItem {
  id: string;
  importType: string;
  createdAt: string;
  submitterName: string;
  status: string;
  total: number;
  errorCount: number | null;
  hasErrorFile: boolean;
  fileName: string;
  filesExpired: boolean;
}
interface HistoryPage {
  items: HistoryItem[];
  page: number;
  hasNext: boolean;
}

const listOf = async (request: Promise<Response>): Promise<HistoryPage> => {
  const response = await request;
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as HistoryPage;
};
const adminList = (x: ImportWorld, query = '') => listOf(x.session.request('GET', `/exits/import/batches${query}`));

// F-518：固定在北京时间 00:20，持续复现回退 40 / 30 分钟跨到前一天的边界。
const historyReferenceTime = '2026-11-11T00:20:00+08:00';

/** 把批次的提交时间固定成“基准时刻 - minutes 分钟”，让倒序断言不依赖提交的先后间隔。 */
const stamp = (x: ImportWorld, batchId: string, minutes: number) =>
  x.q(x.sql`UPDATE exit_import_batches
    SET created_at = ${historyReferenceTime}::timestamptz - make_interval(mins => ${minutes})
    WHERE tenant_id=${x.tenantId} AND id=${batchId}::uuid`);

/** 不经执行器直接落一个终态批次（只测列表，列表不读行数据）。 */
const insertBatch = (x: ImportWorld, userId: string, n: number, minutesAgo: number) =>
  x.q(x.sql`INSERT INTO exit_import_batches (tenant_id, command_id, submitted_by, file_name, status, total,
      created_count, error_row_count, error_count, finished_at, expires_at, created_at)
    VALUES (${x.tenantId}, ${`syn-cmd-${n}-${minutesAgo}`}, ${userId}::uuid, ${`合成批次${n}.xlsx`},
      'completed', 1, 1, 0, 0, now(), now() + interval '15 days', now() - make_interval(mins => ${minutesAgo}))`);

async function systemFailedBatch(x: ImportWorld, deptCode: string) {
  const db = x.db;
  installExitImportTestHooks(db, { failRow: (n) => (n === 2 ? new Error('合成系统故障') : undefined) });
  const response = await x.submit([1, 2, 3].map((n) => x.row(n, deptCode)));
  expect(response.status, await response.clone().text()).toBe(202);
  const { batchId } = (await response.json()) as { batchId: string };
  await x.settle();
  for (const _ of [2, 3, 4, 5]) {
    await x.q(x.sql`UPDATE exit_import_batches SET lease_until = now() - interval '1 second'
      WHERE tenant_id=${x.tenantId} AND status='running'`);
    await drainExitImports(db, x.tenantId).catch(() => undefined);
  }
  expect(await x.batchOf(batchId)).toMatchObject({ status: 'failed' });
  installExitImportTestHooks(db, {});
  return batchId;
}

describe('AC-DM-30-F493-41 导入历史列表', () => {
  it('A 的 4 批：只列自己的、按提交时间倒序，状态映射、错误条数与错误文件标记、筛选、出参不含行数据；B、T2 反证', async () => {
    const db = database().db;
    const x = await importWorld(db, '41');
    const d = await x.dept('历史部门');
    const x2 = await importWorld(db, '41-t2');
    const d2 = await x2.dept('历史部门二');
    const other = await importOperator(x);

    // ④ 经 failRow 达到上限的 failed；②有错误的 completed（3 行 1 错）；③无错误的 completed
    const failed = await systemFailedBatch(x, d.code);
    const withError = await x.imported([x.row(11, d.code), x.row(12, d.code), x.row(13, 'zzf496nope')], {
      fileName: '有错误.xlsx',
    });
    const clean = await x.imported([x.row(21, d.code)], { fileName: '无错误.xlsx' });
    // B 与 T2 各一批
    const bResponse = await other.submit([x.row(31, d.code)], '乙的批次.xlsx');
    expect(bResponse.status, await bResponse.clone().text()).toBe(202);
    const { batchId: bBatch } = (await bResponse.json()) as { batchId: string };
    await x.settle();
    const t2Batch = await x2.imported([x2.row(41, d2.code)], { fileName: '他租户.xlsx' });

    // ① 被屏障暂停的执行中批次
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    installExitImportTestHooks(db, { beforeBatch: () => gate });
    const runningResponse = await x.submit([x.row(51, d.code)], { fileName: '执行中.xlsx' });
    expect(runningResponse.status, await runningResponse.clone().text()).toBe(202);
    const { batchId: running } = (await runningResponse.json()) as { batchId: string };
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await x.batchOf(running)).status).toMatch(/^(queued|running)$/);

    try {
      // 提交时间：①最早 … ④最新
      await stamp(x, running, 40);
      await stamp(x, clean, 30);
      await stamp(x, withError, 20);
      await stamp(x, failed, 10);

      const page = await adminList(x);
      expect(page.page).toBe(1);
      expect(page.hasNext).toBe(false);
      expect(page.items.map((item) => item.id)).toEqual([failed, withError, clean, running]);
      expect(page.items.map((item) => item.status)).toEqual(['failed', 'succeeded', 'succeeded', 'running']);
      const byId = new Map(page.items.map((item) => [item.id, item]));
      expect(byId.get(withError)).toMatchObject({
        errorCount: 1,
        hasErrorFile: true,
        importType: 'exit',
        total: 3,
        fileName: '有错误.xlsx',
        filesExpired: false,
      });
      expect(byId.get(clean)).toMatchObject({ errorCount: 0, hasErrorFile: false, total: 1 });
      expect(byId.get(running)).toMatchObject({ errorCount: null, hasErrorFile: false, status: 'running' });
      expect(byId.get(failed)).toMatchObject({ status: 'failed', errorCount: 2, hasErrorFile: true });
      const submitterName = page.items[0]!.submitterName;
      expect(submitterName.length).toBeGreaterThan(0);
      for (const item of page.items) {
        expect(item.submitterName).toBe(submitterName);
        expect(Object.keys(item).sort()).toEqual(
          [
            'createdAt',
            'errorCount',
            'fileName',
            'filesExpired',
            'hasErrorFile',
            'id',
            'importType',
            'status',
            'submitterName',
            'total',
          ].sort(),
        );
        expect(new Date(item.createdAt).toISOString()).toBe(item.createdAt);
      }
      // 不出行数据与内部计数
      const text = JSON.stringify(page);
      for (const key of ['email', 'name"', 'error_row_count', 'errorRowCount', 'createdCount', 'attempts', 'lastError'])
        expect(text, key).not.toContain(key);
      expect(text).not.toContain('syn.r');

      // 筛选
      expect((await adminList(x, '?status=succeeded')).items).toHaveLength(2);
      expect((await adminList(x, '?status=running,failed')).items.map((item) => item.status).sort()).toEqual([
        'failed',
        'running',
      ]);
      expect((await x.session.request('GET', '/exits/import/batches?status=queued')).status).toBe(400);
      const today = (
        await x.q<{ d: string }>(x.sql`SELECT
          (${historyReferenceTime}::timestamptz AT TIME ZONE 'Asia/Shanghai')::date::text AS d`)
      )[0]!.d;
      expect((await adminList(x, `?from=${today}&to=${today}`)).items).toHaveLength(4);
      expect((await adminList(x, '?from=2020-01-01&to=2020-01-31')).items).toHaveLength(0);

      // B 的列表看不到 A 的批次；T2 看不到 A 的批次
      const bPage = await listOf(other.get('/exits/import/batches'));
      expect(bPage!.items.map((item) => item.id)).toEqual([bBatch]);
      const t2Page = await listOf(x2.session.request('GET', '/exits/import/batches'));
      expect(t2Page!.items.map((item) => item.id)).toEqual([t2Batch]);
    } finally {
      release();
    }
    await x.settle();
    expect((await adminList(x, '?status=succeeded')).items).toHaveLength(3);
  });

  it('A 共 16 批：第 1 页 15 条 hasNext，第 2 页 1 条；page 非法 400', async () => {
    const x = await importWorld(database().db, '41-page');
    const userId = x.session.user.id;
    for (let n = 1; n <= 16; n++) await insertBatch(x, userId, n, n);
    const first = await adminList(x);
    expect(first.items).toHaveLength(15);
    expect(first.hasNext).toBe(true);
    expect(first.page).toBe(1);
    expect(first.items[0]!.fileName).toBe('合成批次1.xlsx');
    const second = await adminList(x, '?page=2');
    expect(second.items).toHaveLength(1);
    expect(second.hasNext).toBe(false);
    expect(second.page).toBe(2);
    expect(second.items[0]!.fileName).toBe('合成批次16.xlsx');
    expect((await adminList(x, '?page=3')).items).toHaveLength(0);
    for (const bad of ['?page=0', '?page=abc', '?status=bogus', '?from=2026-13-01', '?from=2026-02-02&to=2026-01-01'])
      expect((await x.session.request('GET', `/exits/import/batches${bad}`)).status, bad).toBe(400);
  });

  it('租户时区的业务日期区间含两端：北京时间 2026-11-04 23:30 的批次属于 11-04，不属于 11-05', async () => {
    const x = await importWorld(database().db, '41-tz');
    await insertBatch(x, x.session.user.id, 1, 0);
    // 北京时间 2026-11-04 23:30 = UTC 15:30
    await x.q(x.sql`UPDATE exit_import_batches SET created_at = '2026-11-04T15:30:00Z'
      WHERE tenant_id=${x.tenantId}`);
    expect((await adminList(x, '?from=2026-11-04&to=2026-11-04')).items).toHaveLength(1);
    expect((await adminList(x, '?from=2026-11-05&to=2026-11-05')).items).toHaveLength(0);
    expect((await adminList(x, '?to=2026-11-03')).items).toHaveLength(0);
    expect((await adminList(x, '?from=2026-11-04')).items).toHaveLength(1);
  });
});

describe('AC-DM-30-F493-41 权限（功能权 + 导入按钮 + own；不要求看全部范围）', () => {
  it('没有导入按钮 403；撤任职 / 人员 / 档案对象的看全部范围仍 200（DEC-874）', async () => {
    const x = await importWorld(database().db, '41-authz');
    const op = await importOperator(x);
    const d = await x.dept('权限部门');
    const response = await op.submit([x.row(1, d.code)]);
    expect(response.status, await response.clone().text()).toBe(202);
    await x.settle();
    expect((await listOf(op.get('/exits/import/batches'))).items).toHaveLength(1);

    await op.revokeScope(RECORD_OBJECT_CODE);
    await op.revokeScope(EMPLOYEE_OBJECT_CODE);
    expect((await listOf(op.get('/exits/import/batches'))).items).toHaveLength(1);

    await op.reconfigure({ noButton: true });
    expect((await op.get('/exits/import/batches')).status).toBe(403);
  });
});

describe('AC-DM-30-F493-34 / 43 导入历史部分', () => {
  it('到期并清理后，该批仍在列表里且 filesExpired = true、errorCount 保留；未到期为 false', async () => {
    const x = await importWorld(database().db, '34-list');
    const batchId = await x.imported([x.row(1, 'zzf496nope')]);
    expect((await adminList(x)).items[0]).toMatchObject({ id: batchId, filesExpired: false, errorCount: 1 });
    await x.q(x.sql`UPDATE exit_import_batches SET expires_at = now() - interval '1 second'
      WHERE tenant_id=${x.tenantId} AND id=${batchId}::uuid`);
    expect((await adminList(x)).items[0]).toMatchObject({ id: batchId, filesExpired: true }); // 清理前就按 expires_at 判
    expect(await purgeExpiredExitImports(x.db, x.tenantId)).toBe(1);
    expect((await adminList(x)).items[0]).toMatchObject({ id: batchId, filesExpired: true, errorCount: 1 });
  });

  it('沿用 AC-40 的 11 行批次：导入历史该批 errorCount = 10、total = 11、status = succeeded', async () => {
    const x = await importWorld(database().db, '43-list');
    const d = await x.dept('条数历史部门');
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
    expect((await adminList(x)).items[0]).toMatchObject({
      id: batchId,
      status: 'succeeded',
      total: 11,
      errorCount: 10,
      hasErrorFile: true,
    });
  });
});
