/**
 * AC-APV-F326-15（F-326 S5，设计 §3.7）：模拟的两条取值路径。
 * 默认只收虚拟数据，只有流程对象查看权的账号看不到变量 / 矩阵里的真实用户；`resolveCurrentSources: true` 才读当前值，
 * 且服务端在处理器内再校验流程管理员。四种组合都只读，不落库。全部经真实 HTTP（createApp）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { APPROVAL_PROCESS_OBJECT, sourceKey } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { AuthorizationRequest } from '../../apps/api/src/authorization.js';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import {
  APPROVAL,
  counter,
  matrix,
  matrixSource,
  s4World,
  variable,
  varSource,
  type S4World,
} from './AC-APV-F326-S4-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();

/** 只有流程对象查看权的账号：只放行对象查看，其余（含流程管理员能力）一律拒绝。 */
const objectViewerOnly = (userId: string) => (q: AuthorizationRequest) =>
  q.userId === userId && q.action === 'object.view' && q.resource === APPROVAL_PROCESS_OBJECT;

async function scene(label: string) {
  const w = await s4World(database().db, label);
  const viewer = await w.member('合成对象查看者');
  const fromVariable = await variable(w);
  const m = await matrix(w, { rows: [{ cond: [], role: [w.head.userId] }] });
  const process = await w.publishedProcess({
    nodes: [counter([varSource('public_variable', fromVariable.id), matrixSource(m, m.roleId)])],
  });
  const virtual = randomUUID();
  const api = (as: string) =>
    tenantApi(w.db, {
      authorize: as === viewer ? objectViewerOnly(viewer) : () => true,
      clock: w.clock,
    });
  const simulate = (as: string, body: Record<string, unknown>, byObject = false) =>
    api(as).request('POST', byObject ? `${APPROVAL}/simulate` : `${APPROVAL}/processes/${process.id}/simulate`, {
      ...w.as(as),
      body: byObject ? { approvalType: 'transfer', ...body } : body,
    });
  return { w, viewer, process, virtual, simulate, variableUser: w.near.userId, matrixUser: w.head.userId };
}

async function counts(w: S4World) {
  return withTenant(w.db, w.tenant.id, async (tx) =>
    rowsOf<Record<string, number>>(
      await tx.execute(sql`SELECT
        (SELECT count(*) FROM command_ledger)::int AS ledger,
        (SELECT count(*) FROM audit_operation_logs)::int AS audit,
        (SELECT count(*) FROM approval_instances)::int AS instances,
        (SELECT count(*) FROM approval_tasks)::int AS tasks,
        (SELECT count(*) FROM approval_outbox)::int AS outbox,
        (SELECT sum(revision) FROM approval_variables)::int AS variables,
        (SELECT sum(revision) FROM approval_matrices)::int AS matrices,
        (SELECT sum(revision) FROM approval_processes)::int AS processes`),
    ),
  ).then((rows) => rows[0]!);
}

const seats = (body: { nodes: { approvers?: { approverUserId: string | null }[] }[] }) =>
  body.nodes[0]!.approvers!.map((seat) => seat.approverUserId);
const run = async (response: Response) => {
  expect(response.status, await response.clone().text()).toBe(200);
  const text = await response.text();
  return { text, body: JSON.parse(text) as { nodes: { approvers?: { approverUserId: string | null }[] }[] } };
};

describe('AC-APV-F326-15 模拟：虚拟路径与当前值路径', () => {
  it.each([false, true])(
    '① 对象查看者省略 sourceRelations：审批人为空，响应全文没有真实用户（按对象 %s）',
    async (byObject) => {
      const s = await scene(`sim-viewer-${byObject}`);
      const before = await counts(s.w);
      const { text, body } = await run(
        await s.simulate(s.viewer, { scope: 'published', data: { values: {} } }, byObject),
      );
      if (!byObject) {
        expect(seats(body)).not.toContain(s.variableUser);
        expect(seats(body)).not.toContain(s.matrixUser);
      }
      // 响应全文：变量默认值 / 矩阵角色格里的用户 id 不得出现在任何字段里
      expect(text).not.toContain(s.variableUser);
      expect(text).not.toContain(s.matrixUser);
      expect(await counts(s.w)).toEqual(before);
    },
  );

  it('① 给了虚拟值时以虚拟值为准（仍不读真实值）', async () => {
    const s = await scene('sim-viewer-virtual');
    const sources = { [sourceKey(s.process.currentVersion!.nodes[0]!.approvers![0]!)]: [s.virtual] };
    const { text, body } = await run(
      await s.simulate(s.viewer, { scope: 'published', data: { values: {}, sourceRelations: sources } }),
    );
    expect(seats(body)).toContain(s.virtual);
    expect(text).not.toContain(s.variableUser);
    expect(text).not.toContain(s.matrixUser);
  });

  it.each([false, true])('② 对象查看者带 resolveCurrentSources：403，不返回部分结果（按对象 %s）', async (byObject) => {
    const s = await scene(`sim-viewer-flag-${byObject}`);
    const before = await counts(s.w);
    const response = await s.simulate(
      s.viewer,
      { scope: 'published', data: { values: {} }, resolveCurrentSources: true },
      byObject,
    );
    expect(response.status).toBe(403);
    const text = await response.text();
    const error = (JSON.parse(text) as { error: { code: string; details: { reason?: string } } }).error;
    expect(error.code).toBe('FORBIDDEN');
    expect(error.details.reason).toBe('APPROVAL_SIMULATION_CURRENT_ADMIN_ONLY');
    expect(text).not.toContain(s.variableUser);
    expect(text).not.toContain(s.matrixUser);
    expect(await counts(s.w)).toEqual(before);
  });

  it('③ 流程管理员带 resolveCurrentSources：按变量当前值与矩阵当前内容给出审批人，且只读', async () => {
    const s = await scene('sim-admin-flag');
    const before = await counts(s.w);
    const { body } = await run(
      await s.simulate(s.w.hr.id, { scope: 'published', data: { values: {} }, resolveCurrentSources: true }),
    );
    expect(seats(body).sort()).toEqual([s.variableUser, s.matrixUser].sort());
    expect(await counts(s.w)).toEqual(before);
  });

  it('③ 按对象模拟：管理员带标志时，命中流程的预检按当前值通过', async () => {
    const s = await scene('sim-admin-flag-object');
    const response = await s.simulate(
      s.w.hr.id,
      { scope: 'published', data: { values: { processCode: 'TransferProcessNew' } }, resolveCurrentSources: true },
      true,
    );
    const { body } = (await run(response)) as unknown as { body: { replicaStartable: boolean } };
    expect(body.replicaStartable).toBe(true);
  });

  it('④ 流程管理员不带标志：与 ① 相同，只用虚拟值', async () => {
    const s = await scene('sim-admin-noflag');
    const before = await counts(s.w);
    const { text, body } = await run(await s.simulate(s.w.hr.id, { scope: 'published', data: { values: {} } }));
    expect(seats(body)).not.toContain(s.variableUser);
    expect(text).not.toContain(s.variableUser);
    expect(text).not.toContain(s.matrixUser);
    expect(await counts(s.w)).toEqual(before);
  });

  it('当前值路径：虚拟值优先；矩阵条件取虚拟部门，不读真实任职', async () => {
    const s = await scene('sim-admin-details');
    const [varRef] = s.process.currentVersion!.nodes[0]!.approvers!;
    const sourceRelations = { [sourceKey(varRef!)]: [s.virtual] };
    const { body } = await run(
      await s.simulate(s.w.hr.id, {
        scope: 'published',
        data: { values: {}, sourceRelations },
        resolveCurrentSources: true,
      }),
    );
    expect(seats(body).sort()).toEqual([s.virtual, s.matrixUser].sort());

    // 条件列限定到某个部门：虚拟输入的部门命中才给人
    const conditional = await matrix(s.w, { rows: [{ cond: [s.w.child], role: [s.w.head.userId] }] });
    const scoped = await s.w.publishedProcess({
      priority: 5,
      nodes: [counter([matrixSource(conditional, conditional.roleId)])],
    });
    const hit = await s.w.request(s.w.hr.id, 'POST', `${APPROVAL}/processes/${scoped.id}/simulate`, {
      body: {
        scope: 'published',
        data: { values: { 'record.departmentId': s.w.child } },
        resolveCurrentSources: true,
      },
    });
    expect(seats((await run(hit)).body)).toEqual([s.matrixUser]);
    const miss = await s.w.request(s.w.hr.id, 'POST', `${APPROVAL}/processes/${scoped.id}/simulate`, {
      body: { scope: 'published', data: { values: {} }, resolveCurrentSources: true },
    });
    expect(seats((await run(miss)).body)).not.toContain(s.matrixUser);
  });
});
