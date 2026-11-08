/**
 * AC-APV-F478-01 草稿保存与读回（设计 §8、§10）：routes 经 HTTP 草稿接口保存，GET / published / latest 投影一致；
 * 旧设计器克隆读回结果再 PUT 不丢 routes；发布后版本路由不可改；跨租户读取 404。
 * 同时核对 409 冲突后重读再改回原值能保存（自查 2）。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { APV, approveTo, otherwise, routeScene, when, type RouteScene } from './AC-APV-F478-support.js';
import { approvalWorld, type NodeInput, type ProcessView } from './AC-APV-support.js';
import { cloneForPut, errorInfo, getProcess, putDraft, withRoutesOn } from './AC-APV-F478-s2-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const LEVEL = randomUUID();

/** 设计 §10：条件 1（部门属于 [D1, D2]，优先级 1）→ N3；条件 2（职级 = L，优先级 2）→ N4；Else → N2。 */
const routesOf = (s: RouteScene) => ({
  n1: [
    approveTo(
      when(1, 'in', [s.depts.d1, s.depts.d2], 'n3'),
      when(2, 'eq', LEVEL, 'n4', 'record.levelId'),
      otherwise('n2'),
    ),
  ],
});

async function draftWithRoutes(s: RouteScene) {
  const created = await s.w.createProcess({ nodes: s.nodes() });
  const saved = await s.w.json<ProcessView>(
    await putDraft(
      s.w,
      created,
      cloneForPut(created.latestVersion, { nodes: withRoutesOn(created.latestVersion.nodes, routesOf(s)) }),
    ),
  );
  return { created, saved };
}

describe('AC-APV-F478-01 草稿保存 routes', () => {
  it('保存后 GET 读回一致：列表值仍为数组、单值仍为字符串，Else 不带条件', async () => {
    const s = await routeScene(testDb().db, 'f478-01-save');
    const { saved } = await draftWithRoutes(s);
    for (const process of [saved, await getProcess(s.w, saved.id)]) {
      const n1 = process.latestVersion.nodes.find((node) => node.key === 'n1') as unknown as {
        routes: { exit: string; branches: Record<string, unknown>[] }[];
      };
      expect(n1.routes).toHaveLength(1);
      const [route] = n1.routes;
      expect(route!.exit).toBe('approve');
      expect(route!.branches).toMatchObject([
        {
          kind: 'condition',
          priority: 1,
          target: 'n3',
          conditions: {
            items: [{ no: 1, field: 'record.departmentId', operator: 'in', value: [s.depts.d1, s.depts.d2] }],
          },
        },
        {
          kind: 'condition',
          priority: 2,
          target: 'n4',
          conditions: { items: [{ no: 1, field: 'record.levelId', operator: 'eq', value: LEVEL }] },
        },
        { kind: 'else', target: 'n2' },
      ]);
      expect(route!.branches[2]).toEqual({ kind: 'else', target: 'n2' });
      // 没配置的节点不增加 routes 字段
      expect(process.latestVersion.nodes.find((node) => node.key === 'n2')).not.toHaveProperty('routes');
    }
  });

  it('旧设计器方式：克隆读回结果、只改流程名再 PUT，routes 不丢', async () => {
    const s = await routeScene(testDb().db, 'f478-01-clone');
    const { saved } = await draftWithRoutes(s);
    const read = await getProcess(s.w, saved.id);
    const again = await s.w.json<ProcessView>(
      await putDraft(s.w, read, cloneForPut(read.latestVersion, { name: '只改了名称' })),
    );
    expect(again.latestVersion.name).toBe('只改了名称');
    expect(again.latestVersion.nodes.find((node) => node.key === 'n1')).toMatchObject({
      routes: [
        { exit: 'approve', branches: [{ kind: 'condition' }, { kind: 'condition' }, { kind: 'else', target: 'n2' }] },
      ],
    });
    // 入参不带 routes 字段的节点沿用草稿现有分支（旧页面只提交旧字段时也不丢）
    const stripped = cloneForPut(again.latestVersion, {
      nodes: again.latestVersion.nodes.map(({ routes: _routes, ...node }: NodeInput & { routes?: unknown }) => node),
    });
    const kept = await s.w.json<ProcessView>(await putDraft(s.w, again, stripped));
    expect(kept.latestVersion.nodes.find((node) => node.key === 'n1')).toHaveProperty(
      'routes.0.branches.2.target',
      'n2',
    );
    // 显式空数组才清空
    const cleared = await s.w.json<ProcessView>(
      await putDraft(
        s.w,
        kept,
        cloneForPut(kept.latestVersion, {
          nodes: kept.latestVersion.nodes.map((node) => (node.key === 'n1' ? { ...node, routes: [] } : node)),
        }),
      ),
    );
    expect(cleared.latestVersion.nodes.find((node) => node.key === 'n1')).not.toHaveProperty('routes');
  });

  it('发布后 published / latest 投影都带 routes；再改该版本的路由被拒（409 APPROVAL_VERSION_PUBLISHED）', async () => {
    const s = await routeScene(testDb().db, 'f478-01-published');
    const { saved } = await draftWithRoutes(s);
    const published = await s.w.publish(saved);
    const view = await getProcess(s.w, published.id);
    for (const version of [view.currentVersion!, view.latestVersion]) {
      expect(version.nodes.find((node) => node.key === 'n1')).toMatchObject({
        routes: [{ exit: 'approve', branches: [{ target: 'n3' }, { target: 'n4' }, { kind: 'else', target: 'n2' }] }],
      });
    }
    const changed = withRoutesOn(view.latestVersion.nodes, { n1: [approveTo(otherwise('END'))] });
    const refused = await putDraft(s.w, view, cloneForPut(view.latestVersion, { nodes: changed }));
    expect(await errorInfo(refused)).toMatchObject({ status: 409, reason: 'APPROVAL_VERSION_PUBLISHED' });
    // 版本内容没有被改动
    const after = await getProcess(s.w, published.id);
    expect(after.latestVersion.nodes.find((node) => node.key === 'n1')).toMatchObject({
      routes: [{ branches: [{ target: 'n3' }, { target: 'n4' }, { target: 'n2' }] }],
    });
  });

  it('新建流程接口同样接受 routes（与草稿同一套校验）', async () => {
    const s = await routeScene(testDb().db, 'f478-01-create');
    const created = await s.w.json<ProcessView>(
      await s.w.request(s.w.hr.id, 'POST', `${APV}/processes`, {
        ifMatch: 0,
        body: {
          code: `P_F478_${uniqueSuffix()}`,
          name: '创建即带分支',
          approvalType: 'transfer',
          exceptionAdminUserId: s.w.exceptionAdmin,
          conditions: { items: [] },
          nodes: withRoutesOn(s.nodes().slice(0, 3), {
            n1: [approveTo(when(1, 'eq', s.depts.d1, 'n3'), otherwise('n2'))],
          }),
        },
      }),
      201,
    );
    expect(created.latestVersion.nodes[0]).toMatchObject({
      routes: [{ branches: [{ target: 'n3' }, { target: 'n2' }] }],
    });
  });

  it('409 → 重读 → 改回原值再保存：冲突不吞掉改动', async () => {
    const s = await routeScene(testDb().db, 'f478-01-conflict');
    const { saved } = await draftWithRoutes(s);
    const stale = saved.revision;
    // 另一人先改了名称，revision 前进
    const other = await s.w.json<ProcessView>(
      await putDraft(s.w, saved, cloneForPut(saved.latestVersion, { name: '他人改的名' })),
    );
    expect(other.revision).toBeGreaterThan(stale);
    const toEnd = withRoutesOn(other.latestVersion.nodes, {
      n1: [approveTo(when(1, 'eq', s.depts.d1, 'n3'), otherwise('END'))],
    });
    const body = cloneForPut(other.latestVersion, { nodes: toEnd });
    expect(await errorInfo(await putDraft(s.w, saved, body, stale))).toMatchObject({ status: 409 });
    const reread = await getProcess(s.w, saved.id);
    expect(reread.latestVersion.nodes.find((node) => node.key === 'n1')).toMatchObject({
      routes: [{ branches: [{ target: 'n3' }, { target: 'n4' }, { target: 'n2' }] }],
    });
    // 重读得到新 revision 后，同样的内容（含“改回原值”的分支目标）能保存
    const retry = await s.w.json<ProcessView>(await putDraft(s.w, reread, body, reread.revision));
    expect(retry.latestVersion.nodes[0]).toMatchObject({
      routes: [{ branches: [{ target: 'n3' }, { target: 'END' }] }],
    });
    const back = withRoutesOn(retry.latestVersion.nodes, { n1: [approveTo(otherwise('n2'))] });
    const restored = await s.w.json<ProcessView>(
      await putDraft(s.w, retry, cloneForPut(retry.latestVersion, { nodes: back })),
    );
    expect(restored.latestVersion.nodes[0]).toMatchObject({ routes: [{ branches: [{ kind: 'else', target: 'n2' }] }] });
  });

  it('跨租户读取该流程定义：404', async () => {
    const s = await routeScene(testDb().db, 'f478-01-tenant-a');
    const { saved } = await draftWithRoutes(s);
    const other = await approvalWorld(testDb().db, 'f478-01-tenant-b');
    const response = await other.request(other.hr.id, 'GET', `${APV}/processes/${saved.id}`);
    expect(response.status).toBe(404);
    const put = await other.request(other.hr.id, 'PUT', `${APV}/processes/${saved.id}/draft`, {
      ifMatch: saved.revision,
      body: cloneForPut(saved.latestVersion),
    });
    expect(put.status).toBe(404);
  });
});
