/**
 * AC-APV-F478-12（F-478 S4，设计 §3.3 / §10）：退休 HRBP 与直线经理同人、HRBP 节点开 sameAssigneeSkip 时，
 * 自动处理按守卫唯一出口流转：返聘单进入返聘后节点，不返聘单结束；审批记录含出口与原因。
 * 真实 HTTP + 真实库 + 合成数据；办理走审批中心真实接口。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { cloneForPut, putDraft, withRoutesOn } from './AC-APV-F478-s2-support.js';
import { retireScene, type RetireScene } from './AC-APV-F478-s4-support.js';
import type { NodeInput, ProcessView } from './AC-APV-support.js';

const testDb = useTestDb();

/** 直线经理节点与 HRBP 节点是同一个人（原直线经理），HRBP 节点开“相同审批人自动处理 = 同意”。 */
async function publishSamePersonFlow(s: RetireScene) {
  const person = { type: 'specified', value: s.manager };
  const nodes = [
    { key: 'direct_head', name: '直线经理', approver: person, actions: { avoidSelf: false, avoidSubjects: false } },
    {
      key: 'hr_interview',
      name: 'HRBP',
      approver: person,
      sameAssigneeSkip: true,
      sameAssigneeResult: 'approve',
      exits: ['approve_no_rehire', 'approve_rehire'],
      actions: { avoidSelf: false, avoidSubjects: false },
    },
    { key: 'rehire_manager', name: '返聘后直线经理', approver: { type: 'specified', value: s.back.manager } },
  ] as NodeInput[];
  const created = await s.w.createProcess({
    approvalType: 'retirement',
    conditions: { items: [] },
    isFallback: true,
    nodes,
  });
  const routes = {
    hr_interview: [
      { exit: 'approve_no_rehire', branches: [{ kind: 'direct', target: 'END' }] },
      { exit: 'approve_rehire', branches: [{ kind: 'direct', target: 'rehire_manager' }] },
    ],
  } as never;
  const saved = await s.w.json<ProcessView>(
    await putDraft(
      s.w,
      created,
      cloneForPut(created.latestVersion, { nodes: withRoutesOn(created.latestVersion.nodes, routes) }),
    ),
  );
  return s.w.publish(saved);
}

describe('AC-APV-F478-12 同人自动处理按守卫取出口', () => {
  it('reEmployed=true：直线经理办完，HRBP 节点自动同意（同时返聘），待办落在返聘后直线经理；日志含出口与原因', async () => {
    const s = await retireScene(testDb().db, 'f478-12-yes');
    await publishSamePersonFlow(s);
    const first = await s.retire(true);
    expect(s.w.pending(first).map((t) => t.nodeKey)).toEqual(['direct_head']);
    const after = await s.advance(first);
    expect(after.status).toBe('running');
    expect(s.w.pending(after).map((t) => [t.nodeKey, t.assigneeUserId])).toEqual([['rehire_manager', s.back.manager]]);
    const auto = after.logs.find((log) => log.nodeKey === 'hr_interview' && log.event === 'auto_approve');
    expect(auto?.detail).toMatchObject({ exit: 'approve_rehire' });
    expect(auto?.detail.reason).toBeTruthy();
  });

  it('reEmployed=false：自动同意（不返聘）后流程结束并通过，不进入返聘后节点', async () => {
    const s = await retireScene(testDb().db, 'f478-12-no');
    await publishSamePersonFlow(s);
    const first = await s.retire(false);
    const after = await s.advance(first);
    expect(after.status).toBe('approved');
    expect(s.w.pending(after)).toEqual([]);
    const auto = after.logs.find((log) => log.nodeKey === 'hr_interview' && log.event === 'auto_approve');
    expect(auto?.detail).toMatchObject({ exit: 'approve_no_rehire' });
  });
});
