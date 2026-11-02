// @vitest-environment happy-dom
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../foundation/Session.js';
import { useRead } from '../part-time/useRead.js';
import {
  InternCommands,
  useConfirmedGeneration,
  useConfirmedRefresh,
  useInternCommand,
  useInternDraft,
  useSettledRefresh,
  type Send,
} from './commands.js';
import { apiRoot, interns } from './model.js';

// F-436（F-376 审查 P3；R1 P2-1）：实习转正申请最终确认成功后，本会话确认代次 +1，当前挂载的列表随之重读，
// 写方页面实例已卸载（离开模块后在落库前回来）也一样；草稿、失败、409、结果未知都不递增，代次按租户 + 身份隔离。
const employeeId = 'f436-employee';
const businessId = 'f436-application';
const submitPath = `${apiRoot}/businesses/${businessId}/submit`;
const readbackPath = `${apiRoot}/businesses/${businessId}`;

let tenantSeq = 0;
const session = (tenantId: string, identityKey = 'synthetic-user') => ({
  tenantId,
  identityKey,
  tenantName: '合成租户',
  timezone: 'Asia/Shanghai',
  displayName: '合成用户',
  source: 'server' as const,
});
type Session = ReturnType<typeof session>;

/** 受控的“服务端”：第二步 submit 可挂起；回执与本单回读形态取 EmploymentBusiness 的 id / revision。 */
interface Server {
  submit: () => Promise<Response>;
  readbackRevision: number;
  listReads: Record<string, number>;
}
let server: Server;
const accepted = () => Response.json({ id: businessId, revision: 2, status: 'in_review' });
const rejected = (status: number, code: string) =>
  Response.json({ error: { code, message: '合成业务拒绝', details: {} } }, { status });

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(submitPath)) return server.submit();
      if (url.includes(readbackPath)) return Response.json({ id: businessId, revision: server.readbackRevision });
      const watcher = new URL(url, 'http://localhost').searchParams.get('watcher');
      if (watcher) server.listReads[watcher] = (server.listReads[watcher] ?? 0) + 1;
      return Response.json({ items: [], page: 1, pageSize: 30, hasDataPermission: true });
    }),
  );
}

const send: Send = {
  path: submitPath,
  body: () => ({}),
  accept: (raw) => ({ path: readbackPath, id: businessId, revision: Number(raw.revision) }),
};
const writer: { submit?: () => Promise<boolean> } = {};
/** 申请表单的提交点：与 RegularizeForm 同一组 useSettledRefresh + useInternCommand。 */
function Writer({ application, draft, refresh }: { application: boolean; draft: boolean; refresh(): Promise<void> }) {
  const settled = useSettledRefresh(application, draft, refresh);
  const read = async () => ({ id: employeeId, revision: 1, values: {} });
  const cmd = useInternCommand(interns, { id: employeeId, revision: 1, baseline: {}, read }, 'apply', settled);
  writer.submit = () => cmd.submit({}, [], send);
  return null;
}
const generations: Record<string, number> = {};
/** 列表页：真实 useRead + useConfirmedRefresh（InternPage 的接法）。 */
function Watcher({ name }: { name: string }) {
  const list = useRead<{ items: unknown[] }>(`${apiRoot}/interns?view=converting&page=1&pageSize=30&watcher=${name}`);
  useConfirmedRefresh(list.refresh);
  generations[name] = useConfirmedGeneration();
  return null;
}

const roots: ReturnType<typeof createRoot>[] = [];
async function mount(current: Session, child: ReturnType<typeof h>) {
  const root = createRoot(document.body.appendChild(document.createElement('div')));
  roots.push(root);
  const tree = h(SessionProvider, { session: current, children: h(InternCommands, null, child) });
  await act(async () => root.render(tree));
  await flush();
  return root;
}
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
async function submit() {
  let outcome: unknown;
  await act(async () => {
    outcome = await writer.submit!().catch((error: unknown) => error);
  });
  await flush();
  return outcome;
}

describe('AC-FE-F436 实习写确认代次（模块级、按会话）', () => {
  let tenant: Session;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    // 每个用例一个新租户：模块级存储与代次跨用例保留，换租户即互不影响（本身也是被测性质）
    tenant = session(`f436-tenant-${(tenantSeq += 1)}`);
    server = { submit: async () => accepted(), readbackRevision: 2, listReads: {} };
    stubFetch();
  });
  afterEach(async () => {
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });

  it('提交在途时写方页面卸载、新挂载列表 → 最终确认成功：代次 +1，新列表重读一次', async () => {
    let release!: () => void;
    server.submit = () => new Promise((resolve) => (release = () => resolve(accepted())));
    const refresh = vi.fn(async () => undefined);
    const old = await mount(tenant, h(Writer, { application: true, draft: true, refresh }));
    let outcome: Promise<boolean> | undefined;
    await act(async () => void (outcome = writer.submit!()));
    await act(async () => old.unmount());
    await mount(tenant, h(Watcher, { name: 'remounted' }));
    expect(server.listReads.remounted).toBe(1);
    expect(generations.remounted).toBe(0);
    await act(async () => {
      release();
      await outcome;
    });
    await flush();
    expect(generations.remounted).toBe(1);
    expect(server.listReads.remounted).toBe(2);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('两步申请第一步（建草稿）确认成功：不算最终确认，代次不变、列表不重读', async () => {
    await mount(tenant, h(Watcher, { name: 'list' }));
    await mount(tenant, h(Writer, { application: true, draft: false, refresh: async () => undefined }));
    expect(await submit()).toBe(true);
    expect(generations.list).toBe(0);
    expect(server.listReads.list).toBe(1);
  });

  it.each([
    ['业务拒绝 409', () => Promise.resolve(rejected(409, 'BUSINESS_CONFLICT'))],
    ['revision 冲突 409', () => Promise.resolve(rejected(409, 'REVISION_CONFLICT'))],
    ['服务端 500（结果未知）', () => Promise.resolve(rejected(500, 'INTERNAL'))],
    ['断网（结果未知）', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('第二步%s：代次不变、列表不重读', async (_name, failure) => {
    server.submit = failure;
    await mount(tenant, h(Watcher, { name: 'list' }));
    await mount(tenant, h(Writer, { application: true, draft: true, refresh: async () => undefined }));
    expect(await submit()).toBeInstanceOf(Error);
    expect(generations.list).toBe(0);
    expect(server.listReads.list).toBe(1);
  });

  it('第二步回执成功但本单回读 revision 落后（结果未知）：代次不变、列表不重读', async () => {
    server.readbackRevision = 1;
    await mount(tenant, h(Watcher, { name: 'list' }));
    await mount(tenant, h(Writer, { application: true, draft: true, refresh: async () => undefined }));
    expect(await submit()).toBeInstanceOf(Error);
    expect(generations.list).toBe(0);
    expect(server.listReads.list).toBe(1);
  });

  it('不同租户或身份互不影响：只有写方会话的列表随确认重读', async () => {
    await mount(tenant, h(Watcher, { name: 'same' }));
    await mount(session(`${tenant.tenantId}-other`), h(Watcher, { name: 'otherTenant' }));
    await mount(session(tenant.tenantId, 'synthetic-other-user'), h(Watcher, { name: 'otherIdentity' }));
    await mount(tenant, h(Writer, { application: true, draft: true, refresh: async () => undefined }));
    expect(await submit()).toBe(true);
    expect(generations).toMatchObject({ same: 1, otherTenant: 0, otherIdentity: 0 });
    expect(server.listReads).toEqual({ same: 2, otherTenant: 1, otherIdentity: 1 });
  });

  it('直接转正：照旧刷新当前视图，不经确认代次', async () => {
    await mount(tenant, h(Watcher, { name: 'list' }));
    const refresh = vi.fn(async () => undefined);
    await mount(tenant, h(Writer, { application: false, draft: false, refresh }));
    expect(await submit()).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(generations.list).toBe(0);
  });

  it('申请草稿与命令存储同在模块级：页面卸载重建后仍在，按租户 + 身份隔离', async () => {
    const seen: Record<string, unknown> = {};
    const saved: { put?: (draft?: { id: string; revision: number; values: object }) => void } = {};
    function Draft({ name }: { name: string }) {
      const draft = useInternDraft(employeeId);
      saved.put = draft.put;
      seen[name] = draft.draft;
      return null;
    }
    const first = await mount(tenant, h(Draft, { name: 'first' }));
    await act(async () => saved.put!({ id: businessId, revision: 1, values: {} }));
    expect(seen.first).toMatchObject({ id: businessId });
    await act(async () => first.unmount());
    // 第二步结果未知 / 被拒的命令留在模块级存储里；草稿若随页面丢失，重开会按第一步处理而读错对象
    await mount(tenant, h(Draft, { name: 'remounted' }));
    await mount(session(`${tenant.tenantId}-other`), h(Draft, { name: 'otherTenant' }));
    await mount(session(tenant.tenantId, 'synthetic-other-user'), h(Draft, { name: 'otherIdentity' }));
    expect(seen.remounted).toMatchObject({ id: businessId, revision: 1 });
    expect(seen.otherTenant).toBeUndefined();
    expect(seen.otherIdentity).toBeUndefined();
  });
});
