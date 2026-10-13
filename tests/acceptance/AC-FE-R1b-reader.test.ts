/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { useRead } = await import(resolve('apps/web/src/personnel/useRead.ts'));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let refresh: () => void;
const pending: { resolve(response: Response): void; signal?: AbortSignal }[] = [];
function Probe({ path }: { path: string }) {
  const result = useRead(path);
  refresh = result.refresh;
  return h('div', {}, JSON.stringify({ data: result.data, loading: result.loading, failed: !!result.error }));
}
function render(path: string, identityKey = 'identity-a') {
  root.render(h(SessionProvider, { session: { tenantId: 'tenant-a', identityKey } }, h(Probe, { path })));
}
beforeEach(() => {
  pending.length = 0;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_path: string, options: RequestInit) =>
        new Promise<Response>((resolve) => {
          pending.push({ resolve, signal: options.signal ?? undefined });
        }),
    ),
  );
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('AC-FE-R1b-05 读取一致性', () => {
  it('快速切换档案后，即使旧请求忽略 abort 并迟到也不能覆盖新档案', async () => {
    await act(() => render('/api/tenant/personnel/employees/a'));
    await act(() => render('/api/tenant/personnel/employees/b'));
    expect(pending[0]!.signal?.aborted).toBe(true);
    await act(() => pending[1]!.resolve(Response.json({ id: 'b', name: '新档案' })));
    await act(() => pending[0]!.resolve(Response.json({ id: 'a', name: '旧档案' })));
    expect(host.textContent).toContain('新档案');
    expect(host.textContent).not.toContain('旧档案');
  });
  it('切换身份立即清除旧值；403 不展示旧数据，刷新成功使用全新响应', async () => {
    const path = '/api/tenant/personnel/employees/a';
    await act(() => render(path));
    await act(() => pending[0]!.resolve(Response.json({ name: '原身份可见', email: 'example@example.com' })));
    expect(host.textContent).toContain('原身份可见');
    await act(() => render(path, 'identity-b'));
    expect(host.textContent).not.toContain('原身份可见');
    await act(() => pending[1]!.resolve(Response.json({ error: { code: 'FORBIDDEN' } }, { status: 403 })));
    expect(JSON.parse(host.textContent!)).toEqual({ loading: false, failed: true });
    await act(() => refresh());
    await act(() => pending[2]!.resolve(Response.json({ name: '新身份可见' })));
    expect(host.textContent).toContain('新身份可见');
    expect(host.textContent).not.toContain('example@example.com');
  });
});
