/**
 * AC-APV-F478-14 仿真按路径推演（设计 §3.4、§8）：虚拟部门不同则路径不同，输出 path / exit / branchNo，
 * 路径外节点 onPath:false；无路由流程的逐节点输出与现状一致（不增加节点字段）；缺少分支条件字段时返回
 * branch:'undetermined' 并停止，不猜路径；仿真仍只收虚拟数据、不产生实例或待办。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { APV, approveTo, direct, otherwise, routeScene, when, type RouteScene } from './AC-APV-F478-support.js';
import { cloneForPut, publishViaHttp, putDraft, withRoutesOn } from './AC-APV-F478-s2-support.js';
import type { ProcessView } from './AC-APV-support.js';

const testDb = useTestDb();

interface SimNode {
  key: string;
  status: string;
  approverUserId: string | null;
  onPath?: boolean;
  exit?: string;
  branchNo?: number | null;
  branch?: string;
}
interface Simulation {
  path: string[];
  nodes: SimNode[];
  startable: boolean;
}

async function simulate(
  s: RouteScene,
  process: ProcessView,
  values: Record<string, string | null>,
  scope = 'published',
) {
  const response = await s.w.request(s.w.hr.id, 'POST', `${APV}/processes/${process.id}/simulate`, {
    body: { scope, data: { values: { processCode: 'TransferProcessNew', ...values } } },
  });
  return s.w.json<Simulation>(response);
}

async function counts(s: RouteScene) {
  return withTenant(s.w.db, s.w.tenant.id, async (tx) => {
    const result = await tx.execute(sql`SELECT
      (SELECT count(*) FROM approval_instances)::int AS instances,
      (SELECT count(*) FROM approval_tasks)::int AS tasks,
      (SELECT count(*) FROM approval_node_activations)::int AS activations`);
    return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows)[0];
  });
}

const ROUTES = (s: RouteScene) => ({ n1: [approveTo(when(1, 'eq', s.depts.d1, 'n3'), otherwise('n2'))] });

describe('AC-APV-F478-14 仿真路径', () => {
  it('虚拟部门 D1 / D2 路径不同：path / exit / branchNo 正确，路径外节点 onPath:false', async () => {
    const s = await routeScene(testDb().db, 'f478-14-path');
    const process = await publishViaHttp(s.w, s.nodes(), ROUTES(s));
    const before = await counts(s);
    const d1 = await simulate(s, process, { 'record.departmentId': s.depts.d1 });
    expect(d1.path).toEqual(['n1', 'n3', 'n4']);
    expect(d1.nodes.map((node) => node.key)).toEqual(['n1', 'n2', 'n3', 'n4']);
    expect(d1.nodes.map((node) => node.onPath)).toEqual([true, false, true, true]);
    expect(d1.nodes[0]).toMatchObject({ exit: 'approve', branchNo: 1, status: 'pass' });
    expect(d1.nodes[1]).not.toHaveProperty('exit');
    expect(d1.nodes[1]).not.toHaveProperty('branchNo');
    expect(d1.nodes[2]).toMatchObject({ exit: 'approve', branchNo: null });
    const d2 = await simulate(s, process, { 'record.departmentId': s.depts.d2 });
    expect(d2.path).toEqual(['n1', 'n2', 'n3', 'n4']);
    expect(d2.nodes.map((node) => node.onPath)).toEqual([true, true, true, true]);
    expect(d2.nodes[0]).toMatchObject({ exit: 'approve', branchNo: 2 });
    expect(await counts(s)).toEqual(before);
  });

  it('路径外节点不进入审批链：后续“与上一节点相同”按路径上的上一节点比较', async () => {
    const s = await routeScene(testDb().db, 'f478-14-chain');
    // N3 与 N1 同一人（路径 N1→N3），N2 是另一个人：N3 开启“与上一节点相同则自动处理”
    const nodes = s.nodes({
      n3: { sameAssigneeSkip: true, historySameAssigneeSkip: false },
    });
    nodes[2] = { ...nodes[2]!, approver: { type: 'specified', value: s.people.n1.userId } };
    const process = await publishViaHttp(s.w, nodes, ROUTES(s));
    const onPath = await simulate(s, process, { 'record.departmentId': s.depts.d1 });
    expect(onPath.nodes[2]).toMatchObject({ key: 'n3', resolution: 'same_skip' });
    const viaN2 = await simulate(s, process, { 'record.departmentId': s.depts.d2 });
    expect(viaN2.nodes[2]).toMatchObject({ key: 'n3', status: 'pass', resolution: 'resolved' });
  });

  it('直达 END：路径只含 N1，其余节点都在路径外（后继节点孤立，只能是草稿；发布会因不可达被拦）', async () => {
    const s = await routeScene(testDb().db, 'f478-14-end');
    const created = await s.w.createProcess({ nodes: s.nodes().slice(0, 3) });
    const body = cloneForPut(created.latestVersion, {
      nodes: withRoutesOn(created.latestVersion.nodes, { n1: [approveTo(direct('END'))] }),
    });
    const saved = await s.w.json<ProcessView>(await putDraft(s.w, created, body));
    const result = await simulate(s, saved, {}, 'latest');
    expect(result.path).toEqual(['n1']);
    expect(result.nodes.map((node) => node.onPath)).toEqual([true, false, false]);
  });

  it('草稿（latest）也可仿真；分支条件字段缺失 → branch:undetermined，路径停在该节点，不猜后续', async () => {
    const s = await routeScene(testDb().db, 'f478-14-undetermined');
    const created = await s.w.createProcess({ nodes: s.nodes() });
    const saved = await s.w.json<ProcessView>(
      await putDraft(
        s.w,
        created,
        cloneForPut(created.latestVersion, { nodes: withRoutesOn(created.latestVersion.nodes, ROUTES(s)) }),
      ),
    );
    const missing = await simulate(s, saved, {}, 'latest');
    expect(missing.path).toEqual(['n1']);
    expect(missing.nodes[0]).toMatchObject({ onPath: true, branch: 'undetermined' });
    expect(missing.nodes[0]).not.toHaveProperty('branchNo');
    expect(missing.nodes.slice(1).map((node) => node.onPath)).toEqual([false, false, false]);
    // 显式给出空值：是已知的“空”，走 Else
    const empty = await simulate(s, saved, { 'record.departmentId': null }, 'latest');
    expect(empty.path).toEqual(['n1', 'n2', 'n3', 'n4']);
    expect(empty.nodes[0]).toMatchObject({ exit: 'approve', branchNo: 2 });
    expect(empty.nodes[0]).not.toHaveProperty('branch');
  });

  it('无路由流程：逐节点输出与现状一致（节点上不增加 onPath / exit / branchNo），path 为全部节点', async () => {
    const s = await routeScene(testDb().db, 'f478-14-linear');
    const process = await s.w.publishedProcess({ nodes: s.nodes() });
    const result = await simulate(s, process, { 'record.departmentId': s.depts.d1 });
    expect(result.path).toEqual(['n1', 'n2', 'n3', 'n4']);
    for (const node of result.nodes) {
      expect(node).not.toHaveProperty('onPath');
      expect(node).not.toHaveProperty('exit');
      expect(node).not.toHaveProperty('branchNo');
      expect(node).not.toHaveProperty('branch');
      expect(node.status).toBe('pass');
    }
    expect(result.nodes.map((node) => node.approverUserId)).toEqual(
      ['n1', 'n2', 'n3', 'n4'].map((key) => s.people[key as 'n1'].userId),
    );
  });
});
