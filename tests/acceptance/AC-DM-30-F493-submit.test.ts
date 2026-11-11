/**
 * AC-DM-30-F493-01/02/06/09/14/19：历史离职导入的提交侧（S3a，设计 §3、§4.1、§6.1）。
 * 提交只落批次与逐行明细并回 202；执行器在提交后唤醒（setImmediate 单飞），不在请求内跑。
 * 真 DB + HTTP；读写租户数据一律走 withTenant（app_owner 普通角色可过，DEC-568）。
 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { duplicateEmailRows } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { installExitImportTestHooks } from '../../apps/api/src/modules/employment/exit-import-worker.js';
import { importWorld, type ImportWorld } from './AC-DM-30-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
afterEach(() => installExitImportTestHooks(database().db, {}));

/** 可控屏障：执行器领到批次后停在 beforeBatch，直到 release()。 */
function barrier(db: ReturnType<typeof database>['db']) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  installExitImportTestHooks(db, { beforeBatch: () => gate });
  return release;
}

describe('AC-DM-30-F493-01 提交 3 行，执行器被屏障暂停', () => {
  it('202 先于屏障释放返回；释放后批次 completed，人员 +3', async () => {
    const db = database().db;
    const x = await importWorld(db, '01');
    const d = await x.dept('提交部门');
    const release = barrier(db);
    const response = await x.submit([1, 2, 3].map((n) => x.row(n, d.code)));
    expect(response.status, await response.clone().text()).toBe(202);
    const body = (await response.json()) as { batchId: string; status: string; total: number };
    expect(body).toEqual({ batchId: expect.stringMatching(/^[0-9a-f-]{36}$/), status: 'queued', total: 3 });
    expect(await x.employeeCount()).toBe(0);
    expect((await x.rowsOfBatch(body.batchId)).map((r) => r.status)).toEqual(['pending', 'pending', 'pending']);
    release();
    await x.settle();
    expect(await x.batchOf(body.batchId)).toMatchObject({
      status: 'completed',
      created_count: 3,
      error_row_count: 0,
      error_count: 0,
    });
    expect(await x.employeeCount()).toBe(3);
  });
});

describe('AC-DM-30-F493-02 上限与请求体', () => {
  /** 典型数据：地址类列写中文，一行约 890 字节（UTF-8，上限按字节算）。 */
  const typical = (x: ImportWorld, deptCode: string, n: number, fill = 60) =>
    x.row(n, deptCode, {
      idNumber: `1101011990${String(n).padStart(8, '0')}`,
      mobilePhone: '13800000000',
      householdAddress: '合成地址'.repeat(fill / 4),
      registAddress: '合成地址'.repeat(fill / 4),
    });

  it('1000 行返回 202；1001 行 400 BATCH_LIMIT_EXCEEDED 不落批次；超过 1 MiB 返回 413', async () => {
    const db = database().db;
    const x = await importWorld(db, '02');
    const d = await x.dept('上限部门');
    installExitImportTestHooks(db, {
      beforeBatch: () => Promise.reject(new Error('测试中止执行器')),
    });
    const rows = Array.from({ length: 1000 }, (_, i) => typical(x, d.code, i + 1));
    const size = Buffer.byteLength(JSON.stringify({ fileName: '合成导入.xlsx', rows }));
    expect(size).toBeGreaterThan(800_000);
    expect(size).toBeLessThan(1_048_576);
    const ok = await x.submit(rows);
    expect(ok.status, await ok.clone().text()).toBe(202);
    expect(await x.batchCount()).toBe(1);

    const tooMany = await x.submit([...rows, typical(x, d.code, 1001)]);
    expect(tooMany.status).toBe(400);
    expect((await x.errorOf(tooMany)).details?.reason).toBe('BATCH_LIMIT_EXCEEDED');
    expect(await x.batchCount()).toBe(1);

    const big = Array.from({ length: 1000 }, (_, i) => typical(x, d.code, i + 1, 1200));
    expect((await x.submit(big)).status).toBe(413);
    expect(await x.batchCount()).toBe(1);
    // 收尾：这批 1000 行本测试不需要执行；不置为终态的话，同文件后面的用例唤醒执行器时会顺带把它跑完，拖慢并拖超时
    await x.q(sql`UPDATE exit_import_batches SET status='completed' WHERE tenant_id=${x.tenantId}`);
  });
});

describe('AC-DM-30-F493-06 同文件重复邮箱（c 类，DEC-834③）', () => {
  it('纯函数：每个重复邮箱的所有行都命中；C 为空的行不参与', () => {
    const rows = [
      { rowNo: 1, email: 'a@example.com' },
      { rowNo: 2, email: ' A@Example.com ' },
      { rowNo: 3, email: 'A@EXAMPLE.COM' },
      { rowNo: 4, email: null },
      { rowNo: 5, email: '' },
    ];
    expect([...duplicateEmailRows(rows)].sort()).toEqual([1, 2, 3]);
  });

  it('第 2、5 行只差大小写和首尾空格：提交时就是 failed，第 3 行成功；error_row_count = 2', async () => {
    const x = await importWorld(database().db, '06');
    const d = await x.dept('重复部门');
    const mail = `syn.dup.${uniqueSuffix()}@example.com`;
    const batchId = await x.imported([
      x.row(1, d.code),
      x.row(2, d.code, { email: mail }),
      x.row(3, d.code),
      x.row(4, d.code),
      x.row(5, d.code, { email: ` ${mail.toUpperCase()} ` }),
    ]);
    const rows = await x.rowsOfBatch(batchId);
    for (const no of [2, 5]) {
      const r = rows.find((item) => item.row_no === no)!;
      expect(r.status).toBe('failed');
      expect(r.errors).toEqual([{ column: 'C', reason: 'EMAIL_DUPLICATE_IN_FILE' }]);
      expect(r.employee_id).toBeNull();
    }
    expect(rows.find((r) => r.row_no === 3)!.status).toBe('succeeded');
    expect(await x.batchOf(batchId)).toMatchObject({ created_count: 3, error_row_count: 2, error_count: 2 });
  });
});

describe('AC-DM-30-F493-09 幂等', () => {
  it('同键同内容回同一 batchId 只有一个批次；同键不同内容 409；不同键同内容 → 第二批全部 EMAIL_IN_EMPLOYEE', async () => {
    const db = database().db;
    const x = await importWorld(db, '09');
    const d = await x.dept('幂等部门');
    const rows = [x.row(1, d.code), x.row(2, d.code)];
    const options = { idempotencyKey: `dm30-09-fixed-${uniqueSuffix()}` };
    const first = await x.submit(rows, {}, options);
    expect(first.status).toBe(202);
    const { batchId } = (await first.json()) as { batchId: string };
    await x.settle();
    const replay = await x.submit(rows, {}, options);
    expect(replay.status).toBe(202);
    expect(((await replay.json()) as { batchId: string }).batchId).toBe(batchId);
    expect(await x.batchCount()).toBe(1);
    const changed = await x.submit([x.row(1, d.code, { name: '合成丙' })], {}, options);
    expect(changed.status).toBe(409);

    const second = await x.imported(rows);
    expect(second).not.toBe(batchId);
    const secondRows = await x.rowsOfBatch(second);
    expect(secondRows.map((r) => [r.status, r.errors])).toEqual(
      rows.map(() => ['failed', [{ column: 'C', reason: 'EMAIL_IN_EMPLOYEE' }]]),
    );
    expect(await x.employeeCount()).toBe(2);
  });
});

describe('AC-DM-30-F493-14 预览路由删除', () => {
  it('POST /exits/import/preview 返回 404', async () => {
    const x = await importWorld(database().db, '14');
    const d = await x.dept('预览部门');
    const response = await x.session.request('POST', '/exits/import/preview', {
      body: { fileName: '合成导入.xlsx', rows: [x.row(1, d.code)] },
    });
    expect(response.status).toBe(404);
  });
});

describe('AC-DM-30-F493-19 不写黑名单（U4 一致）', () => {
  it('导入不产生任何名单；报文带 addToBlacklist 键返回 400', async () => {
    const x = await importWorld(database().db, '19');
    const d = await x.dept('黑名单部门');
    await x.imported([x.row(1, d.code)]);
    const [count] = await x.q<{ n: string }>(
      x.sql`SELECT count(*) AS n FROM employment_blacklist WHERE tenant_id=${x.tenantId}`,
    );
    expect(Number(count!.n)).toBe(0);
    const response = await x.submit([{ ...x.row(2, d.code), addToBlacklist: true }]);
    expect(response.status).toBe(400);
  });
});
