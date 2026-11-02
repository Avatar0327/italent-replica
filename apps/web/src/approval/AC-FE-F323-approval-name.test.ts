/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * F-323a 列车 I2 m2：审批详情“人员类别”显示后端附带的字典名称（employmentTypeName），不显示类别 UUID；
 * 名称查不到（null）时显示既有占位“已保存的值”。夹具按 GET /approval/instances/:id 的真实返回形状
 * （disclosure.ts detailView + employmentTypeNames：名称与 ID 并列在 values / originals 里）。
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ApprovalDetail as Detail } from './types.js';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { ApprovalDetail } = await import(resolve('apps/web/src/approval/ApprovalDetail.tsx'));
const session = {
  tenantId: 'synthetic-tenant',
  identityKey: 'synthetic-user',
  tenantName: '合成租户',
  timezone: 'Asia/Shanghai',
  displayName: '合成用户',
  source: 'server',
};
const AFTER = '7d1f4a52-3b0e-4c8a-9f21-5a6b7c8d9e01';
const BEFORE = '0a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const DEPARTMENT = '5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f';
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function detail(afterName: string | null, beforeName: string | null): Detail {
  return {
    id: 'synthetic-instance',
    title: '调动申请',
    revision: 1,
    status: 'running',
    approvalType: 'transfer',
    actions: [],
    recordsHidden: false,
    form: {
      values: {
        departmentId: DEPARTMENT,
        employmentType: AFTER,
        employmentTypeName: afterName,
        effectiveDate: '2026-10-15',
      },
      originals: { departmentId: DEPARTMENT, employmentType: BEFORE, employmentTypeName: beforeName },
    },
    tasks: [],
    logs: [],
  };
}

async function render(value: Detail) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(value))));
  await act(async () => {
    root.render(
      h(SessionProvider, { session }, h(ApprovalDetail, { row: value, layout: 'page', onClose() {}, onChanged() {} })),
    );
  });
}

function field(label: string) {
  return [...host.querySelectorAll('.approval-field')].find((row) => row.querySelector('dt')?.textContent === label);
}

it('AC-FE-F323-approval-name：人员类别当前值与原值显示字典名称，不显示 UUID，名称不另起一行', async () => {
  await render(detail('合成类别新', '合成类别原'));
  const row = field('人员类别');
  expect(row?.querySelector('dd > span')?.textContent).toBe('合成类别新');
  expect(row?.querySelector('dd > small')?.textContent).toContain('合成类别原');
  expect(host.textContent).not.toContain(AFTER);
  expect(host.textContent).not.toContain(BEFORE);
  expect(host.textContent).not.toContain('employmentTypeName');
});

it('AC-FE-F323-approval-name：名称查不到时显示“已保存的值”占位，不回落为 UUID', async () => {
  await render(detail(null, null));
  const row = field('人员类别');
  expect(row?.querySelector('dd > span')?.textContent).toBe('已保存的值');
  expect(row?.querySelector('dd > small')?.textContent).toContain('已保存的值');
  expect(host.textContent).not.toContain(AFTER);
  expect(host.textContent).not.toContain(BEFORE);
});
