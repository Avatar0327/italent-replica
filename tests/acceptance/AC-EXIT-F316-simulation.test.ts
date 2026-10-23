/** F-316 R2 / AC-APV-11、12：两个仿真入口与交接实际取人策略一致；仿真只读且只用虚拟关系。 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { api, definition, KEYS, POLICIES, publish, reach, world } from './AC-EXIT-F316-support.js';

const database = useTestDb();
type World = Awaited<ReturnType<typeof world>>;
type Mode = 'single' | 'object';
interface Seat {
  approverUserId: string | null;
  resolution: string;
}
interface Simulation {
  startable?: boolean;
  replicaStartable?: boolean;
  replica?: { processId: string };
  nodes?: { key: string; status: string; resolution: string; approvers?: Seat[] }[];
}

async function simulate(x: World, processId: string, mode: Mode, relations: object = {}) {
  const data = {
    values: {},
    initiatorUserId: x.leaverUserId,
    subjectUserId: x.leaverUserId,
    relations: { handover_employee: x.leaverUserId, latest_record_department_hrbp: x.hrbp.userId, ...relations },
  };
  const response =
    mode === 'single'
      ? await api(x, 'POST', `/${processId}/simulate`, undefined, { scope: 'published', data })
      : await x.api.request('POST', '/api/tenant/approval/simulate', {
          ...x.tenantAs(x.processAdmin.id),
          body: { approvalType: 'exit_handover', scope: 'published', data },
        });
  expect(response.status, await response.clone().text()).toBe(200);
  const result = (await response.json()) as Simulation;
  if (mode === 'object') expect(result.replica?.processId).toBe(processId);
  return result;
}

const sideEffects = (x: World) =>
  x.sqlRows(sql`SELECT
  (SELECT count(*) FROM approval_instances)::int AS instances,
  (SELECT count(*) FROM approval_tasks)::int AS tasks,
  (SELECT count(*) FROM approval_notifications)::int AS notifications,
  (SELECT count(*) FROM approval_outbox)::int AS outbox,
  (SELECT count(*) FROM audit_events)::int AS audits`);

describe('AC-EXIT-F316 两个仿真入口复用运行策略', () => {
  for (const mode of ['single', 'object'] as const) {
    it.each(['auto_approve', 'specified', 'stop', 'specified_empty', 'default', 'default_fallback'] as const)(
      `${mode} / %s：两个主取人为空，仿真与实际发起及节点去向一致`,
      async (scenario) => {
        const x = await world(database().db, `sim-${mode}-${scenario}`, false);
        const policy = scenario.startsWith('default')
          ? undefined
          : scenario === 'specified_empty'
            ? 'specified'
            : scenario;
        const fallback = scenario === 'specified' || scenario === 'default_fallback';
        const process = await publish(
          x,
          definition(x, {
            work_handover: { emptyApproverPolicy: policy, fallbackUserIds: fallback ? [x.workOwner.userId] : [] },
            other_handover: {
              emptyApproverPolicy: policy === 'stop' ? 'exception_admin' : policy,
              fallbackUserIds: fallback ? [x.hrbp.userId] : [],
            },
          }),
        );
        const run = await reach(x, 'work_handover', false);
        const startable = scenario === 'auto_approve' || fallback;
        expect(run.request.state).toBe(startable ? 'in_progress' : 'not_launched');
        if (scenario === 'auto_approve') {
          expect((await x.pendingNode(run.instanceId))?.nodeKey).toBe('employee_confirm');
        } else if (fallback) {
          expect(await x.pendingTasks(run.instanceId)).toEqual([
            expect.objectContaining({ nodeKey: KEYS[0], userId: x.workOwner.userId }),
          ]);
          expect((await x.decide(run.instanceId)).status).toBe(200);
          expect(await x.pendingTasks(run.instanceId)).toEqual([
            expect.objectContaining({ nodeKey: KEYS[1], userId: x.hrbp.userId }),
          ]);
        }
        const before = await sideEffects(x);
        const result = await simulate(x, process.id, mode);
        expect(mode === 'single' ? result.startable : result.replicaStartable).toBe(startable);
        if (mode === 'single') {
          const seats = result.nodes!.slice(0, 2).map((node) => node.approvers);
          if (scenario === 'auto_approve') {
            expect(seats).toEqual(
              KEYS.map(() => [
                expect.objectContaining({
                  approverUserId: null,
                  resolution: 'no_assignee_approve',
                }),
              ]),
            );
            expect(result.nodes!.slice(0, 2).map((node) => node.resolution)).toEqual([
              'no_assignee_approve',
              'no_assignee_approve',
            ]);
          } else if (fallback) {
            expect(seats).toEqual(
              [x.workOwner.userId, x.hrbp.userId].map((approverUserId) => [
                expect.objectContaining({ approverUserId, resolution: 'resolved' }),
              ]),
            );
          } else {
            expect(seats[0]).toEqual([
              expect.objectContaining({
                approverUserId: null,
                resolution: scenario === 'default' ? 'first_node_empty' : 'no_assignee',
              }),
            ]);
            expect(seats[1]).toEqual([
              expect.objectContaining({
                approverUserId: x.exceptionAdmin.id,
                resolution: 'exception_admin',
              }),
            ]);
          }
        }
        expect(await sideEffects(x)).toEqual(before);
      },
    );
  }

  it.each([0, 1, 2])('三选项第 %i 项：主取人非空时始终使用虚拟主取人，不追加指定人员', async (index) => {
    const x = await world(database().db, `sim-primary-${index}`);
    const process = await publish(
      x,
      definition(
        x,
        Object.fromEntries(
          KEYS.map((key) => [
            key,
            {
              emptyApproverPolicy: POLICIES[key][index],
              fallbackUserIds: [x.workOwner.userId, x.hrbp.userId],
            },
          ]),
        ),
      ),
    );
    const [work, other] = [randomUUID(), randomUUID()];
    const result = await simulate(x, process.id, 'single', { handover_work_owner: work, handover_hr_admin: other });
    expect(result.startable).toBe(true);
    expect(result.nodes!.slice(0, 2).map((node) => node.approvers)).toEqual(
      [work, other].map((approverUserId) => [expect.objectContaining({ approverUserId, resolution: 'resolved' })]),
    );
  });

  it('指定人员是配置中的虚拟账号，不查真实资格；同节点任一主取人非空则忽略其他空表达式', async () => {
    const x = await world(database().db, 'sim-virtual');
    const specified = x.workOwner.userId;
    const primary = randomUUID();
    const process = await publish(
      x,
      definition(x, {
        work_handover: { emptyApproverPolicy: 'specified', fallbackUserIds: [specified, specified] },
        other_handover: {
          emptyApproverPolicy: 'auto_approve',
          approvers: ['handover_hr_admin', 'record_department_hrbp'],
        },
      }),
    );
    await withTenant(x.db, x.tenantId, (tx) =>
      tx.execute(sql`UPDATE tenant_memberships SET status='revoked'
      WHERE tenant_id=${x.tenantId} AND user_id=${specified}::uuid`),
    );
    const result = await simulate(x, process.id, 'single', { record_department_hrbp: primary });
    expect(result.startable).toBe(true);
    expect(result.nodes!.slice(0, 2).map((node) => node.approvers)).toEqual(
      [specified, primary].map((approverUserId) => [
        expect.objectContaining({ approverUserId, resolution: 'resolved' }),
      ]),
    );
  });
});
