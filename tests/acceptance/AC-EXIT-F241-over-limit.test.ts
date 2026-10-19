/**
 * F-241 / DEC-626（方案 B）：确认清单 S（审批中调动 ∪ 已批准未落地且计划日 > L）超过 1000 条时——
 * 创建 / 提交离职不拦截（2xx + warning），不发完整确认令牌，随离职单保存“超限、未完整确认”标记；
 * 生效日按当时状态重算：仍 > 1000 整单拒绝生效（零作废、记失败尝试），降到 ≤ 1000 照常作废并按“未完整确认”记差异审计。
 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { VOID_LIMIT } from '../../apps/api/src/modules/employment/exit-void-applications.js';
import { downstreamWorld, type DownstreamWorld } from './AC-EXIT-downstream-support.js';
import { leaveBody } from './AC-EXIT-gate-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const LAST_WORK_DATE = '2026-10-20';
const EFFECTIVE_DAY = '2026-10-21';
const WARNING = { reason: 'EXIT_APPLICATIONS_TOO_MANY', limit: VOID_LIMIT };
const MARKER = { ids: [], hash: '', overLimit: true };

async function overLimitWorld(label: string) {
  const x = await downstreamWorld(database().db, label, TODAY);
  await x.bulkDrafts(VOID_LIMIT + 1, x.employee.id, {
    kind: 'transfer',
    state: 'in_review',
    effectiveDate: '2026-10-10',
  });
  return x;
}

async function created(x: DownstreamWorld, mode: 'direct' | 'application') {
  const response = await x.createLeave(x.employee.id, leaveBody(LAST_WORK_DATE, mode, { exitTypeCode: 'voluntary' }));
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { id: string; revision: number; warnings?: unknown[] };
}

/** 把在途调动批量改成已作废（模拟 HR 处理掉多余的申请）：只留 keep 条。 */
const settleAllBut = (x: DownstreamWorld, keep: number) =>
  x.sqlRows(sql`
    INSERT INTO employment_state_events(tenant_id, employee_id, business_id, payload_version_id, state, event_no,
      command_id)
    SELECT s.tenant_id, s.employee_id, s.business_id, s.payload_version_id, 'voided', s.event_no + 1, 'f241-settle'
    FROM (SELECT * FROM employment_state_events WHERE tenant_id=${x.session.tenant.id}
        AND employee_id=${x.employee.id}::uuid AND state='in_review' ORDER BY business_id OFFSET ${keep}) s`);

describe('F-241 / DEC-626 超限不拦截创建 / 提交', () => {
  it('直接离职 S = 1001：201 + warning，不发完整令牌，标记已存', async () => {
    const x = await overLimitWorld('f241-over-direct');
    const leave = await created(x, 'direct');
    expect(leave.warnings).toEqual([WARNING]);
    expect((await x.exitRow(leave.id))!.pending_transfer_ack).toEqual(MARKER);
  }, 600_000);

  it('申请离职 S = 1001：创建 201 + warning；提交 200 + warning，标记仍在', async () => {
    const x = await overLimitWorld('f241-over-application');
    const draft = await created(x, 'application');
    expect(draft.warnings).toEqual([WARNING]);
    const submitted = await x.session.request('POST', `/exits/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: {},
    });
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    expect(((await submitted.json()) as { warnings?: unknown[] }).warnings).toEqual([WARNING]);
    expect((await x.exitRow(draft.id))!.pending_transfer_ack).toEqual(MARKER);
  }, 600_000);

  it('S = 1000（恰为上限）：照常要求确认令牌，不带 warning', async () => {
    const x = await overLimitWorld('f241-at-limit');
    await settleAllBut(x, VOID_LIMIT);
    const response = await x.createLeave(x.employee.id, leaveBody(LAST_WORK_DATE, 'direct'));
    expect(response.status).toBe(409);
    expect(await x.reason(response)).toMatchObject({ reason: 'EXIT_PENDING_TRANSFER_ACK_REQUIRED' });
  }, 600_000);
});

describe('F-241 / DEC-626 生效日按当时状态重算', () => {
  it('生效日仍 > 1000：整单拒绝，零作废，记失败尝试 EXIT_APPLICATIONS_TOO_MANY，离职不推进', async () => {
    const x = await overLimitWorld('f241-effective-over');
    const leave = await created(x, 'direct');
    const before = await x.stateCounts();
    expect(await x.activate(leave.id, EFFECTIVE_DAY)).toMatchObject({
      outcome: 'failed',
      reason: 'EXIT_APPLICATIONS_TOO_MANY',
    });
    expect(await x.stateCounts()).toEqual(before);
    expect(await x.stateOfBusiness(leave.id)).toBe('approved');
    expect((await x.attempts(leave.id)).at(-1)).toMatchObject({
      outcome: 'failed',
      reason: 'EXIT_APPLICATIONS_TOO_MANY',
    });
    expect(await x.audits(leave.id, 'employment.exit.ack_set_changed')).toEqual([]);
  }, 600_000);

  it('生效日降到 ≤ 1000：照常作废，差异审计按“未完整确认”记录全部实际作废 ID', async () => {
    const x = await overLimitWorld('f241-effective-under');
    const leave = await created(x, 'direct');
    await settleAllBut(x, 3);
    expect(await x.activate(leave.id, EFFECTIVE_DAY)).toMatchObject({ outcome: 'effective' });
    const voided = await x.sqlRows<{ id: string }>(sql`SELECT target_id AS id FROM exit_effects
      WHERE tenant_id=${x.session.tenant.id} AND business_id=${leave.id}::uuid AND kind='application_voided'`);
    const [audit] = await x.audits(leave.id, 'employment.exit.ack_set_changed');
    expect(audit!.before).toEqual({ ids: [], incomplete: true });
    const ids = (audit!.after as { ids: string[] }).ids;
    expect(ids).toHaveLength(3);
    expect([...ids].sort()).toEqual(voided.map((row) => row.id).sort());
  }, 600_000);
});
