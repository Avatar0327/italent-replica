/**
 * AC-F476-06（P3 补充）：无审批人自动同意（origin = no_assignee_approve）也留系统办理份。
 * 单独成文件的理由：该场景只有离职交接夹具（AC-EXIT-F316）能构造，flowWorld 的组织调整夹具构造不出；
 * 夹具造法与 AC-EXIT-F316-empty-approver 同一条（other_handover / auto_approve / 无主取人）。
 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { definition, publish, reach, world } from './AC-EXIT-F316-support.js';

const database = useTestDb();

describe('AC-F476-06 无审批人自动同意 → 系统办理份', () => {
  it('no_assignee_approve：对应任务 / 日志恰一份系统份，actor 与 disclosure_ceiling 均为 SQL NULL', async () => {
    const x = await world(database().db, 'f476-no-assignee', false);
    await publish(x, definition(x, { other_handover: { emptyApproverPolicy: 'auto_approve' } }));
    const run = await reach(x, 'other_handover', false);
    const rows = await x.sqlRows<{
      task_origin: string;
      log_event: string;
      handling_kind: string;
      actor_user_id: string | null;
      disclosure_ceiling: unknown;
      same_log: boolean;
    }>(sql`SELECT t.origin AS task_origin, l.event AS log_event, c.handling_kind, c.actor_user_id,
        c.disclosure_ceiling, (c.handling_log_id = l.id) AS same_log
      FROM approval_handling_contents c
      JOIN approval_tasks t ON t.tenant_id = c.tenant_id AND t.id = c.task_id
      JOIN approval_instance_logs l ON l.tenant_id = c.tenant_id AND l.id = c.handling_log_id
      WHERE c.tenant_id = ${x.tenantId} AND c.instance_id = ${run.instanceId}::uuid
        AND t.origin = 'no_assignee_approve'`);
    expect(rows).toEqual([
      {
        task_origin: 'no_assignee_approve',
        log_event: 'auto_approve',
        handling_kind: 'system',
        actor_user_id: null,
        disclosure_ceiling: null,
        same_log: true,
      },
    ]);
  });
});
