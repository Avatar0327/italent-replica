/**
 * F-476 P8 合 main 核对（P5 provider × 第 6 轮系统份口径）：引擎在同一命令里自动处理时写的系统份，办理人为空，
 * 业务 provider 一并冻结的附带对象上限（子集申请的 requestCeiling）也须按空办理人存「看不到」，
 * 不按触发本次推进的人工操作人的字段权采集；人工份仍是办理人办理时的可见字段。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { latestInstance, personnelScene, rights, textFieldsOf } from './AC-F476-p5-support.js';

const testDb = useTestDb();

interface CopyRow extends Record<string, unknown> {
  readonly node_key: string;
  readonly handling_kind: string;
  readonly actor_user_id: string | null;
  readonly ceiling: string[] | null;
}

describe('AC-F476-08 P5 子集申请：同人自动同意的系统份不按触发人采集附带对象上限', () => {
  it('人工份 requestCeiling 是办理人的可见字段；同一命令里的系统份 actor 为空、requestCeiling 为空', async () => {
    const s = await personnelScene(testDb().db, 'f476-p8-p5-sys-ceil', { sameAssigneeSecond: true });
    const r = rights(s.w);
    const [field] = textFieldsOf('education') as [string];
    const request = await s.apply('education', { [field]: 'ZZ_办理时' });
    const instance = await latestInstance(s.w, 'personnel_change', request.id);
    await r.decide(instance.id, s.n1, 'approve');

    const rows = await withTenant(s.w.db, s.w.tenant.id, async (tx) => {
      // 同一命令里两份的 acted_at 相同，按各自办理日志的写入顺序排
      const result = await tx.execute(sql`SELECT c.node_key, c.handling_kind, c.actor_user_id::text,
          c.content->'ext'->'requestCeiling' AS ceiling
        FROM approval_handling_contents c
        JOIN approval_instance_logs l ON l.tenant_id = c.tenant_id AND l.id = c.handling_log_id
        WHERE c.instance_id = ${instance.id}::uuid ORDER BY l.created_at, l.seq`);
      return (Array.isArray(result) ? result : (result as { rows: CopyRow[] }).rows) as CopyRow[];
    });
    expect(rows.map((row) => [row.node_key, row.handling_kind, row.actor_user_id])).toEqual([
      ['n1', 'human', s.n1.userId],
      ['n2', 'system', null],
    ]);
    const [human, system] = rows;
    expect(human!.ceiling, '人工份应存办理人办理时的可见字段').not.toEqual([]);
    expect(Array.isArray(human!.ceiling)).toBe(true);
    expect(system!.ceiling).toEqual([]);
  });
});
