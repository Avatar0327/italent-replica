/**
 * F-478 S1 边界：HTTP 草稿 schema（strictObject）本片不开放 routes；路由只能由定义服务进程内写入。
 * 同时核对命令台账重放不会重复写激活行（设计 §6）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { uniqueSuffix } from './support/unique.js';
import { APV, activationsOf, approveTo, direct, pendingOf, publishRouted, routeScene } from './AC-APV-F478-support.js';

const testDb = useTestDb();

describe('F-478 S1 routes 不对 HTTP 开放', () => {
  it('创建流程时携带 routes → 400', async () => {
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
    expect(response.status).toBe(400);
  });
});

describe('F-478 S1 命令台账重放', () => {
  it('同一命令 ID 重放同意：返回首次结果，不重复写激活行', async () => {
    const s = await routeScene(testDb().db, 'f478-replay');
    await publishRouted(s.w, s.nodes().slice(0, 3), { n1: [approveTo(direct('n3'))] });
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
