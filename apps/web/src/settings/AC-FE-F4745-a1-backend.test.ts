/// <reference lib="dom" />
import { useTestDb } from '@italent/testkit';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import { BASE, seedPermissionWorld } from '../../../../tests/acceptance/AC-PRM-support.js';
import { uniqueSuffix } from '../../../../tests/acceptance/support/unique.js';
import { act, h, uiHarness } from '../../../../tests/acceptance/support/f474-ui.js';
import { AuditPage } from './AuditPage.js';
import { MousPage } from './MousPage.js';

const database = useTestDb();
let tree: unknown;
let audit: unknown;
let ui: ReturnType<typeof uiHarness> | undefined;
afterEach(async () => {
  await ui?.close();
  ui = undefined;
});

beforeEach(() => {
  const browser = new Window();
  for (const key of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLInputElement',
    'SVGElement',
    'Element',
    'ShadowRoot',
    'Node',
    'getComputedStyle',
    'ResizeObserver',
  ] as const) {
    vi.stubGlobal(key, key === 'window' ? browser : browser[key]);
  }
});

beforeAll(async () => {
  const world = await seedPermissionWorld(database().db);
  const suffix = uniqueSuffix();
  const traceId = `a1-${suffix}`;
  const create = async (name: string, parentId: string | null) => {
    const response = await world.api.request('POST', `${BASE}/mous`, {
      ...world.asAdmin,
      ifMatch: 0,
      headers: { 'x-trace-id': traceId },
      body: { name, code: `${name === '合成根' ? 'ROOT' : 'CHILD'}-${suffix}`, parentId, orgRanges: [] },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string };
  };
  const root = await create('合成根', null);
  await create('合成子', root.id);
  const treeResponse = await world.api.request(
    'GET',
    `${BASE}/mous/tree?q=${encodeURIComponent('合成子')}`,
    world.asAdmin,
  );
  expect(treeResponse.status).toBe(200);
  tree = await treeResponse.json();
  const auditResponse = await world.api.request(
    'GET',
    `/api/tenant/audit/data-changes?${new URLSearchParams({
      traceId,
      app: '企业设置',
      limit: '15',
    })}`,
    world.asAdmin,
  );
  expect(auditResponse.status).toBe(200);
  audit = await auditResponse.json();
  expect(audit).toMatchObject({
    items: expect.arrayContaining([expect.objectContaining({ traceId, app: '企业设置' })]),
  });
});

describe('AC-FE-F4745-A1 真后端响应接入页面', () => {
  it('真实创建审计的应用、来源和 TraceID 可在日志列读取', async () => {
    ui = uiHarness();
    await ui.render(h(AuditPage), '/', undefined, { '/api/tenant/audit/data-changes': audit });
    expect(ui.headers()).toContain('TraceID');
    expect(ui.host.textContent).toContain('企业设置');
    expect(ui.host.textContent).toContain('a1-');
  });
  it('真实查询命中子节点时祖先链完整呈现在树表', async () => {
    ui = uiHarness();
    await ui.render(h(MousPage, { code: 'permission.mous', title: '管理单元', editable: false }), '/', undefined, {
      [`${BASE}/mous/tree`]: tree,
    });
    expect(ui.host.textContent).toContain('合成根');
    const expand = ui.host.querySelector<HTMLButtonElement>('button[aria-label="展开管理单元"]');
    expect(expand).not.toBeNull();
    await act(() => expand!.click());
    expect(ui.host.textContent).toContain('合成子');
  });
});
