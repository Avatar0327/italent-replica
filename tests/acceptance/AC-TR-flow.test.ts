/**
 * AC-TR-flow · R3-T04 PR-B3 盘点流程定义（设计 §2.2 flows / nodes / node_roles、§7 流程定义 CRUD 行；DEC-304）：
 * 节点随流程整组提交；node_key 流程内唯一、保存后不可改（带 id 的节点 key 与库中不一致 400）；
 * countersign 只能 evaluate + single；single 恰一个角色、countersign ≥ 1；角色被节点引用时拒删；
 * 被模板引用拒删的守卫由 B6 登记（修改流程不影响已有模板版本，快照在 B6）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerConfigReferenceGuard } from '../../apps/api/src/modules/talent-review/config-kit.js';
import { FLOWS, flowBody, formFlowWorld, type FlowView, nodeBody, reasonOf } from './AC-TR-form-flow-support.js';
import { errorCode } from './support/tenant-api.js';

const testDb = useTestDb();
const referenced = new Set<string>();
registerConfigReferenceGuard('flow', async (_tx, _tenantId, id) => (referenced.has(id) ? 'TEST_TEMPLATE' : null));

describe('盘点流程定义 CRUD', () => {
  it('新建：节点按提交顺序、角色按提交顺序；动作缺省关；详情与列表一致', async () => {
    const w = await formFlowWorld(testDb().db, 'trl-create');
    const [r1, r2, r3] = [await w.role(), await w.role(), await w.role()];
    const nodes = [
      nodeBody([r1.id], { nodeKey: 'self', allowReturn: true }),
      nodeBody([r2.id, r3.id], { nodeKey: 'peer', kind: 'countersign', allowTransfer: true, allowDisagree: true }),
      nodeBody([r1.id], { nodeKey: 'cal', stepType: 'calibrate', mode: 'batch' }),
    ];
    const response = await w.post(FLOWS, flowBody(nodes, { name: '三步流程' }));
    expect(response.status, await response.clone().text()).toBe(201);
    const created = (await response.json()) as FlowView;
    expect(created).toMatchObject({ name: '三步流程', enabled: true, revision: 1 });
    expect(created.nodes.map((node) => node.nodeKey)).toEqual(['self', 'peer', 'cal']);
    expect(created.nodes[0]).toMatchObject({
      kind: 'single',
      stepType: 'evaluate',
      mode: 'single',
      allowReturn: true,
      allowTransfer: false,
      allowDisagree: false,
      roleIds: [r1.id],
    });
    expect(created.nodes[1]).toMatchObject({ kind: 'countersign', roleIds: [r2.id, r3.id], allowDisagree: true });
    expect(created.nodes[2]).toMatchObject({ stepType: 'calibrate', mode: 'batch' });
    expect((await w.read<FlowView>(FLOWS, created.id)).body).toEqual(created);
    expect((await w.list<FlowView>(FLOWS)).items).toEqual([created]);
  });

  it('节点约束：countersign 只能 evaluate + single；single 恰一个角色；countersign ≥ 1；key 流程内唯一', async () => {
    const w = await formFlowWorld(testDb().db, 'trl-rules');
    const [r1, r2] = [await w.role(), await w.role()];
    const cases: [string, Record<string, unknown>[]][] = [
      ['FLOW_COUNTERSIGN_INVALID', [nodeBody([r1.id], { kind: 'countersign', stepType: 'calibrate' })]],
      ['FLOW_COUNTERSIGN_INVALID', [nodeBody([r1.id], { kind: 'countersign', mode: 'batch' })]],
      ['FLOW_ROLE_COUNT_INVALID', [nodeBody([])]],
      ['FLOW_ROLE_COUNT_INVALID', [nodeBody([r1.id, r2.id])]],
      ['FLOW_ROLE_COUNT_INVALID', [nodeBody([], { kind: 'countersign' })]],
      ['FLOW_NODE_KEY_DUPLICATE', [nodeBody([r1.id], { nodeKey: 'x' }), nodeBody([r2.id], { nodeKey: 'x' })]],
      ['FLOW_ROLE_DUPLICATE', [nodeBody([r1.id, r1.id], { kind: 'countersign' })]],
    ];
    for (const [reason, nodes] of cases) {
      const response = await w.post(FLOWS, flowBody(nodes));
      expect([response.status, await reasonOf(response)], reason).toEqual([400, reason]);
    }
    const empty = await w.post(FLOWS, flowBody([]));
    expect(empty.status).toBe(400);
    const badKey = await w.post(FLOWS, flowBody([nodeBody([r1.id], { nodeKey: 'Bad Key' })]));
    expect(badKey.status).toBe(400);
    expect((await w.list<FlowView>(FLOWS)).items).toEqual([]);
  });

  it('node_key 不可改：带 id 的节点 key 变化 400 FLOW_NODE_KEY_IMMUTABLE；其他属性可改、id 稳定', async () => {
    const w = await formFlowWorld(testDb().db, 'trl-key');
    const [r1, r2] = [await w.role(), await w.role()];
    const flow = await w.createFlow({}, [r1.id]);
    const node = flow.nodes[0]!;
    const renamed = await w.request('PATCH', `${FLOWS}/${flow.id}`, {
      ifMatch: 1,
      body: { nodes: [{ ...node, nodeKey: 'changed' }] },
    });
    expect([renamed.status, await reasonOf(renamed)]).toEqual([400, 'FLOW_NODE_KEY_IMMUTABLE']);
    const edited = await w.request('PATCH', `${FLOWS}/${flow.id}`, {
      ifMatch: 1,
      body: { nodes: [{ ...node, name: '新名称', roleIds: [r2.id], allowReturn: true }] },
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    const after = (await edited.json()) as FlowView;
    expect(after.revision).toBe(2);
    expect(after.nodes).toEqual([{ ...node, name: '新名称', roleIds: [r2.id], allowReturn: true }]);
  });

  it('修改节点集合：带 id 保留、不带 id 新增、缺席的删除；id 不属于本流程 400 FLOW_NODE_NOT_FOUND', async () => {
    const w = await formFlowWorld(testDb().db, 'trl-nodes');
    const role = await w.role();
    const flow = await w.post(
      FLOWS,
      flowBody([nodeBody([role.id], { nodeKey: 'a' }), nodeBody([role.id], { nodeKey: 'b' })]),
    );
    const created = (await flow.json()) as FlowView;
    const [a] = created.nodes;
    const response = await w.request('PATCH', `${FLOWS}/${created.id}`, {
      ifMatch: 1,
      body: { nodes: [nodeBody([role.id], { nodeKey: 'c' }), a] },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const after = (await response.json()) as FlowView;
    expect(after.nodes.map((node) => node.nodeKey)).toEqual(['c', 'a']);
    expect(after.nodes[1]!.id).toBe(a!.id);
    const foreign = await w.request('PATCH', `${FLOWS}/${created.id}`, {
      ifMatch: 2,
      body: { nodes: [{ ...nodeBody([role.id], { nodeKey: 'z' }), id: '00000000-0000-4000-8000-000000000000' }] },
    });
    expect([foreign.status, await reasonOf(foreign)]).toEqual([400, 'FLOW_NODE_NOT_FOUND']);
    const clash = await w.request('PATCH', `${FLOWS}/${created.id}`, {
      ifMatch: 2,
      body: { nodes: [after.nodes[0]!, nodeBody([role.id], { nodeKey: 'c' })] },
    });
    expect([clash.status, await reasonOf(clash)]).toEqual([400, 'FLOW_NODE_KEY_DUPLICATE']);
  });

  it('角色：不存在 404；新引用已停用角色 400 FLOW_ROLE_DISABLED；角色被节点引用拒删 409 ROLE_IN_USE', async () => {
    const w = await formFlowWorld(testDb().db, 'trl-roles');
    const missing = await w.post(FLOWS, flowBody([nodeBody(['00000000-0000-4000-8000-000000000000'])]));
    expect(missing.status).toBe(404);
    const [live, off] = [await w.role(), await w.role()];
    expect((await w.request('PATCH', `/roles/${off.id}`, { ifMatch: 1, body: { enabled: false } })).status).toBe(200);
    const disabled = await w.post(FLOWS, flowBody([nodeBody([off.id])]));
    expect([disabled.status, await reasonOf(disabled)]).toEqual([400, 'FLOW_ROLE_DISABLED']);
    const flow = await w.createFlow({}, [live.id]);
    const blocked = await w.request('DELETE', `/roles/${live.id}`, { ifMatch: 1 });
    expect([blocked.status, await reasonOf(blocked)]).toEqual([409, 'ROLE_IN_USE']);
    const other = await w.role();
    const moved = await w.request('PATCH', `${FLOWS}/${flow.id}`, {
      ifMatch: 1,
      body: { nodes: [{ ...flow.nodes[0]!, roleIds: [other.id] }] },
    });
    expect(moved.status).toBe(200);
    expect((await w.request('DELETE', `/roles/${live.id}`, { ifMatch: 1 })).status).toBe(200);
  });

  it('停用角色按“原节点 × 角色”判定保留：原节点保留可改，新增节点 / 转配给其他节点 / 删除重建都 400 FLOW_ROLE_DISABLED（审查第 1 轮 P2-01）', async () => {
    const w = await formFlowWorld(testDb().db, 'trl-disabled-per-node');
    const [off, other] = [await w.role(), await w.role()];
    const created = (await (
      await w.post(FLOWS, flowBody([nodeBody([off.id], { nodeKey: 'a' }), nodeBody([other.id], { nodeKey: 'b' })]))
    ).json()) as FlowView;
    const [a, b] = created.nodes as [FlowView['nodes'][number], FlowView['nodes'][number]];
    expect((await w.request('PATCH', `/roles/${off.id}`, { ifMatch: 1, body: { enabled: false } })).status).toBe(200);
    const patch = (ifMatch: number, nodes: unknown[]) =>
      w.request('PATCH', `${FLOWS}/${created.id}`, { ifMatch, body: { nodes } });
    // 原节点保留停用角色、只改其他属性：允许
    const kept = await patch(1, [{ ...a, name: '改名' }, b]);
    expect(kept.status, await kept.clone().text()).toBe(200);
    const before = (await w.read<FlowView>(FLOWS, created.id)).body;
    // 新增节点选用停用角色
    const added = await patch(2, [a, b, nodeBody([off.id], { nodeKey: 'c' })]);
    expect([added.status, await reasonOf(added)]).toEqual([400, 'FLOW_ROLE_DISABLED']);
    // 把停用角色转配给已有的另一个节点（countersign 同样）
    const moved = await patch(2, [a, { ...b, kind: 'countersign', roleIds: [other.id, off.id] }]);
    expect([moved.status, await reasonOf(moved)]).toEqual([400, 'FLOW_ROLE_DISABLED']);
    // 删除旧节点后不带 id 重建（等于新增关系）
    const rebuilt = await patch(2, [nodeBody([off.id], { nodeKey: 'a' }), b]);
    expect([rebuilt.status, await reasonOf(rebuilt)]).toEqual([400, 'FLOW_ROLE_DISABLED']);
    expect((await w.read<FlowView>(FLOWS, created.id)).body).toEqual(before);
  });

  it('名称租户唯一 409 FLOW_DUPLICATE；revision 不一致 409；停用 / 删除', async () => {
    const w = await formFlowWorld(testDb().db, 'trl-misc');
    const flow = await w.createFlow({ name: '甲' });
    const dup = await w.post(
      FLOWS,
      flowBody(
        flow.nodes.map((n) => ({ ...nodeBody(n.roleIds) })),
        { name: '甲' },
      ),
    );
    expect([dup.status, await reasonOf(dup)]).toEqual([409, 'FLOW_DUPLICATE']);
    const stale = await w.request('PATCH', `${FLOWS}/${flow.id}`, { ifMatch: 7, body: { enabled: false } });
    expect([stale.status, await errorCode(stale)]).toEqual([409, 'REVISION_CONFLICT']);
    const off = await w.request('PATCH', `${FLOWS}/${flow.id}`, { ifMatch: 1, body: { enabled: false } });
    expect(await off.json()).toMatchObject({ enabled: false, revision: 2, nodes: flow.nodes });
    expect((await w.request('DELETE', `${FLOWS}/${flow.id}`, { ifMatch: 2 })).status).toBe(200);
    expect((await w.read<FlowView>(FLOWS, flow.id)).status).toBe(404);
  });

  it('被模板引用（B6 登记的守卫）拒删 409 FLOW_IN_USE，节点与角色不丢', async () => {
    const w = await formFlowWorld(testDb().db, 'trl-in-use');
    const flow = await w.createFlow();
    referenced.add(flow.id);
    const blocked = await w.request('DELETE', `${FLOWS}/${flow.id}`, { ifMatch: 1 });
    expect([blocked.status, await reasonOf(blocked)]).toEqual([409, 'FLOW_IN_USE']);
    expect((await w.read<FlowView>(FLOWS, flow.id)).body).toEqual(flow);
  });
});
