/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * S1-P2-05 / AC-ORG-29：组织变更页面按可见、可编辑字段初始化，不把整个组织对象及旧上级都可见当作整单编辑前提：
 * 1. 上级组织超出范围（读取 404）仍可改名 / 改上级 / 仅改备注；2. name 可编辑、parents 隐藏仍能改名；
 * 3. parents 可编辑、name 隐藏仍能改行政上级。
 */
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

const FULL = { id: 'org', name: '原组织', revision: 1, remarks: '', parents: { admin: { parentId: 'parent' } } };
const PARENT = { id: 'parent', name: '原上级', revision: 1, remarks: null, parents: {} };
const NEXT_PARENT = { id: 'newparent', name: '新上级', revision: 1, remarks: null, parents: {} };

/** 列表返回待变更组织与候选上级；按用例决定组织详情、上级详情的返回。 */
function stubFetch(org: Record<string, unknown>, parent: Response | (() => Response)) {
  const patches: unknown[] = [];
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/employment-preview')) return Response.json({ hasPendingEmployment: false });
    if (options?.method === 'PATCH') {
      patches.push(JSON.parse(String(options.body)));
      expect(new Headers(options.headers).get('if-match')).toBe('1');
      return Response.json({ ...org, revision: 2 });
    }
    if (url.includes('/parent?')) return typeof parent === 'function' ? parent() : parent.clone();
    if (url.includes('/newparent?')) return Response.json(NEXT_PARENT);
    if (url.includes('/org?')) return Response.json(org);
    return Response.json({ items: [org, NEXT_PARENT] });
  });
  vi.stubGlobal('fetch', fetcher);
  return patches;
}

async function openChangeForm() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const { OrgChangePage } = await import(path);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(() => root.render(createElement(OrgChangePage)));
  const type = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    await act(() => {
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const submit = async (form: HTMLFormElement) => {
    await act(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  };
  const choose = async (select: HTMLSelectElement, value: string) => {
    await act(() => {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };
  await type(container.querySelector('input')!, 'tenant');
  await type(container.querySelector('input[type=date]')!, '2026-10-08');
  await submit(container.querySelector('form')!);
  await act(() => container.querySelector<HTMLButtonElement>('fieldset button')!.click());
  await act(() => container.querySelector<HTMLButtonElement>('fieldset li button')!.click());
  const forms = container.querySelectorAll('form');
  // 修改表单必须出现：不能因为上级不可读或个别字段隐藏而只剩查询表单。
  expect(forms, container.textContent ?? '').toHaveLength(2);
  const form = forms[1]!;
  const employmentChoice = async () => {
    const choice = form.querySelector<HTMLSelectElement>('[name=addEmployment]')!;
    expect(choice.required).toBe(true);
    await choose(choice, 'yes');
  };
  return { container, form, type, submit, choose, employmentChoice };
}

it.each(['name', 'remarks'] as const)('上级组织超出范围（读取 404）：仍能编辑本组织的 %s', async (field) => {
  const patches = stubFetch(FULL, () =>
    Response.json({ error: { code: 'NOT_FOUND', message: '组织不存在' } }, { status: 404 }),
  );
  const page = await openChangeForm();
  // 当前上级保持为原值（不可读时用占位项），不改上级就不提交 parents。
  expect(page.form.querySelector<HTMLSelectElement>('select')!.value).toBe('parent');
  if (field === 'name') {
    await page.type(page.form.querySelector('input')!, '新组织');
    await page.employmentChoice();
  } else {
    await page.type(page.form.querySelector('textarea')!, '新备注');
  }
  await page.submit(page.form);
  expect(patches).toEqual([
    field === 'name'
      ? { name: '新组织', effectiveDate: '2026-10-08', addEmployment: true }
      : { effectiveDate: '2026-10-08', remarks: '新备注' },
  ]);
  expect(page.container.textContent).toContain('组织变更已保存');
});

it('name 可编辑、parents 隐藏：不显示上级字段，仍能改名', async () => {
  const { parents: _hidden, ...withoutParents } = FULL;
  const patches = stubFetch(withoutParents, Response.json(PARENT));
  const page = await openChangeForm();
  expect(page.form.querySelector('select')).toBeNull();
  await page.type(page.form.querySelector('input')!, '新组织');
  await page.employmentChoice();
  await page.submit(page.form);
  expect(patches).toEqual([{ name: '新组织', effectiveDate: '2026-10-08', addEmployment: true }]);
});

it('parents 可编辑、name 隐藏：不显示名称字段，仍能改行政上级', async () => {
  const { name: _hidden, ...withoutName } = FULL;
  const patches = stubFetch(withoutName, Response.json(PARENT));
  const page = await openChangeForm();
  expect(page.form.querySelector('input')).toBeNull();
  const parentSearch = page.container.querySelectorAll('fieldset')[1]!;
  await act(() => parentSearch.querySelector<HTMLButtonElement>('button')!.click());
  await act(() => parentSearch.querySelectorAll<HTMLButtonElement>('li button')[1]!.click());
  expect(page.form.querySelector<HTMLSelectElement>('select')!.value).toBe('newparent');
  await page.employmentChoice();
  await page.submit(page.form);
  expect(patches).toEqual([
    { effectiveDate: '2026-10-08', parents: { admin: { parentId: 'newparent', sequence: null } }, addEmployment: true },
  ]);
});
