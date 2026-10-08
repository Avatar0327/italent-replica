/// <reference lib="dom" />
// @vitest-environment happy-dom
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const path = resolve('apps/web/src/org/OrgChangePage.tsx');
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  if (root) await act(() => root.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

it.each([200, 409])('AC-ORG-29 在途提示确认前不保存，响应 %s 后锁住表单防止盲重试', async (status) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const org = { id: 'org', name: '原组织', revision: 1, remarks: '', parents: { admin: { parentId: 'parent' } } };
  let patches = 0;
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/employment-preview')) return Response.json({ hasPendingEmployment: true });
    if (options?.method === 'PATCH') {
      patches++;
      expect(JSON.parse(String(options.body))).toEqual({
        name: '新组织',
        effectiveDate: '2026-10-08',
        addEmployment: true,
      });
      expect(new Headers(options.headers).get('if-match')).toBe('1');
      expect(new Headers(options.headers).get('idempotency-key')).toMatch(/^[a-f0-9-]{36}$/);
      return Response.json(status === 200 ? { ...org, revision: 2 } : { error: { message: '冲突' } }, { status });
    }
    if (url.includes('/parent?')) return Response.json({ id: 'parent', name: '原上级' });
    if (url.includes('/org?')) return Response.json(org);
    return Response.json({ items: [org] });
  });
  vi.stubGlobal('fetch', fetcher);
  const { OrgChangePage } = await import(path);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(() => root.render(createElement(OrgChangePage)));
  const input = async (element: HTMLInputElement, value: string) => {
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const submit = async (form: HTMLFormElement) => {
    await act(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  };
  await input(container.querySelector('input')!, 'tenant');
  await input(container.querySelector('input[type=date]')!, '2026-10-08');
  await submit(container.querySelector('form')!);
  await act(() => container.querySelector<HTMLButtonElement>('fieldset button')!.click());
  await act(() => container.querySelector<HTMLButtonElement>('fieldset li button')!.click());
  const form = container.querySelectorAll('form')[1]!;
  await input(form.querySelector('input')!, '新组织');
  const choice = form.querySelector<HTMLSelectElement>('[name=addEmployment]')!;
  expect(choice.required).toBe(true);
  await act(() => {
    choice.value = 'yes';
    choice.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await submit(form);
  expect(patches).toBe(0);
  expect(container.querySelector('[role=alertdialog]')?.textContent).toContain('在途任职');
  await act(() => container.querySelector<HTMLButtonElement>('[role=alertdialog] button')!.click());
  expect(patches).toBe(1);
  expect(form.querySelector('fieldset')!.disabled).toBe(true);
  await submit(form);
  expect(patches).toBe(1);
  expect(container.textContent).toContain(status === 200 ? '组织变更已保存' : '组织已被修改');
});
