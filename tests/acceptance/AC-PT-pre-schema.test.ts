/**
 * F-218③（#397 BE-7-PT2 审查后补 P3）：升级类用例的旧结构夹具 addPrePartTimeTables 异常路径统一 restore。
 * 中途建表失败时不留半套临时表（建表在一个事务里整体回滚）；撤掉函数幂等；withPrePartTimeSchema 在回调抛错时也撤掉。
 */
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { addPrePartTimeTables, withPrePartTimeSchema } from './support/pre-part-time-schema.js';

const database = useTestDb();
const TABLES = ['employment_part_time_terms', 'part_time_requests', 'part_time_request_versions'] as const;

async function present() {
  const { db } = database();
  const [row] = rowsOf<Record<string, boolean>>(
    await db.execute(
      sql`SELECT ${sql.join(
        TABLES.map((name) => sql`to_regclass(${`public.${name}`}) IS NOT NULL AS ${sql.identifier(name)}`),
        sql`, `,
      )}`,
    ),
  );
  return row!;
}

async function removeAll() {
  await database().db.execute(
    sql`DROP TABLE IF EXISTS part_time_request_events, part_time_request_versions, part_time_requests,
      employment_part_time_terms CASCADE`,
  );
}

describe('F-218③ addPrePartTimeTables', () => {
  it('中途建表失败：本次已建的表一并回滚，不留半套；原有的同名表不动', async () => {
    await removeAll();
    // 第三张表被占用（结构不同的同名表），第一、二张建成后第三张失败
    await database().db.execute(sql`CREATE TABLE part_time_request_versions (blocker int)`);
    await expect(addPrePartTimeTables(database().db)).rejects.toThrow();
    expect(await present()).toEqual({
      employment_part_time_terms: false,
      part_time_requests: false,
      part_time_request_versions: true,
    });
    await database().db.execute(sql`DROP TABLE part_time_request_versions`);
  });

  it('正常路径：建出三张表，restore 撤掉且可重复调用；表已存在（已升级）时返回空操作、不动现有表', async () => {
    await removeAll();
    const restore = await addPrePartTimeTables(database().db);
    expect(await present()).toEqual({
      employment_part_time_terms: true,
      part_time_requests: true,
      part_time_request_versions: true,
    });
    const noop = await addPrePartTimeTables(database().db);
    await noop();
    expect(await present()).toMatchObject({ part_time_requests: true });
    await restore();
    await restore();
    expect(await present()).toEqual({
      employment_part_time_terms: false,
      part_time_requests: false,
      part_time_request_versions: false,
    });
  });

  it('withPrePartTimeSchema：回调抛错时同样撤掉', async () => {
    await removeAll();
    await expect(
      withPrePartTimeSchema(database().db, async () => {
        throw new Error('前置步骤失败');
      }),
    ).rejects.toThrow('前置步骤失败');
    expect(await present()).toEqual({
      employment_part_time_terms: false,
      part_time_requests: false,
      part_time_request_versions: false,
    });
  });
});
