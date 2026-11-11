/**
 * AC-DM-30-F493-10②/34（清理部分）：导入执行器的定时补偿与到期清理（S3b，设计 §6.2、§6.3、§8.3）。
 * ② 唤醒丢失（批次停在 queued）由调度器一轮补偿；清理：批次完成 15 天后，全部明细行的 25 个原始列置 NULL、
 * purged_at 落值，错误清单与计数保留，重复清理不再改动。下载 404 / 历史 filesExpired 属 S3c / S3d。
 * 调度器用小间隔，用例末尾必须 stop()，不留定时器。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installExitImportTestHooks,
  purgeExpiredExitImports,
  startExitImportScheduler,
} from '../../apps/api/src/modules/employment/exit-import-worker.js';
import { COLUMN_KEYS, importWorld, type ImportRow, type ImportWorld } from './AC-DM-30-support.js';
import { allowAll } from './support/tenant-api.js';

const database = useTestDb();
afterEach(() => installExitImportTestHooks(database().db, {}));

const RAW = [
  'name',
  'email',
  'department_code',
  'entry_date',
  'position_name',
  'post_name',
  'level_name',
  'work_date',
  'place',
  'id_number',
  'mobile_phone',
  'personal_email',
  'gender',
  'birthday',
  'nation',
  'political_status',
  'household_address',
  'regist_address',
  'school',
  'major',
  'last_work_date',
  'exit_type_name',
  'exit_reason_name',
  'whereabouts_name',
  'exit_note',
] as const;

const until = async (condition: () => Promise<boolean>, what: string) => {
  for (let i = 0; i < 100; i += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待超时：${what}`);
};

/** 直接落一个 queued 批次（不经提交，因此没有唤醒——模拟“唤醒丢失”）。 */
async function seedQueued(x: ImportWorld, rows: readonly ImportRow[]) {
  const batchId = randomUUID();
  await x.q(x.sql`INSERT INTO exit_import_batches (tenant_id, id, command_id, submitted_by, file_name, status, total)
    VALUES (${x.tenantId}, ${batchId}::uuid, ${`lost-wake-${batchId}`}, ${x.session.user.id}::uuid,
      '合成导入.xlsx', 'queued', ${rows.length})`);
  for (const row of rows)
    await x.q(x.sql`INSERT INTO exit_import_rows (tenant_id, batch_id, row_no, name, email, department_code,
      entry_date, last_work_date) VALUES (${x.tenantId}, ${batchId}::uuid, ${row.rowNo}, ${row.name}, ${row.email},
      ${row.departmentCode}, ${row.entryDate}, ${row.lastWorkDate})`);
  return batchId;
}

const clock = () => new Date();
const errors: unknown[] = [];
// 与提交入口同一个授权器（测试世界用 allowAll）；真实授权器的复核口径由 AC-23④ 覆盖
const options = { clock, onError: (error: unknown) => void errors.push(error), intervalMs: 50, authorize: allowAll };

describe('AC-DM-30-F493-10② 唤醒丢失由调度器补偿', () => {
  it('批次停在 queued：启动调度器后一轮内 completed，stop() 之后不再有定时器', async () => {
    const db = database().db;
    const x = await importWorld(db, '10-2');
    const d = await x.dept('补偿部门');
    const batchId = await seedQueued(x, [x.row(1, d.code), x.row(2, d.code)]);
    expect((await x.batchOf(batchId)).status).toBe('queued');

    const scheduler = startExitImportScheduler(db, options);
    try {
      await until(async () => (await x.batchOf(batchId)).status === 'completed', '批次 completed');
    } finally {
      await scheduler.stop();
    }
    expect(await x.batchOf(batchId)).toMatchObject({ status: 'completed', attempts: 1, created_count: 2 });
    expect(await x.employeeCount()).toBe(2);
    expect(errors).toEqual([]);
  });
});

describe('AC-DM-30-F493-34 到期清理（15 天后原始列置空，错误与计数保留）', () => {
  it('未到期不动；到期后一轮把全部行（含 succeeded）的 25 个原始列置 NULL；再来一轮什么都不变', async () => {
    const db = database().db;
    const x = await importWorld(db, '34');
    const d = await x.dept('清理部门');
    const filled = (n: number) =>
      x.row(n, d.code, {
        mobilePhone: '13800000000',
        personalEmail: `syn.p${n}@example.com`,
      });
    const batchId = await x.imported([filled(1), x.row(2, 'NOPE-CODE')]);
    const rawOf = () =>
      x.q<Record<string, unknown>>(x.sql`SELECT ${x.sql.raw(RAW.join(', '))} FROM exit_import_rows
        WHERE tenant_id=${x.tenantId} AND batch_id=${batchId}::uuid ORDER BY row_no`);
    const before = await x.rowsOfBatch(batchId);
    expect(
      before.map((r) => r.status),
      JSON.stringify(before),
    ).toEqual(['succeeded', 'failed']);
    const original = await rawOf();
    expect(original[0]).toMatchObject({ name: '合成甲', mobile_phone: '13800000000' });
    expect(COLUMN_KEYS).toHaveLength(RAW.length);

    // 未到期（expires_at 约 15 天后）：清理一轮也不动原始列
    expect(await purgeExpiredExitImports(db, x.tenantId)).toBe(0);
    expect(await rawOf()).toEqual(original);

    await x.q(x.sql`UPDATE exit_import_batches SET expires_at = now() - interval '1 day'
      WHERE tenant_id=${x.tenantId} AND id=${batchId}::uuid`);
    const scheduler = startExitImportScheduler(db, options);
    try {
      await until(
        async () =>
          (
            await x.q<{ purged: boolean }>(x.sql`SELECT purged_at IS NOT NULL AS purged FROM exit_import_batches
              WHERE tenant_id=${x.tenantId} AND id=${batchId}::uuid`)
          )[0]!.purged,
        '批次清理完成',
      );
    } finally {
      await scheduler.stop();
    }

    const purged = await rawOf();
    for (const row of purged) expect(Object.values(row).every((value) => value === null)).toBe(true);
    expect(await x.rowsOfBatch(batchId)).toEqual(before); // 状态、错误清单、人员与业务引用保留
    expect(await x.batchOf(batchId)).toMatchObject({ status: 'completed', created_count: 1, error_row_count: 1 });

    const stamp = () =>
      x.q<{ purged_at: string; revision: number }>(x.sql`SELECT purged_at, revision FROM exit_import_batches
        WHERE tenant_id=${x.tenantId} AND id=${batchId}::uuid`);
    const first = await stamp();
    expect(await purgeExpiredExitImports(db, x.tenantId)).toBe(0);
    expect(await stamp()).toEqual(first);
  });
});
