/**
 * AC-APV-F326-37 的已发布值子集（DEC-919：S7d 的最小一块前移到 S7a）。
 * 模拟（虚拟路径）里，被模拟流程**自己的**自动变量取已发布的默认值，是“虚拟账号”，不查真实资格；
 * 人工公共变量、其他流程的自动变量仍按 §3.7 取空（不回退 AC-15）；带 `resolveCurrentSources` 的当前值路径不变。
 * 待生效值（草稿模拟）随 S7e，不在这里。全部经真实 HTTP，只用合成数据。
 */
import { sql, withTenant } from '@italent/db';
import { APPROVAL_PROCESS_OBJECT, sourceKey } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { AuthorizationRequest } from '../../apps/api/src/authorization.js';
import type { NodeInput } from './AC-APV-support.js';
import { APPROVAL, autoAt, create, publicVar, s4World, specified } from './AC-APV-F326-S7a-support.js';
import { variable } from './AC-APV-F326-S4-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const single = (key: string, approver: NodeInput['approver']): NodeInput => ({ key, name: `节点${key}`, approver });

/** 只有流程对象查看权的账号：只放行对象查看，其余一律拒绝（同 AC-15）。 */
const objectViewerOnly = (userId: string) => (q: AuthorizationRequest) =>
  q.userId === userId && q.action === 'object.view' && q.resource === APPROVAL_PROCESS_OBJECT;

interface Result {
  startable?: boolean;
  replicaStartable?: boolean;
  nodes?: { approverUserId: string | null; resolution: string }[];
}

async function scene(label: string) {
  const w = await s4World(database().db, label);
  const viewer = await w.member('合成对象查看者');
  const own = await w.person('合成指定审批人', w.staff);
  const manual = await variable(w, { defaultValue: w.near.userId });
  const foreign = await w.publish(await create(w, [single('f1', specified(w.head.userId))]));
  const foreignVariable = await autoAt(w, foreign.id, 'f1');
  const process = await w.publish(
    await create(
      w,
      [
        single('own', specified(own.userId)),
        single('manual', publicVar(manual.id)),
        single('foreign', publicVar(foreignVariable.id)),
      ],
      { priority: 5 },
    ),
  );
  const api = (as: string) =>
    tenantApi(w.db, { authorize: as === viewer ? objectViewerOnly(viewer) : () => true, clock: w.clock });
  const simulate = async (as: string, byObject: boolean, extra: Record<string, unknown> = {}) => {
    const body = { scope: 'published', data: { values: {} }, ...extra };
    const response = await api(as).request(
      'POST',
      byObject ? `${APPROVAL}/simulate` : `${APPROVAL}/processes/${process.id}/simulate`,
      {
        ...w.as(as),
        body: byObject ? { approvalType: 'transfer', ...body } : body,
      },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Result;
  };
  const revoke = (userId: string) =>
    withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`UPDATE tenant_memberships SET status='revoked'
        WHERE tenant_id=${w.tenant.id}::uuid AND user_id=${userId}::uuid`),
    );
  return { w, viewer, own, manual, process, simulate, revoke };
}

describe('AC-APV-F326-37（已发布值子集，DEC-919）本流程自动变量在模拟里取已发布值', () => {
  it.each([false, true])(
    '对象查看者不给 sourceRelations：本流程自动变量取默认值，人工变量与其他流程自动变量仍为空（按对象 %s）',
    async (byObject) => {
      const s = await scene(`s7a-sim-${byObject}`);
      const result = await s.simulate(s.viewer, byObject);
      if (byObject) {
        // 按对象模拟只返回命中与可提交结论：首节点取到指定人员才可提交
        expect(result.replicaStartable).toBe(true);
        return;
      }
      expect(result.startable).toBe(true);
      expect(result.nodes![0]).toMatchObject({ approverUserId: s.own.userId, resolution: 'resolved' });
      // 人工公共变量、其他流程的自动变量：与 AC-15 一样不泄露真实用户，落到空人策略（异常管理员），不是 resolved
      for (const seat of result.nodes!.slice(1)) {
        expect(seat.resolution).toBe('exception_admin');
        expect(seat.approverUserId).not.toBe(s.w.near.userId);
        expect(seat.approverUserId).not.toBe(s.w.head.userId);
      }
    },
  );

  it('虚拟账号不查真实资格：指定人员的成员身份已撤销，仍算候选', async () => {
    const s = await scene('s7a-sim-virtual');
    await s.revoke(s.own.userId);
    const result = await s.simulate(s.viewer, false);
    expect(result.startable).toBe(true);
    expect(result.nodes![0]).toMatchObject({ approverUserId: s.own.userId, resolution: 'resolved' });
  });

  it('本流程自动变量被停用：与运行时一致，按没有人', async () => {
    const s = await scene('s7a-sim-disabled');
    await withTenant(s.w.db, s.w.tenant.id, (tx) =>
      tx.execute(sql`UPDATE approval_variables SET status='disabled'
        WHERE tenant_id=${s.w.tenant.id}::uuid AND origin='auto' AND origin_process_id=${s.process.id}::uuid`),
    );
    const result = await s.simulate(s.viewer, false);
    expect(result.startable).toBe(false);
    expect(result.nodes![0]!.approverUserId).toBeNull();
  });

  it('调用方给了虚拟值时以虚拟值为准', async () => {
    const s = await scene('s7a-sim-override');
    const virtual = s.w.near.userId;
    const key = sourceKey(s.process.currentVersion!.nodes[0]!.approver!);
    const result = await s.simulate(s.viewer, false, { data: { values: {}, sourceRelations: { [key]: [virtual] } } });
    expect(result.nodes![0]).toMatchObject({ approverUserId: virtual, resolution: 'resolved' });
  });

  it('当前值路径不变：流程管理员带 resolveCurrentSources，撤销成员身份的人按真实资格被过滤', async () => {
    const s = await scene('s7a-sim-current');
    const before = await s.simulate(s.w.hr.id, false, { resolveCurrentSources: true });
    expect(before.nodes![0]).toMatchObject({ approverUserId: s.own.userId, resolution: 'resolved' });
    await s.revoke(s.own.userId);
    const after = await s.simulate(s.w.hr.id, false, { resolveCurrentSources: true });
    expect(after.startable).toBe(false);
    expect(after.nodes![0]!.approverUserId).toBeNull();
  });
});
