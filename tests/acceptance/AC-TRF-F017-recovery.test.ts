/// <reference lib="dom" />
// @vitest-environment happy-dom
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const path = resolve('apps/web/src/transfer/TransferPage.tsx');
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  if (root) await act(() => root.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

it.each(['REVISION_CONFLICT', 'CONFLICT'])('F-017 暂存提交 %s 后恢复同单且不创建新单', async (code) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const form = {
    id: 'form',
    name: '调动',
    isStandard: true,
    excludedAutofillFields: [],
    customFields: [],
    fieldModes: { 'preset:departmentId': 'editable', 'preset:remarks': 'editable' },
  };
  const preview = {
    form,
    employeeRevision: 2,
    fields: { departmentId: 'department', remarks: '旧值' },
    customFields: {},
    before: null,
    allowDirectTransfer: true,
    allowedActions: { application: true, directList: false, directRow: false },
  };
  let submits = 0;
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.includes('/catalog'))
      return Response.json({
        today: '2026-10-01',
        types: [{ code: 'cross_department', formId: 'form', name: '部门调动' }],
        reasons: [],
      });
    if (url.includes('/self'))
      return Response.json({ items: [{ id: 'employee', name: '合成人员', code: 'E1', revision: 2 }] });
    if (url.endsWith('/preview')) return Response.json(preview);
    if (url.includes('/departments')) return Response.json({ items: [{ id: 'department', name: '部门' }] });
    if (url.endsWith('/submit')) {
      submits++;
      if (submits === 1) return Response.json({ error: { code, message: '数据变更' } }, { status: 409 });
      expect(new Headers(options?.headers).get('if-match')).toBe(code === 'REVISION_CONFLICT' ? '5' : '1');
      return Response.json({ id: 'saved', revision: 6, status: 'in_review' });
    }
    if (url.endsWith('/businesses/saved'))
      return Response.json({
        id: 'saved',
        revision: 5,
        status: 'draft',
        effectiveDate: '2026-10-01',
        fields: { departmentId: 'department', remarks: '最新字段' },
        customFields: {},
      });
    if (url.endsWith('/employees/employee')) return Response.json({ id: 'saved', revision: 1, status: 'draft' });
    throw new Error(url);
  });
  vi.stubGlobal('fetch', fetcher);
  const { TransferPage } = await import(path);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(TransferPage, { initiator: 'employee' }));
  });
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('[name=tenantId]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'tenant');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
  const click = async (label: string) => {
    const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === label);
    expect(button, label).toBeTruthy();
    expect(button!.disabled).toBe(false);
    await act(async () => {
      button!.click();
    });
  };
  await click('暂存');
  await click('提交暂存申请');
  expect(submits).toBe(1);
  if (code === 'REVISION_CONFLICT') {
    await click('重新读取已暂存申请');
    expect(container.querySelector<HTMLInputElement>('[name="remarks"]')?.value).toBe('最新字段');
  } else expect(container.querySelector<HTMLInputElement>('[name="remarks"]')?.value).toBe('旧值');
  expect(submits).toBe(1);
  await click('提交暂存申请');
  expect(submits).toBe(2);
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/employees/employee'))).toHaveLength(1);
});

it('F-017 原职位名称单独读取，不加入新部门候选', async () => {
  const { loadReferences } = await import('../../apps/web/src/transfer/api.js');
  const fetcher = vi.fn(async (url: string) =>
    Response.json(
      url.includes('/positions/old')
        ? { id: 'old', name: '原部门职位' }
        : { items: [{ id: 'new', name: '目标部门职位' }] },
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  const result = await loadReferences(
    'tenant',
    {
      form: { fieldModes: { 'preset:positionId': 'editable' } },
      fields: { departmentId: 'new-department' },
      before: { fields: { positionId: 'old' } },
    } as never,
    { effectiveDate: '2026-10-01', fields: {} } as never,
    new AbortController().signal,
  );
  expect(result.references.positionId).toEqual([{ id: 'new', name: '目标部门职位' }]);
  expect(result.beforeReferences.positionId).toEqual([{ id: 'old', name: '原部门职位' }]);
});
