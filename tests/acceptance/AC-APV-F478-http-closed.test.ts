/**
 * F-478 S1 / S2 边界：S1 时 HTTP 草稿 schema（strictObject）不开放 routes；S2 起创建与草稿保存接受 routes（契约变化，
 * 原“携带 routes → 400”断言改为 201 并读回）。同时核对命令台账重放不会重复写激活行（设计 §6）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { uniqueSuffix } from './support/unique.js';
import {
  APV,
  activationsOf,
  approveTo,
  otherwise,
  pendingOf,
  publishRouted,
  routeScene,
  when,
} from './AC-APV-F478-support.js';

const testDb = useTestDb();

describe('F-478 S2 routes 对 HTTP 开放（S1 时为 400）', () => {
  it('创建流程时携带 routes → 201，并在读回里原样返回', async () => {
    const s = await routeScene(testDb().db, 'f478-http-closed');
    const nodes = s
      .nodes()
      .slice(0, 2)
      .map((node, index) => ({
        ...node,
        ...(index === 0 ? { routes: [{ exit: 'approve', branches: [{ kind: 'direct', target: 'END' }] }] } : {}),
      }));
    const response = await s.w.request(s.w.hr.id, 'POST', `${APV}/processes`, {
      ifMatch: 0,
      body: {
        code: `P_${uniqueSuffix()}`,
        name: '带分支的流程',
        approvalType: 'transfer',
        exceptionAdminUserId: null,
        conditions: { items: [] },
        nodes,
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const created = await s.w.json<{ latestVersion: { nodes: { key: string; routes?: unknown }[] } }>(response, 201);
    expect(created.latestVersion.nodes[0]!.routes).toEqual([
      { exit: 'approve', branches: [{ kind: 'direct', target: 'END' }] },
    ]);
    expect(created.latestVersion.nodes[1]).not.toHaveProperty('routes');
  });
});

describe('F-478 S1 命令台账重放', () => {
  it('同一命令 ID 重放同意：返回首次结果，不重复写激活行', async () => {
    const s = await routeScene(testDb().db, 'f478-replay');
    await publishRouted(s.w, s.nodes().slice(0, 3), {
      n1: [approveTo(when(1, 'eq', s.depts.d2, 'n2'), otherwise('n3'))],
    });
    const view = await s.start(s.depts.d1);
    const task = pendingOf(view)[0]!;
    const call = () =>
      s.w.request(task.assigneeUserId, 'POST', `${APV}/tasks/${task.id}/approve`, {
        ifMatch: view.revision,
        body: { comment: '同意' },
        idempotencyKey: 'f478-replay-approve-1',
      });
    const first = await call();
    expect(first.status, await first.clone().text()).toBe(200);
    const rows = await activationsOf(s.w, view.id);
    expect(rows.map((r) => r.node_key)).toEqual(['n1', 'n3']);
    const again = await call();
    expect(again.status).toBe(200);
    expect(await activationsOf(s.w, view.id)).toEqual(rows);
  });
});
