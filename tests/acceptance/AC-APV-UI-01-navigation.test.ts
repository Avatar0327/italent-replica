/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { act, createElement } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const tenant = '00000000-0000-4000-8000-00000000AB01';
const instance = '00000000-0000-4000-8000-00000000AB02';
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.history.replaceState(null, '', '/');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const body = input.endsWith('/manager')
        ? { canApply: true, canViewReporting: false }
        : input.includes('/manager/todos')
          ? {
              items: [
                {
                  taskId: '00000000-0000-4000-8000-00000000AB03',
                  instanceId: instance,
                  title: '合成调动待办',
                  nodeName: '经理审批',
                },
              ],
            }
          : input.endsWith('/profile')
            ? { employee: { id: instance, name: '合成员工', code: 'UI-01', revision: 0 }, record: null }
            : input.includes('/catalog')
              ? { today: '2026-10-07', types: [], reasons: [] }
              : { items: [], counts: {} };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function mount(file: string, name: string) {
  const module = await import(resolve(`apps/web/src/${file}`));
  await act(async () => root.render(createElement(module[name])));
}

async function enterTenant() {
  await act(async () => {
    const input = host.querySelector('input[name="tenantId"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ` ${tenant} `);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

function approvalLink() {
  return Array.from(host.querySelectorAll('a')).find((link) => link.textContent === '审批中心');
}

describe('AC-APV-UI-01 现有身份入口与审批详情深链', () => {
  it.each([
    ['员工', 'employee-self-service/EmployeePage.tsx', 'EmployeePage'],
    ['经理', 'transfer/ManagerPage.tsx', 'ManagerPage'],
    ['HR', 'transfer/TransferPage.tsx', 'TransferPage'],
  ])('%s 现有入口可进入审批中心，并携带规范化的当前租户', async (_role, file, name) => {
    await mount(file!, name!);
    expect(approvalLink()?.getAttribute('href')).toBe('/approvals');
    await enterTenant();
    await vi.waitFor(() => expect(approvalLink()?.getAttribute('href')).toContain(`tenantId=${tenant.toLowerCase()}`));
  });

  it('经理待办标题可进入对应实例，使用实例ID而非任务ID或员工ID', async () => {
    await mount('transfer/ManagerPage.tsx', 'ManagerPage');
    await enterTenant();
    await vi.waitFor(() => expect(host.textContent).toContain('合成调动待办'));
    const link = Array.from(host.querySelectorAll('a')).find((item) => item.textContent === '合成调动待办');
    expect(link).toBeTruthy();
    const url = new URL(link!.href);
    expect(url.pathname).toBe('/approvals');
    expect(url.searchParams.get('instanceId')).toBe(instance.toLowerCase());
    expect(url.searchParams.get('tenantId')).toBe(tenant.toLowerCase());
  });

  it('App 注册 /approvals 路由，打开深链时进入审批中心', async () => {
    window.history.replaceState(null, '', `/approvals?instanceId=${instance}&tenantId=${tenant}`);
    await mount('App.tsx', 'App');
    expect(host.querySelector('h1')?.textContent).toBe('审批中心');
    expect((host.querySelector('input[name="tenantId"]') as HTMLInputElement)?.value).toBe(tenant.toLowerCase());
  });
});
