/** S7d：对象查看者的草稿模拟按有效值，虚拟输入优先，不披露人工或外部流程变量。 */
import { APPROVAL_PROCESS_OBJECT, sourceKey } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL,
  autoAt,
  create,
  draftOk,
  newVersion,
  placeholder,
  publicVar,
  s4World,
  specified,
} from './AC-APV-F326-S7a-support.js';
import { variable } from './AC-APV-F326-S4-support.js';
import { tenantApi } from './support/tenant-api.js';
const database = useTestDb();

describe('AC-APV-F326-37 草稿模拟有效值', () => {
  it('latest 取待生效人，published 仍取默认；人工 / 外部变量为空；虚拟值（含空）优先', async () => {
    const w = await s4World(database().db, 's7d-simulation');
    const viewer = await w.member('合成查看者');
    const next = await w.person('合成待生效人', w.staff);
    const manual = await variable(w);
    const foreign = await w.publish(
      await create(w, [{ key: 'f', approver: specified(w.head.userId) }], { approvalType: 'personnel_change' }),
    );
    const foreignVar = await autoAt(w, foreign.id, 'f');
    const nodes = [
      { key: 'own', approver: specified(w.near.userId) },
      { key: 'manual', approver: publicVar(manual.id) },
      { key: 'foreign', approver: publicVar(foreignVar.id) },
    ];
    const p = await w.publish(await create(w, nodes, { priority: 9 }));
    const own = await autoAt(w, p.id, 'own');
    const saved = await draftOk(w, await newVersion(w, p), [
      { ...nodes[0]!, approver: specified(next.userId) },
      ...nodes.slice(1),
      { key: 'same_variable_other_slot', approver: publicVar(own.id) },
    ]);
    const api = tenantApi(w.db, {
      clock: w.clock,
      authorize: (q) => q.userId === viewer && q.action === 'object.view' && q.resource === APPROVAL_PROCESS_OBJECT,
    });
    const simulate = async (scope = 'latest', extra = {}, byObject = false) => {
      const response = await api.request(
        'POST',
        byObject ? `${APPROVAL}/simulate` : `${APPROVAL}/processes/${p.id}/simulate`,
        {
          ...w.as(viewer),
          body: { scope, ...(byObject ? { approvalType: 'transfer' } : {}), data: { values: {}, ...extra } },
        },
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return response.json() as Promise<{
        startable: boolean;
        replicaStartable: boolean;
        nodes: { approverUserId: string | null; resolution: string }[];
      }>;
    };
    const latest = await simulate();
    expect(latest.nodes[0]).toMatchObject({ approverUserId: next.userId, resolution: 'resolved' });
    expect((await simulate('published')).nodes[0]!.approverUserId).toBe(w.near.userId);
    for (const node of latest.nodes.slice(1, 3)) {
      expect(node.resolution).toBe('exception_admin');
      expect([w.near.userId, w.head.userId]).not.toContain(node.approverUserId);
    }
    expect(latest.nodes[3]!.approverUserId).toBe(w.near.userId);
    const key = sourceKey(saved.latestVersion.nodes[0]!.approver!);
    expect((await simulate('latest', { sourceRelations: { [key]: [w.head.userId] } })).nodes[0]!.approverUserId).toBe(
      w.head.userId,
    );
    expect((await simulate('latest', { sourceRelations: { [key]: [] } })).startable).toBe(false);
    await draftOk(w, saved, [{ ...nodes[0]!, approver: placeholder }, ...nodes.slice(1)]);
    expect((await simulate()).startable).toBe(false);
    expect((await simulate('latest', {}, true)).replicaStartable).toBe(false);
    expect((await simulate('published', {}, true)).replicaStartable).toBe(true);
  });
});
