/**
 * AC-DM-30-F493-30 补充：F～H 名称按「入职日当天的有效版本」匹配，字典按完整候选集分类（设计 §3.1、§3.3）。
 * 真 DB + HTTP；职务体系对象经职位模块 API 建与改（含同日起点修订），字典经 withTenant 直接落行。
 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { H, importWorld, type ImportWorld } from './AC-DM-30-support.js';

const database = useTestDb();
const BEFORE_RENAME = '2022-06-01';
const RENAMED_ON = '2023-01-01';

/** 每次提交一行（行号递增，邮箱不重复）并返回该行的状态与错误。 */
function oneRunner(x: ImportWorld, deptCode: string) {
  let n = 0;
  return async (extra: Parameters<ImportWorld['row']>[2]) => {
    const batchId = await x.imported([x.row((n += 1), deptCode, extra)]);
    const [row] = await x.rowsOfBatch(batchId);
    return { status: row!.status, errors: row!.errors };
  };
}

describe('AC-DM-30-F493-30 职务体系名称只认入职日的有效版本', () => {
  it('岗位 2023-01-01 改名：入职日在改名后用旧名 → NOT_FOUND，用新名成功；入职日在改名前用旧名成功', async () => {
    const x = await importWorld(database().db, '30-rename');
    const d = await x.dept('改名部门');
    const run = oneRunner(x, d.code);
    const { post } = await x.jobs(d.id);
    await x.jobPatch('posts', post.id, post.revision, { name: '新岗位', effectiveDate: RENAMED_ON });
    expect(await run({ postName: '合成岗位' })).toEqual({
      status: 'failed',
      errors: [{ column: 'G', reason: 'REFERENCE_NOT_FOUND' }],
    });
    expect((await run({ postName: '新岗位' })).status).toBe('succeeded');
    expect((await run({ postName: '合成岗位', entryDate: BEFORE_RENAME })).status).toBe('succeeded');
    expect(await run({ postName: '新岗位', entryDate: BEFORE_RENAME })).toEqual({
      status: 'failed',
      errors: [{ column: 'G', reason: 'REFERENCE_NOT_FOUND' }],
    });
  });

  it('职位同日起点修订（生效日等于原起点）：旧名不再命中，新名命中', async () => {
    const x = await importWorld(database().db, '30-same-day');
    const d = await x.dept('同日修订部门');
    const run = oneRunner(x, d.code);
    const { position } = await x.jobs(d.id);
    await x.jobPatch('positions', position.id, position.revision, { name: '改名职位', effectiveDate: '2022-01-01' });
    const [versions] = await x.q<{ n: string }>(sql`SELECT count(*) AS n FROM job_position_versions
      WHERE tenant_id=${x.tenantId} AND object_id=${position.id}::uuid AND start_date='2022-01-01'`);
    expect(Number(versions!.n)).toBe(2); // 前置：确实产生了同起点的第 2 个版本
    expect(await run({ positionName: '合成职位' })).toEqual({
      status: 'failed',
      errors: [{ column: 'F', reason: 'REFERENCE_NOT_FOUND' }],
    });
    expect((await run({ positionName: '改名职位' })).status).toBe('succeeded');
  });

  it('职级自 2023-01-01 起停用：入职日在停用后 → NOT_FOUND（不回落到更早的启用版本）；停用前仍成功', async () => {
    const x = await importWorld(database().db, '30-disabled');
    const d = await x.dept('停用职级部门');
    const run = oneRunner(x, d.code);
    const { level } = await x.jobs(d.id);
    await x.jobPatch('levels', level.id, level.revision, { enabled: false, effectiveDate: RENAMED_ON });
    expect(H >= RENAMED_ON).toBe(true);
    expect(await run({ levelName: '合成职级' })).toEqual({
      status: 'failed',
      errors: [{ column: 'H', reason: 'REFERENCE_NOT_FOUND' }],
    });
    expect((await run({ levelName: '合成职级', entryDate: BEFORE_RENAME })).status).toBe('succeeded');
  });
});

describe('AC-DM-30-F493-30 离职字典按完整候选集分类', () => {
  /** 同名、不同编码的类型字典项：`enabledFlags` 按插入顺序给出启用状态。 */
  async function seedTypes(x: ImportWorld, name: string, enabledFlags: readonly boolean[]) {
    for (const [i, enabled] of enabledFlags.entries())
      await x.q(sql`INSERT INTO exit_types(tenant_id, code, name, enabled, display_order)
        VALUES (${x.tenantId}, ${`SYN${i}`}, ${name}, ${enabled}, ${i})`);
  }

  it('5 个同名项，前 3 个停用、后 2 个启用 → REFERENCE_AMBIGUOUS（不是 DISABLED）', async () => {
    const x = await importWorld(database().db, '30-dict-5');
    const d = await x.dept('字典歧义部门');
    const run = oneRunner(x, d.code);
    await seedTypes(x, '合成重名类型', [false, false, false, true, true]);
    expect(await run({ exitTypeName: '合成重名类型' })).toEqual({
      status: 'failed',
      errors: [{ column: 'W', reason: 'REFERENCE_AMBIGUOUS' }],
    });
  });

  it('4 个同名项，前 3 个停用、只有第 4 个启用 → 命中启用项，行成功', async () => {
    const x = await importWorld(database().db, '30-dict-4');
    const d = await x.dept('字典单启用部门');
    await seedTypes(x, '合成重名类型', [false, false, false, true]);
    const batchId = await x.imported([x.row(1, d.code, { exitTypeName: '合成重名类型' })]);
    const [row] = await x.rowsOfBatch(batchId);
    expect(row).toMatchObject({ status: 'succeeded', errors: [] });
    const exit = await x.exitRowOf(row!.exit_business_id!);
    expect(exit).toMatchObject({ exitTypeCode: 'SYN3' });
  });

  it('5 个同名项全部停用 → REFERENCE_DISABLED', async () => {
    const x = await importWorld(database().db, '30-dict-off');
    const d = await x.dept('字典全停用部门');
    const run = oneRunner(x, d.code);
    await seedTypes(x, '合成重名类型', [false, false, false, false, false]);
    expect(await run({ exitTypeName: '合成重名类型' })).toEqual({
      status: 'failed',
      errors: [{ column: 'W', reason: 'REFERENCE_DISABLED' }],
    });
  });
});
