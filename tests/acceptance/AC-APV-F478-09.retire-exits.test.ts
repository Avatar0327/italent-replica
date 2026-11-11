/**
 * AC-APV-F478-09（F-478 S4，设计 §1.2 / §4）：退休 HRBP 节点的业务出口。
 * - reEmployed=false：披露 exits 只有“同意（不返聘）”；提交 approve_rehire → 409 APPROVAL_EXIT_NOT_AVAILABLE；
 *   不带 exit → 409 APPROVAL_EXIT_REQUIRED；两次失败状态都不变；approve_no_rehire → 结束；
 * - reEmployed=true：只有“同意（同时返聘）”，办理后进入返聘后节点；actions 仍含 approve。
 * 流程经真实 HTTP 保存发布（业务出口 + 路由），办理走审批中心真实接口，合成数据。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { putDraft, cloneForPut, withRoutesOn } from './AC-APV-F478-s2-support.js';
import { APV, detailOf, errorInfo, retireScene, type RetireScene } from './AC-APV-F478-s4-support.js';
import type { NodeInput, ProcessView } from './AC-APV-support.js';

const testDb = useTestDb();

const single = (key: string, value: string, type: 'object_field' | 'department' = 'object_field'): NodeInput => ({
  key,
  name: key,
  approver: { type, value },
  actions: { avoidSelf: false, avoidSubjects: false },
});

/** 退休四节点（与预置同形，审批人换成指定的真实取法）：HRBP 节点两个业务出口，不返聘 → END，返聘 → 返聘后经理。 */
async function publishRetireFlow(s: RetireScene, withRoutes = true) {
  const nodes: NodeInput[] = [
    single('direct_head', 'direct_manager'),
    {
      ...single('hr_interview', 'record_department_hrbp', 'department'),
      exits: ['approve_no_rehire', 'approve_rehire'],
    },
    { ...single('rehire_manager', 'record_department_head', 'department') },
  ].map((node) => node as NodeInput);
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
  } as const;
  const saved = await s.w.json<ProcessView>(
    await putDraft(
      s.w,
      created,
      cloneForPut(created.latestVersion, {
        nodes: withRoutes ? withRoutesOn(created.latestVersion.nodes, routes as never) : created.latestVersion.nodes,
      }),
    ),
  );
  return s.w.publish(saved);
}

async function atHrbp(label: string, reEmployed: boolean, withRoutes = true) {
  const s = await retireScene(testDb().db, label);
  await publishRetireFlow(s, withRoutes);
  const first = await s.retire(reEmployed);
  expect(s.w.pending(first)[0]!.nodeKey).toBe('direct_head');
  const view = await s.advance(first);
  expect(s.w.pending(view)[0]!.nodeKey).toBe('hr_interview');
  return { s, view };
}

describe('AC-APV-F478-09 reEmployed=false：只能“同意（不返聘）”', () => {
  it('披露 exits 只有不返聘；actions 仍含 approve', async () => {
    const { s, view } = await atHrbp('f478-09-no', false);
    const detail = await detailOf(s.w, view.id, s.home.hrbp);
    expect(detail.exits).toEqual([{ code: 'approve_no_rehire', label: '同意（不返聘）', family: 'approve' }]);
    expect(detail.actions).toContain('approve');
  });

  it('提交 approve_rehire → 409 APPROVAL_EXIT_NOT_AVAILABLE；不带 exit → 409 APPROVAL_EXIT_REQUIRED；状态不变', async () => {
    const { s, view } = await atHrbp('f478-09-guard', false);
    const wrong = await s.decide(view, 'approve', { comment: '同意', exit: 'approve_rehire' });
    expect(await errorInfo(wrong)).toMatchObject({ status: 409, reason: 'APPROVAL_EXIT_NOT_AVAILABLE' });
    const bare = await s.decide(view, 'approve', { comment: '同意' });
    expect(await errorInfo(bare)).toMatchObject({ status: 409, reason: 'APPROVAL_EXIT_REQUIRED' });
    const unchanged = await s.w.detail(view.id);
    expect(unchanged.revision).toBe(view.revision);
    expect(unchanged.status).toBe('running');
    expect(s.w.pending(unchanged).map((task) => task.nodeKey)).toEqual(['hr_interview']);
  });

  it('approve_no_rehire → 流程结束并通过，不进入返聘后节点', async () => {
    const { s, view } = await atHrbp('f478-09-end', false);
    const done = await s.decide(view, 'approve', { comment: '同意', exit: 'approve_no_rehire' });
    expect(done.status, await done.clone().text()).toBe(200);
    const finished = await s.w.detail(view.id);
    expect(finished.status).toBe('approved');
    expect(s.w.pending(finished)).toEqual([]);
  });
});

describe('AC-APV-F478-09 reEmployed=true：只能“同意（同时返聘）”', () => {
  it('披露 exits 只有同时返聘；不返聘出口 409；同意（同时返聘）进入返聘后节点', async () => {
    const { s, view } = await atHrbp('f478-09-yes', true);
    const detail = await detailOf(s.w, view.id, s.home.hrbp);
    expect(detail.exits).toEqual([{ code: 'approve_rehire', label: '同意（同时返聘）', family: 'approve' }]);
    expect(detail.actions).toContain('approve');
    const wrong = await s.decide(view, 'approve', { comment: '同意', exit: 'approve_no_rehire' });
    expect(await errorInfo(wrong)).toMatchObject({ status: 409, reason: 'APPROVAL_EXIT_NOT_AVAILABLE' });
    const done = await s.decide(view, 'approve', { comment: '同意', exit: 'approve_rehire' });
    expect(done.status, await done.clone().text()).toBe(200);
    const next = await s.w.detail(view.id);
    expect(next.status).toBe('running');
    expect(s.w.pending(next).map((task) => task.nodeKey)).toEqual(['rehire_manager']);
  });
});

describe('AC-APV-F478-09 越权与隔离', () => {
  it('非本节点审批人办理 → 403，不因业务出口泄露守卫结果', async () => {
    const { s, view } = await atHrbp('f478-09-auth', true);
    const response = await s.decide(view, 'approve', { comment: '同意', exit: 'approve_rehire' }, s.home.head);
    expect([403, 404]).toContain(response.status);
    expect((await s.w.detail(view.id)).revision).toBe(view.revision);
    expect(APV).toContain('approval');
  });
});

/** 业务出口节点不配显式路由也是合法定义：办理入口的守卫与出口披露不依赖路由（审查 P2-1 顺带核运行时）。 */
describe('AC-APV-F478-09 无显式路由的业务出口节点：运行时仍受守卫约束', () => {
  it('reEmployed=false：只披露不返聘；approve_rehire / 不带 exit 都 409，状态不变', async () => {
    const { s, view } = await atHrbp('f478-09-noroute', false, false);
    const detail = await detailOf(s.w, view.id, s.home.hrbp);
    expect(detail.exits).toEqual([{ code: 'approve_no_rehire', label: '同意（不返聘）', family: 'approve' }]);
    const wrong = await s.decide(view, 'approve', { comment: '同意', exit: 'approve_rehire' });
    expect(await errorInfo(wrong)).toMatchObject({ status: 409, reason: 'APPROVAL_EXIT_NOT_AVAILABLE' });
    const bare = await s.decide(view, 'approve', { comment: '同意' });
    expect(await errorInfo(bare)).toMatchObject({ status: 409, reason: 'APPROVAL_EXIT_REQUIRED' });
    const unchanged = await s.w.detail(view.id);
    expect(unchanged.revision).toBe(view.revision);
    expect(s.w.pending(unchanged).map((task) => task.nodeKey)).toEqual(['hr_interview']);
  });
});
