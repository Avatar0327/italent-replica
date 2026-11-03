/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { act, createElement: h } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { useCommandForm } = await import(resolve('apps/web/src/foundation/forms/useCommandForm.tsx'));
const { slotKey } = await import(resolve('apps/web/src/foundation/forms/slot.ts'));
const { InternCommands, useInternDraft, useConfirmedRefresh } = await import(
  resolve('apps/web/src/intern/commands.tsx')
);
const { useRetireDraft } = await import(resolve('apps/web/src/retirement/draft.ts'));
const { useRegularizationRecovery } = await import(resolve('apps/web/src/probation/draft.ts'));
const { useCreateCommand } = await import(resolve('apps/web/src/intern/create-command.ts'));
const { useRead } = await import(resolve('apps/web/src/part-time/useRead.ts'));
const { interns } = await import(resolve('apps/web/src/intern/model.ts'));

const roots: ReturnType<typeof createRoot>[] = [];
let serial = 0;
let session: {
  tenantId: string;
  identityKey: string;
  tenantName: string;
  timezone: string;
  displayName: string;
  source: 'server';
};
const employee = 'synthetic-f444-employee';
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
async function mount(child: ReturnType<typeof h>, current = session) {
  const root = createRoot(document.body.appendChild(document.createElement('div')));
  roots.push(root);
  await act(async () =>
    root.render(h(SessionProvider, { session: current, children: h(InternCommands, null, child) })),
  );
  await flush();
  return root;
}
let intern: ReturnType<typeof useInternDraft>;
let retirement: ReturnType<typeof useRetireDraft>;
function Drafts() {
  intern = useInternDraft(employee);
  retirement = useRetireDraft(employee);
  return null;
}
let creation: ReturnType<typeof useCreateCommand>;
function Creator() {
  creation = useCreateCommand();
  return null;
}
function List() {
  const result = useRead('/api/tenant/employment/interns?watcher=f444');
  useConfirmedRefresh(result.refresh);
  return null;
}
const values = {
  name: '合成实习生',
  code: 'SYN-F444',
  loginEmail: 'intern@example.com',
  effectiveDate: '2026-11-02',
  departmentId: 'synthetic-department',
  companyId: 'synthetic-company',
  typeId: 'synthetic-contract-type',
  endDate: '2027-11-01',
};
const receipt = {
  id: 'synthetic-business',
  businessId: 'synthetic-business',
  employeeId: employee,
  revision: 1,
  kind: 'hire',
  view: 'interning',
  contract: {
    stage: 'formal',
    id: 'synthetic-contract',
    startDate: values.effectiveDate,
    endDate: values.endDate,
    companyId: values.companyId,
  },
};

describe('AC-FE-F444 草稿命名空间与共用命令生命周期', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    session = {
      tenantId: `synthetic-f444-${++serial}`,
      identityKey: 'synthetic-identity',
      tenantName: '合成租户',
      timezone: 'Asia/Shanghai',
      displayName: '合成用户',
      source: 'server',
    };
  });
  afterEach(async () => {
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('AC-FE-F444-01 同员工退休与实习草稿独立：写入、跨挂载恢复、删除互不串用', async () => {
    const first = await mount(h(Drafts));
    await act(async () => intern.put({ id: 'intern-draft', revision: 1, values: { code: 'SYN' } }));
    expect(retirement.draft).toBeUndefined();
    await act(async () =>
      retirement.created({
        id: 'retire-draft',
        revision: 3,
        values: { lastWorkDate: '2026-11-02', handoverEmployeeId: null },
      }),
    );
    expect(intern.draft?.id).toBe('intern-draft');
    await act(async () => first.unmount());
    await mount(h(Drafts));
    expect(intern.draft?.id).toBe('intern-draft');
    expect(retirement.draft?.id).toBe('retire-draft');
    await act(async () => intern.put());
    expect(retirement.draft?.id).toBe('retire-draft');
    await mount(h(Drafts), { ...session, identityKey: 'synthetic-other' });
    expect(intern.draft).toBeUndefined();
    expect(retirement.draft).toBeUndefined();
  });

  it('AC-FE-F444-02 浏览器存储不可写：确认完成释放槽，草稿跨挂载保留；未知命令仍以原 ID 锁定', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    let form!: ReturnType<typeof useCommandForm>;
    function Slot() {
      form = useCommandForm(slotKey(interns, employee));
      return h(Drafts);
    }
    const first = await mount(h(Slot));
    await act(async () => intern.put({ id: 'intern-draft', revision: 1, values: {} }));
    const input = {
      values: {},
      baseline: {},
      editableFields: [],
      revision: 1,
      businessId: employee,
      send: async () => ({ id: employee }),
    };
    await act(async () => {
      await form.submit(input);
      form.clear();
    });
    expect(form.peek()).toBeUndefined();
    await act(async () => first.unmount());
    await mount(h(Slot));
    expect(form.locked).toBe(false);
    expect(intern.draft?.id).toBe('intern-draft');
    const send = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await act(async () => {
      await form.submit({ ...input, send });
    });
    const command = form.peek()?.command?.id;
    await mount(h(Slot));
    await act(async () => {
      form.clear();
      await form.submit(input);
    });
    expect(form.status).toBe('unknown');
    expect(form.peek()?.command?.id).toBe(command);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('AC-FE-F444-03 试用期草稿已改服务端恢复：存储不可写仍按试用期专用资源读，未使用实习退休指针', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/regularization-draft'))
        return Response.json({ employeeId: employee, revision: 4, applicationId: 'probation-draft' });
      if (path.endsWith('/businesses/probation-draft'))
        return Response.json({
          id: 'probation-draft',
          employeeId: employee,
          revision: 2,
          kind: 'regularization',
          mode: 'application',
          status: 'draft',
          effectiveDate: '2026-11-02',
          probationResult: 'pass',
        });
      throw new Error(`unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    let recovery!: ReturnType<typeof useRegularizationRecovery>;
    function Recovery() {
      recovery = useRegularizationRecovery(employee, true);
      return h(Drafts);
    }
    const old = await mount(h(Recovery));
    await act(async () => intern.put({ id: 'intern-draft', revision: 1, values: {} }));
    await act(async () => old.unmount());
    await mount(h(Recovery));
    expect(recovery.error).toBeUndefined();
    expect(recovery.recovery?.revision).toBe(4);
    expect(recovery.recovery?.draft?.id).toBe('probation-draft');
    expect(intern.draft?.id).toBe('intern-draft');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each(['post-409', 'post-500', 'readback-500', 'list-500'])(
    'AC-FE-F444-11 新建 %s：拒绝可改正、未知保留原锁，均不发布成功刷新',
    async (failure) => {
      let reads = 0;
      let writes = 0;
      const rejected = (status: number) =>
        Response.json(
          {
            error: {
              code: status === 409 ? 'BUSINESS_CONFLICT' : 'INTERNAL',
              message: '合成失败',
            },
          },
          { status },
        );
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const path = String(input);
          if (init?.method === 'POST') {
            writes += 1;
            if (failure.startsWith('post')) return rejected(failure === 'post-409' ? 409 : 500);
            return Response.json(receipt);
          }
          if (path.includes('watcher=f444')) {
            reads += 1;
            return Response.json({ items: [] });
          }
          if (path.includes('/businesses/'))
            return failure === 'readback-500' ? rejected(500) : Response.json({ id: receipt.id, revision: 1 });
          return rejected(500);
        }),
      );
      await mount(h(List));
      await mount(h(Creator));
      await act(async () => {
        await expect(creation.submit(values, Object.keys(values), undefined, false)).rejects.toBeInstanceOf(Error);
      });
      expect(reads).toBe(1);
      expect(writes).toBe(1);
      expect(creation.form.locked).toBe(failure !== 'post-409');
      const command = creation.form.peek()?.command?.id;
      await mount(h(Creator));
      expect(creation.form.peek()?.command?.id).toBe(command);
    },
  );

  it('AC-FE-F444-04 新建实习生在途离页后返回：确认回执与本单后，新挂载列表重读', async () => {
    let release!: () => void;
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST')
          return new Promise<Response>((resolve) => {
            release = () => resolve(Response.json(receipt));
          });
        const path = String(input);
        if (path.includes('/businesses/')) return Response.json({ id: receipt.id, revision: 1 });
        if (path.includes('watcher=f444')) reads += 1;
        return Response.json({ items: [] });
      }),
    );
    const old = await mount(h(Creator));
    let result!: ReturnType<typeof creation.submit>;
    await act(async () => {
      result = creation.submit(values, Object.keys(values), undefined, false);
    });
    await act(async () => old.unmount());
    await mount(h(List));
    expect(reads).toBe(1);
    await act(async () => {
      release();
      expect(await result).toEqual(receipt);
    });
    await flush();
    expect(reads).toBe(2);
    await mount(h(Creator));
    expect(creation.form.locked).toBe(false);
  });
});
