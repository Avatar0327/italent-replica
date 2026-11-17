/**
 * F-326 S7a：AC-APV-F326-35（跨流程复用）、38（存量 specified）、41（草稿期限制）、43（权限）。
 * 流程 A 为“调动”，流程 B / C 为“个人信息变更”或“调动”的别的兜底，避免同类型兜底冲突；全部经真实 HTTP。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import type { NodeInput, ProcessView } from './AC-APV-support.js';
import { tenantApi } from './support/tenant-api.js';
import {
  actionsOf,
  APPROVAL,
  audits,
  auditAtRevision,
  autoAt,
  autoRows,
  firstAuto,
  autoViewOf,
  create,
  dispatch,
  draftOk,
  manager,
  newVersion,
  peopleOf,
  publicVar,
  publishWith,
  readProcess,
  s4World,
  specified,
  storedNodes,
  type S4World,
  variableCount,
} from './AC-APV-F326-S7a-support.js';
import { counter, rejected, saveNodes } from './AC-APV-F326-S4-support.js';

const database = useTestDb();
const single = (key: string, userId: string): NodeInput => ({ key, name: `节点${key}`, approver: specified(userId) });
const viaManager = (key: string): NodeInput => ({ key, name: `节点${key}`, approver: manager });
const ASOF = 'asOf=2026-10-01';

interface Candidate {
  id: string;
  name: string;
  enabled: boolean;
}
async function candidates(w: S4World, query = ''): Promise<Candidate[]> {
  const response = await w.request(
    w.hr.id,
    'GET',
    `${APPROVAL}/designer/source-candidates?type=public_variable&${ASOF}&includeInactive=true${query}`,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: Candidate[] }).items;
}

/** A（个人信息变更）发布 v1 生成 V；B（调动）引用 V 并发布。 */
async function shared(w: S4World, nodes?: NodeInput[]) {
  const a = await w.publish(
    await create(w, nodes ?? [single('n1', w.near.userId)], { approvalType: 'personnel_change', name: 'A流程' }),
  );
  const v = await firstAuto(w, a.id);
  const b = await w.publish(
    await create(w, [counter([publicVar(v.id)], { key: 'b1', name: 'B节点' })], { name: 'B流程' }),
  );
  return { a, b, v };
}
const assignee = async (w: S4World, employee: string) => (await dispatch(w, employee)).tasks.map(([, user]) => user);

describe('AC-APV-F326-35 跨流程复用（DEC-860）', () => {
  it('① A 起草 v2 改选 A2：不新建变量；保存后 V / B 仍 A1；发布后 V 为 A2、B 新实例派 A2；③ B 回显 V 不带 autoVariable', async () => {
    const w = await s4World(database().db, 's7a-cross-1');
    const a2 = await w.person('合成丙', w.staff);
    const [first, second] = [await w.person('合成申请一', w.staff), await w.person('合成申请二', w.staff)];
    const { a, b, v } = await shared(w);
    expect((await candidates(w)).map((item) => item.id)).toContain(v.id);
    expect((await candidates(w)).find((item) => item.id === v.id)!.name).toContain('A流程-节点n1');
    expect(await assignee(w, first.employeeId)).toEqual([w.near.userId]);

    const draft = await newVersion(w, a);
    const saved = await draftOk(w, draft, [single('n1', a2.userId)]);
    expect(await autoRows(w, a.id)).toHaveLength(1);
    expect(peopleOf(await firstAuto(w, a.id))).toEqual([w.near.userId]);
    expect(await assignee(w, second.employeeId)).toEqual([w.near.userId]);

    const published = await publishWith(w, saved);
    expect(published.status, await published.clone().text()).toBe(200);
    const rows = await autoRows(w, a.id);
    expect(rows.map((row) => row.id)).toEqual([v.id]);
    expect(peopleOf(rows[0]!)).toEqual([a2.userId]);
    const third = await w.person('合成申请三', w.staff);
    expect(await assignee(w, third.employeeId)).toEqual([a2.userId]);

    const bView = await readProcess(w, b.id);
    const source = bView.currentVersion!.nodes[0]!.approvers![0]!;
    expect(source).toMatchObject({ type: 'public_variable', value: v.id });
    expect(autoViewOf(source)).toBeUndefined();
  });

  it('② A 起草 v2 改成直线经理：V 仍被 A v1 / B 引用，不停用；发布 v2 后仍启用', async () => {
    const w = await s4World(database().db, 's7a-cross-2');
    const { a, v } = await shared(w);
    const draft = await newVersion(w, a);
    const saved = await draftOk(w, draft, [viaManager('n1')]);
    expect((await autoRows(w, a.id)).find((row) => row.id === v.id)!.status).toBe('enabled');
    expect(actionsOf(await audits(w, v.id))).toEqual(['auto_create']);
    const published = await publishWith(w, saved);
    expect(published.status, await published.clone().text()).toBe(200);
    expect((await autoRows(w, a.id)).find((row) => row.id === v.id)!.status).toBe('enabled');
    expect(actionsOf(await audits(w, v.id))).toEqual(['auto_create']);
  });

  it('④ C 草稿去掉 W（A 的在用版本都已不引用）→ W 被停用，操作人为 C 的保存人，reason 不再被引用', async () => {
    const w = await s4World(database().db, 's7a-cross-4');
    const a = await w.publish(
      await create(w, [single('n1', w.near.userId), single('n2', w.head.userId)], {
        approvalType: 'personnel_change',
      }),
    );
    const wRow = await autoAt(w, a.id, 'n2');
    const aDraft = await newVersion(w, a);
    const aSaved = await draftOk(w, aDraft, [single('n1', w.near.userId), viaManager('n2')]);
    expect((await publishWith(w, aSaved)).status).toBe(200);

    const c = await w.json<Awaited<ReturnType<typeof readProcess>>>(
      await saveNodes(w, [counter([publicVar(wRow.id)], { key: 'c1' })]),
      201,
    );
    const cSaved = await draftOk(w, c, [counter([manager], { key: 'c1' })]);
    expect(cSaved.latestVersion.nodes).toHaveLength(1);
    const row = (await autoRows(w, a.id)).find((item) => item.id === wRow.id)!;
    expect(row.status).toBe('disabled');
    const last = await auditAtRevision(w, wRow.id, row.revision);
    expect(last).toMatchObject({ action: 'approval.public_variable.auto_disable', actor: w.hr.id });
    expect(last.after).toMatchObject({ reason: '不再被引用' });
  });
});

describe('AC-APV-F326-38 存量 specified', () => {
  it('已发布的旧 specified 版本照常派单；编辑最新版本 → 草稿落成自动变量，原版本不变', async () => {
    const w = await s4World(database().db, 's7a-legacy');
    const published = await w.publish(await create(w, [viaManager('n1')]));
    // 夹具：把已发布节点改写成旧的 specified 形态（模拟升级前入库的存量，不经设计器入口）
    // 与 AC-APV-F048-defaults 的 patchPublishedNodes 同法：本会话内关掉“已发布版本节点不可改”触发器后改写
    await w.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${w.tenant.id}, true)`);
      await tx.execute(sql`ALTER TABLE approval_process_nodes DISABLE TRIGGER approval_nodes_draft_only`);
      await tx.execute(sql`UPDATE approval_process_nodes
        SET approver_expression=${JSON.stringify(specified(w.head.userId))}::jsonb
        WHERE tenant_id=${w.tenant.id} AND version_id=${published.currentVersion!.id}::uuid`);
      await tx.execute(sql`ALTER TABLE approval_process_nodes ENABLE TRIGGER approval_nodes_draft_only`);
    });
    expect((await dispatch(w)).tasks.map(([, user]) => user)).toEqual([w.head.userId]);

    const draft = await newVersion(w, published);
    const rows = await autoRows(w, published.id);
    expect(rows).toHaveLength(1);
    expect(peopleOf(rows[0]!)).toEqual([w.head.userId]);
    const [stored] = await storedNodes(w, draft.latestVersion.id);
    expect(stored!.approver_expression).toEqual({ type: 'public_variable', value: rows[0]!.id });
    const [legacy] = await storedNodes(w, published.currentVersion!.id);
    expect(legacy!.approver_expression).toEqual(specified(w.head.userId));
  });
});

describe('AC-APV-F326-41 草稿期限制', () => {
  it('A 草稿生成的变量 V：B 候选不含、B 引用 422；A 另一节点引用 V 同样 422；A 发布后可选', async () => {
    const w = await s4World(database().db, 's7a-draftlimit');
    const a = await create(w, [single('n1', w.near.userId)], { approvalType: 'personnel_change' });
    const v = await firstAuto(w, a.id);
    expect((await candidates(w)).map((item) => item.id)).not.toContain(v.id);

    const byB = await saveNodes(w, [counter([publicVar(v.id)])]);
    const error = await rejected(byB, 422, 'APPROVAL_SOURCE_AUTO_VARIABLE_UNPUBLISHED');
    expect(error.code).toBe('APPROVAL_SOURCE_INVALID');

    const total = await variableCount(w);
    const second = await w.request(w.hr.id, 'PUT', `${APPROVAL}/processes/${a.id}/draft`, {
      ifMatch: a.revision,
      body: {
        name: a.latestVersion.name,
        priority: a.latestVersion.priority,
        isFallback: a.latestVersion.isFallback,
        exceptionAdminUserId: a.latestVersion.exceptionAdminUserId,
        conditions: a.latestVersion.conditions,
        nodes: [single('n1', w.near.userId), { key: 'n2', name: '乙', approver: publicVar(v.id) }].map((node) => ({
          ...node,
          actions: { avoidSelf: true },
        })),
      },
    });
    await rejected(second, 422, 'APPROVAL_SOURCE_AUTO_VARIABLE_UNPUBLISHED');
    expect(await variableCount(w)).toBe(total);

    expect((await publishWith(w, a)).status).toBe(200);
    expect((await candidates(w)).map((item) => item.id)).toContain(v.id);
    const ok = await saveNodes(w, [counter([publicVar(v.id)])]);
    expect(ok.status, await ok.clone().text()).toBe(201);
  });
});

describe('AC-APV-F326-43 权限（DEC-908：生成不在流程配置入口之外另加权限）', () => {
  const api = (w: S4World, allow: (action: string) => boolean) =>
    tenantApi(w.db, { authorize: (q) => allow(q.action), clock: w.clock });
  const as = (w: S4World) => ({ user: w.hr.id, tenant: w.tenant.id });
  const body = (w: S4World, nodes: NodeInput[] = [single('n1', w.near.userId)]) => ({
    code: `P43${Date.now()}`,
    name: '合成权限流程',
    approvalType: 'transfer',
    isFallback: true,
    exceptionAdminUserId: w.exceptionAdmin,
    conditions: { items: [] },
    nodes: nodes.map((node) => ({ ...node, actions: { avoidSelf: true } })),
  });
  const draftBody = (w: S4World, nodes: NodeInput[]) => {
    const { code: _code, approvalType: _type, ...rest } = body(w, nodes);
    return rest;
  };
  const autoTotal = async (w: S4World) =>
    withTenant(w.db, w.tenant.id, async (tx) =>
      rowsOf<{ n: number }>(
        await tx.execute(sql`SELECT count(*)::int AS n FROM approval_variables WHERE tenant_id=${w.tenant.id}
          AND origin='auto'`),
      ),
    ).then((rows) => rows[0]!.n);

  it('流程管理员（admin.process_matrix，如 matrix_admin）：新建流程、保存草稿指定人员都照常生成，created_by 为该账号', async () => {
    const w = await s4World(database().db, 's7a-perm');
    const admin = api(w, (action) => action === 'admin.process_matrix');
    const created = await admin.request('POST', `${APPROVAL}/processes`, { ifMatch: 0, body: body(w), ...as(w) });
    expect(created.status, await created.clone().text()).toBe(201);
    const process = (await created.json()) as ProcessView;
    expect(await firstAuto(w, process.id)).toMatchObject({ created_by: w.hr.id, updated_by: w.hr.id });

    const second = (await w.person('合成第二人', w.staff)).userId;
    const nodes = [single('n1', w.near.userId), single('n2', second)];
    const saved = await admin.request('PUT', `${APPROVAL}/processes/${process.id}/draft`, {
      ifMatch: process.revision,
      body: draftBody(w, nodes),
      ...as(w),
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(await autoAt(w, process.id, 'n2')).toMatchObject({ created_by: w.hr.id, updated_by: w.hr.id });
  });

  it('只有流程对象按钮、没有 admin.process_matrix 的账号：新建与保存草稿 403 且不写变量，公共变量管理接口 403', async () => {
    const w = await s4World(database().db, 's7a-perm-deny');
    const seeded = await api(w, (action) => action === 'admin.process_matrix').request(
      'POST',
      `${APPROVAL}/processes`,
      { ifMatch: 0, body: body(w), ...as(w) },
    );
    const process = (await seeded.json()) as ProcessView;
    const total = await autoTotal(w);
    const buttonOnly = api(w, (action) => action !== 'admin.process_matrix');
    const create403 = await buttonOnly.request('POST', `${APPROVAL}/processes`, {
      ifMatch: 0,
      body: body(w),
      ...as(w),
    });
    expect(create403.status).toBe(403);
    const draft403 = await buttonOnly.request('PUT', `${APPROVAL}/processes/${process.id}/draft`, {
      ifMatch: process.revision,
      body: draftBody(w, [single('n1', w.near.userId), single('n2', w.near.userId)]),
      ...as(w),
    });
    expect(draft403.status).toBe(403);
    const variables = await buttonOnly.request('GET', `${APPROVAL}/variables?scope=public`, as(w));
    expect(variables.status).toBe(403);
    expect(await autoTotal(w)).toBe(total);
  });
});
