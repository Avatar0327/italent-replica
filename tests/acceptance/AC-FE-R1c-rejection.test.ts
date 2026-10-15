/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createApiClient } from '../../apps/web/src/foundation/client.js';
import { ui } from '../../apps/web/src/foundation/messages.js';
import { requestError, transferRequest } from '../../apps/web/src/transfer/api.js';
import { text } from '../../apps/web/src/transfer/messages.js';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { useHrWrite } = await import(resolve('apps/web/src/transfer/useHrWrite.ts'));
const path = '/api/tenant/employment/transfers/employees/synthetic-employee';
const reason = '该调动日期没有可用流程，请修改后重提';
function reject(status: number, code: string, message?: string, details?: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: { code, message, details } }, { status })),
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

it('AC-FE-R1c-21 VALIDATION_FAILED 422 无 details 时 HR 页面显示服务端原因并解除提交锁', async () => {
  reject(422, 'VALIDATION_FAILED', reason);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  let state!: ReturnType<typeof useHrWrite>;
  function Probe() {
    state = useHrWrite('synthetic-hr-scope');
    return h('p', { role: 'alert' }, state.error);
  }
  try {
    await act(() => root.render(h(Probe)));
    const send = () => transferRequest<never>('tenant', path, { method: 'POST', body: '{}' });
    // 失败原样抛给 F-142 内核区分被拒 / 冲突 / 未知（#350 P2-2）；页面提示与解锁不变。
    let failure: unknown;
    await act(() => state.run(send, { employeeId: 'synthetic-employee' }).catch((cause: unknown) => (failure = cause)));
    expect(failure).toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(reason);
    expect(state.processing).toBe(false);
  } finally {
    await act(() => root.unmount());
  }
});

it.each([
  [400, 'VALIDATION_FAILED', reason],
  [409, 'VALIDATION_FAILED', reason],
  [422, 'VALIDATION_FAILED', reason],
  [409, 'BUSINESS_CONFLICT', reason],
  [409, 'REVISION_CONFLICT', text.conflict],
  [409, 'CATALOG_CHANGED', ui.refresh],
  [403, 'FORBIDDEN', ui.denied],
  [404, 'NOT_FOUND', ui.missing],
  [429, 'RATE_LIMITED', ui.rateLimit],
  [503, 'UNAVAILABLE', ui.uncertain],
])('AC-FE-R1c-21 三方共用错误入口：%s / %s 的提示不混用', async (status, code, expected) => {
  reject(Number(status), String(code), reason);
  const error = await transferRequest('tenant', path).catch((cause: unknown) => cause);
  expect(requestError(error)).toBe(expected);
});

it.each([422, 409])('AC-FE-R1c-21 %s 没有服务端原因时仍使用原统一文案', async (status) => {
  reject(status, status === 422 ? 'VALIDATION_FAILED' : 'BUSINESS_CONFLICT');
  const error = await transferRequest('tenant', path).catch((cause: unknown) => cause);
  expect(requestError(error)).toBe(status === 422 ? ui.invalid : ui.conflict);
});

it.each([
  { fieldErrors: { effectiveDate: ['调动日期不可用'] } },
  [{ path: ['effectiveDate'], message: '调动日期不可用' }],
])('AC-FE-R1c-21 字段明细保留路径和文案，不被服务端总提示覆盖：%j', async (details) => {
  reject(422, 'VALIDATION_FAILED', reason, details);
  const client = createApiClient(() => ({ tenantId: 'tenant', identityKey: 'identity' }));
  await expect(client.request(path)).rejects.toMatchObject({
    kind: 'fields',
    message: ui.invalid,
    fieldErrors: [{ name: ['effectiveDate'], errors: ['调动日期不可用'] }],
  });
  const error = await transferRequest('tenant', path).catch((cause: unknown) => cause);
  expect(requestError(error)).toBe(ui.invalid);
});

it('AC-FE-R1c-21 底座只新增原始原因，默认文案、错误分类与字段明细保持不变', async () => {
  reject(422, 'VALIDATION_FAILED', reason);
  const client = createApiClient(() => ({ tenantId: 'tenant', identityKey: 'identity' }));
  await expect(client.request(path)).rejects.toMatchObject({
    status: 422,
    code: 'VALIDATION_FAILED',
    kind: 'fields',
    message: ui.invalid,
    fieldErrors: [],
    serverMessage: reason,
  });
});
