/**
 * F-241（#427 F-237 第 2 轮存量 P2）：离职确认清单 S 先在 SQL 里过滤再有界读取，不再“先 LIMIT 再在 JS 里剔除前序”。
 * 回归：员工有 2 条前序（已批准、计划生效日 ≤ L，会先于离职落地）+ 1000 条审批中调动——
 * 旧实现的候选查询先取 1001 条（前序排在最前）再剔除前序，ack 只覆盖 999 条，前序落地后重算为 1000 条，
 * 迟到生效实际作废 1000 条，含最初未确认的那 1 条。期望：初次确认的 S 含全部 1000 条，前序落地后集合不变。
 * 真 PostgreSQL（普通角色 app_owner）；超长集合策略见同目录 AC-EXIT-F237-preview-too-many。
 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { VOID_LIMIT } from '../../apps/api/src/modules/employment/exit-void-applications.js';
import { downstreamWorld, type DownstreamWorld } from './AC-EXIT-downstream-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const LAST_WORK_DATE = '2026-10-20';

interface Preview {
  ack: { ackToken: string; items: { businessId: string }[]; hiddenCount: number } | null;
}
async function previewOf(x: DownstreamWorld): Promise<Preview> {
  const response = await x.session.request('POST', `/exits/employees/${x.employee.id}/preview`, {
    body: { lastWorkDate: LAST_WORK_DATE },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Preview;
}

/** 前序“落地”：状态推进到 effective（不再是审批中 / 已批准未落地），模拟 §5.0 队列在离职之前执行了它们。 */
async function landPriors(x: DownstreamWorld, effectiveDate: string) {
  await x.sqlRows(sql`
    INSERT INTO employment_state_events(tenant_id, employee_id, business_id, payload_version_id, state, event_no, command_id)
    SELECT s.tenant_id, s.employee_id, s.business_id, s.payload_version_id, 'effective', s.event_no + 1, 'f241-land'
    FROM employment_state_events s
    JOIN employment_payload_versions p ON p.tenant_id=s.tenant_id AND p.id=s.payload_version_id
    WHERE s.tenant_id=${x.session.tenant.id} AND s.employee_id=${x.employee.id}::uuid AND s.state='approved'
      AND p.effective_date=${effectiveDate}::date`);
}

describe('F-241 确认清单先过滤再截断（真 PG）', () => {
  it('2 条前序 + 1000 条审批中：预览 ack 覆盖 1000 条；创建保存的 ids 与之一致；前序落地后集合与令牌不变', async () => {
    const x = await downstreamWorld(database().db, 'f241-prior-1000', TODAY);
    // 前序计划日更早，在候选查询的 ORDER BY planned 里排最前，旧实现会让它们占去 LIMIT 的名额
    await x.bulkDrafts(2, x.employee.id, { kind: 'transfer', state: 'approved', effectiveDate: '2026-10-08' });
    await x.bulkDrafts(VOID_LIMIT, x.employee.id, {
      kind: 'transfer',
      state: 'in_review',
      effectiveDate: '2026-10-10',
    });

    const preview = await previewOf(x);
    expect(preview.ack!.items.length + preview.ack!.hiddenCount).toBe(VOID_LIMIT);

    const leave = await x.directLeave(LAST_WORK_DATE, { pendingTransferAck: preview.ack!.ackToken });
    const stored = (await x.exitRow(leave.id))!.pending_transfer_ack as { ids: string[]; hash: string };
    expect(stored.ids).toHaveLength(VOID_LIMIT);
    expect(stored.hash).toBe(preview.ack!.ackToken);
    expect(new Set(stored.ids)).toEqual(new Set(preview.ack!.items.map((item) => item.businessId)));

    await landPriors(x, '2026-10-08');
    const after = await previewOf(x);
    expect(after.ack!.ackToken, '前序落地后重算的集合必须与最初确认的相同（迟到生效不产生集合差异）').toBe(stored.hash);
    expect(after.ack!.items.length + after.ack!.hiddenCount).toBe(VOID_LIMIT);
  }, 600_000);
});
