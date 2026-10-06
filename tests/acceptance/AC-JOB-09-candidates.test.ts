/// <reference lib="dom" />
// @vitest-environment happy-dom
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const path = resolve('apps/web/src/job/JobPage.tsx');
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const org = input.includes('org/organizations');
      const body = org
        ? { error: { message: '无组织权限' } }
        : input.includes('job/sequences')
          ? { items: [{ id: 'sequence', name: '可选序列' }] }
          : input.includes('job/posts')
            ? { items: [{ id: 'post', name: '可编辑职务', revision: 1, sequenceId: null }], today: '2026-10-05' }
            : { items: [], today: '2026-10-05' };
      return new Response(JSON.stringify(body), { status: org ? 403 : 200 });
    }),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function click(text: string) {
  const button = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === text);
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
async function open() {
  const { JobPage } = await import(path);
  await act(async () => root.render(createElement(JobPage)));
  await act(async () => {
    const input = host.querySelector('input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'tenant');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () =>
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
}
it('AC-JOB-09 组织403不影响职务序列候选；职务编辑不请求无关候选', async () => {
  await open();
  await click('编辑');
  expect(host.querySelector('select[name="sequenceId"]')?.textContent).toContain('可选序列');
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('org/organizations'))).toBe(false);
});
it('AC-JOB-09 新建职位所需的组织403独立失败，序列仍可选择', async () => {
  await open();
  await click('职位');
  await click('新建');
  expect(host.querySelector('select[name="sequenceId"]')?.textContent).toContain('可选序列');
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('org/organizations'))).toBe(true);
});
it('AC-JOB-09 第201条候选也可选择，完成消息显示历史跳过原因', async () => {
  const original = fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, options?: RequestInit) => {
      if (input.includes('job/sequences'))
        return new Response(
          JSON.stringify({
            items: input.includes('page=2')
              ? [{ id: 'last', name: '第201条序列' }]
              : Array.from({ length: 200 }, (_, i) => ({ id: String(i), name: `序列${i}` })),
          }),
        );
      if (input.includes('sequence-sync/messages'))
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 'done',
                createdAt: '2026-10-13',
                message: { count: 1, skipped: [{ recordId: 'historical-record', reason: 'BECAME_HISTORICAL' }] },
              },
            ],
          }),
        );
      return original(input, options);
    }),
  );
  await open();
  await click('编辑');
  const select = host.querySelector<HTMLSelectElement>('select[name="sequenceId"]')!;
  expect(select.textContent).toContain('第201条序列');
  await act(async () => {
    select.value = 'last';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(select.value).toBe('last');
  expect(host.textContent).toContain('同步序列到任职');
  expect(host.textContent).toContain('historical-record：执行时已成为历史，未同步');
});
