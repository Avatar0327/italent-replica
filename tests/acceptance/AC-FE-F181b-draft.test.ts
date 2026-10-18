/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { TransferFormModel } from '../../apps/web/src/transfer/types.js';
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act, useState } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { useDraftRestore } = await import(resolve('apps/web/src/transfer/useDraftRestore.ts'));
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const employee = '30000000-0000-4000-8000-000000000001';
const id = '60000000-0000-4000-8000-000000000001';
const meta = { id, revision: 3, transferTypeCode: 'transfer' };
const business = {
  id,
  revision: 3,
  employeeId: employee,
  status: 'draft',
  formId: 'hr',
  effectiveDate: '2026-10-20',
  fields: { place: '暂存工作地' },
  customFields: {},
};
const model: TransferFormModel = {
  employees: [],
  departments: [],
  catalog: { types: [{ code: 'transfer', name: '调动', formId: 'hr' }], reasons: [] },
  employeeId: employee,
  effectiveDate: '2026-10-17',
  transferTypeCode: 'transfer',
  reasonCode: '',
  withEstablishment: false,
  fields: {},
  customFields: {},
  preview: null,
};
const roots: { unmount(): void }[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(() => root.unmount());
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
function server(draft: Record<string, unknown> | null = meta, deletion = 200, code = '') {
  const state = { draft, deletes: [] as RequestInit[], reads: 0 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === 'DELETE') {
        state.deletes.push(init);
        if (deletion !== 200)
          return Response.json(
            {
              error: {
                code: code === 'DRAFT_REPLACED' ? 'CONFLICT' : code,
                details: { reason: code },
                message: '合成拒绝',
              },
            },
            { status: deletion },
          );
        state.draft = null;
        return Response.json({ ...business, status: 'deleted', revision: 4 });
      }
      if (url.endsWith('/draft')) {
        state.reads++;
        return Response.json({ draft: state.draft });
      }
      if (url.endsWith('/linkage')) return Response.json({ businessId: id, revision: 3, options: {} });
      return Response.json(business);
    }),
  );
  return state;
}
async function mount(identity = crypto.randomUUID()) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  let current!: { draft: ReturnType<typeof useDraftRestore>; model: TransferFormModel };
  function Probe() {
    const [value, setValue] = useState(model);
    current = { draft: useDraftRestore('tenant', identity, employee, setValue), model: value };
    return null;
  }
  await act(() =>
    root.render(h(SessionProvider, { session: { tenantId: 'tenant', identityKey: identity } }, h(Probe))),
  );
  return { get: () => current, root };
}
it('AC-FE-F181b-01 空会话仍读取服务端暂存；刷新重挂载仍带出', async () => {
  const state = server();
  const first = await mount();
  expect(first.get().draft.status).toBe('restored');
  expect(first.get().model.pendingDraft?.fields).toEqual({ place: '暂存工作地' });
  sessionStorage.clear();
  const second = await mount();
  expect(second.get().draft.status).toBe('restored');
  expect(state.reads).toBe(2);
});
it('AC-FE-F181b-02 元数据只含 id/revision 时照常带出，不能从唯一表单推断类型', async () => {
  server({ id, revision: 3 });
  const probe = await mount();
  expect(probe.get().draft.status).toBe('restored');
  expect(probe.get().model).toMatchObject({ transferTypeCode: '', typeConfirmation: true });
  expect(probe.get().model.pendingDraft?.fields).toEqual({ place: '暂存工作地' });
});
it('AC-FE-F181b-03 清除发送 DELETE、原版本与命令 ID；成功后再选不带出', async () => {
  const state = server();
  const probe = await mount();
  await act(() => probe.get().draft.clear());
  expect(state.deletes).toHaveLength(1);
  expect(new Headers(state.deletes[0]!.headers).get('if-match')).toBe('3');
  expect(new Headers(state.deletes[0]!.headers).get('idempotency-key')).toBeTruthy();
  expect((await mount()).get().draft.status).toBe('idle');
});
it.each(['DRAFT_REPLACED', 'REVISION_CONFLICT'])('AC-FE-F181b-04 %s 重读服务端新状态，不静默清空', async (code) => {
  const state = server(meta, 409, code);
  const probe = await mount();
  state.draft = null;
  await act(() => probe.get().draft.clear());
  expect(state.deletes).toHaveLength(1);
  expect(state.reads).toBe(2);
  expect(probe.get().draft.command.status).toBe('conflict');
  expect(probe.get().draft.status).toBe('idle');
});
it('AC-FE-F181b-05 无删除权限明确提示并保留暂存', async () => {
  server(meta, 403, 'FORBIDDEN');
  const probe = await mount();
  await act(() => probe.get().draft.clear());
  expect(probe.get().draft.error).toBe('没有删除权限，无法清除暂存');
  expect(probe.get().draft.status).toBe('restored');
});
it('AC-FE-F181b-06 null 不带出、不锁表单', async () => {
  server(null);
  const probe = await mount();
  expect(probe.get().draft.status).toBe('idle');
  expect(probe.get().draft.command.locked).toBe(false);
});
it('AC-FE-F181b-07 未知结果关闭重开仍锁定，不发送第二个 DELETE', async () => {
  const state = server(meta, 503, 'UNAVAILABLE');
  const identity = crypto.randomUUID();
  const probe = await mount(identity);
  await act(() => probe.get().draft.clear());
  expect(probe.get().draft.command.status).toBe('unknown');
  const reopened = await mount(identity);
  expect(reopened.get().draft.command.locked).toBe(true);
  await act(() => reopened.get().draft.clear());
  expect(state.deletes).toHaveLength(1);
});

it('AC-FE-F181b-12 删除已成功但后续读取失败：保持未知锁，不出现重提窗口', async () => {
  const state = server();
  const probe = await mount();
  const original = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (state.deletes.length && init.method !== 'DELETE') throw new Error('read disconnected');
      return original(url, init);
    }),
  );
  await act(() => probe.get().draft.clear());
  expect(probe.get().draft.command.status).toBe('unknown');
  await act(() => probe.get().draft.clear());
  expect(state.deletes).toHaveLength(1);
});
it('AC-FE-F181b-13 陈旧删除回执不能报成功，版本按实际发出的 command.revision 核对', async () => {
  const state = server();
  const probe = await mount();
  const original = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === 'DELETE') return Response.json({ ...business, status: 'deleted' });
      return original(url, init);
    }),
  );
  await act(() => probe.get().draft.clear());
  expect(probe.get().draft.command.status).toBe('unknown');
  expect(state.reads).toBe(1);
});
it('AC-FE-F181b-14 内容被裁剪仍带出，缺 employeeId/status/fields 不丢记录', async () => {
  server({ id, revision: 3 });
  const original = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) =>
      url.includes('/businesses/') ? Response.json({ id, revision: 3 }) : original(url, init),
    ),
  );
  const probe = await mount();
  expect(probe.get().draft.status).toBe('restored');
  expect(probe.get().model).toMatchObject({ transferTypeCode: '', typeConfirmation: true });
});
it('AC-FE-F181b-15 读链版本不一致时整链重读；不能把旧元数据配新内容', async () => {
  const state = server();
  const original = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('/businesses/') && state.reads === 1) return Response.json({ ...business, revision: 4 });
      return original(url, init);
    }),
  );
  const probe = await mount();
  expect(state.reads).toBe(2);
  expect(probe.get().draft.status).toBe('restored');
});
