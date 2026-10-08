/**
 * #98 F-028（DEC-230）与 F-007 合并后的交叉检查：简单迟到执行（区间内无其他记录，DEC-278）把调动改到实际执行日后，
 * 直接上级审批人仍取主体当前生效主职的经理，不取历史记录、也不取未来记录；当前经理为空时首节点 409 且不留下任何写入。
 */
import { runEmploymentActivations } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { approvalWorld, type ApprovalWorld } from './AC-APV-support.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
const EMPLOYMENT = '/api/tenant/employment';
const DIRECT = { key: 'manager', name: '直接上级', approver: 'direct_manager' } as const;

interface RecordView {
  readonly id: string;
  readonly kind: string;
  readonly effectiveDate: string;
  readonly isCurrent: boolean;
  readonly fields: Record<string, unknown>;
}

async function directBusiness(w: ApprovalWorld, employeeId: string, body: object) {
  const employee = await w.json<{ revision: number }>(
    await w.request(w.hr.id, 'GET', `${EMPLOYMENT}/employees/${employeeId}`),
  );
  return w.json<{ id: string }>(
    await w.request(w.hr.id, 'POST', `${EMPLOYMENT}/employees/${employeeId}/businesses`, {
      ifMatch: employee.revision,
      body: { mode: 'direct', ...body },
    }),
    201,
  );
}

async function records(w: ApprovalWorld, employeeId: string, asOf: string) {
  return (
    await w.json<{ items: RecordView[] }>(
      await w.request(w.hr.id, 'GET', `${EMPLOYMENT}/employees/${employeeId}/records?asOf=${asOf}`),
    )
  ).items;
}

async function effects(w: ApprovalWorld) {
  return withTenant(w.db, w.tenant.id, async (tx) =>
    rowsOf(
      await tx.execute(sql`SELECT
      (SELECT count(*) FROM approval_instances)::int AS instances,
      (SELECT count(*) FROM approval_tasks)::int AS tasks,
      (SELECT count(*) FROM approval_outbox)::int AS outbox,
      (SELECT count(*) FROM employment_payload_versions)::int AS payloads`),
    ),
  );
}

it.each([true, false])('AC-ORG-32 简单迟到执行后直接上级按当前经理派单 / 当前有经理=%s', async (hasManager) => {
  const w = await approvalWorld(database().db, `r7routing${hasManager}`);
  const org = await w.org('派单部门');
  const managerA = await w.person('历史经理 A', org);
  const managerB = await w.person('当前经理 B', org);
  const managerC = await w.person('未来经理 C', org);
  const subject = await w.person('主体员工', org, { directManagerId: managerA.employeeId, place: '原地点' });
  // 迟到直接调动：显式写入当前经理（或显式清空），10-05 计划、10-10 才执行。
  const late = await directBusiness(w, subject.employeeId, {
    kind: 'transfer',
    effectiveDate: '2026-10-05',
    fields: { directManagerId: hasManager ? managerB.employeeId : null, remarks: '迟到调动' },
  });
  const future = await directBusiness(w, subject.employeeId, {
    kind: 'org_adjustment',
    effectiveDate: '2026-10-20',
    fields: { directManagerId: managerC.employeeId },
  });
  await w.publishedProcess({ nodes: [DIRECT] });
  const run = await runEmploymentActivations(
    w.db,
    cmd(),
    { tenantId: w.tenant.id },
    { clock: () => new Date('2026-10-10T01:00:00Z') },
  );
  expect(run.runs[0]).toMatchObject({ failed: [], errors: [] });
  w.setNow('2026-10-10T02:00:00Z');
  const timeline = await records(w, subject.employeeId, '2026-10-10');
  const history = timeline.find((r) => r.effectiveDate < '2026-10-05')!;
  expect(history.fields.directManagerId).toBe(managerA.employeeId);
  expect(timeline.find((r) => r.isCurrent)).toMatchObject({
    id: late.id,
    effectiveDate: '2026-10-10',
    fields: { directManagerId: hasManager ? managerB.employeeId : null },
  });
  expect(timeline.find((r) => r.id === future.id)?.fields.directManagerId).toBe(managerC.employeeId);
  const draft = await w.application(subject.employeeId, { place: '申请地点' }, { effectiveDate: '2026-10-12' });
  if (hasManager) {
    const view = await w.submit(draft);
    expect(w.pending(view)).toEqual([
      expect.objectContaining({ nodeKey: 'manager', assigneeUserId: managerB.userId, origin: 'resolved' }),
    ]);
    return;
  }
  const before = await effects(w);
  const businessBefore = await w.business(draft.id);
  const failed = await w.submitRaw(draft);
  expect(failed.status, await failed.clone().text()).toBe(409);
  expect(await failed.json()).toMatchObject({ error: { details: { reason: 'APPROVAL_FIRST_NODE_EMPTY' } } });
  expect(await effects(w)).toEqual(before);
  expect(await w.business(draft.id)).toEqual(businessBefore);
  expect(await records(w, subject.employeeId, '2026-10-10')).toEqual(timeline);
});
