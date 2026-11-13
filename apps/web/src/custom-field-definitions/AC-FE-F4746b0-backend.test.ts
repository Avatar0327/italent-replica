/// <reference lib="dom" />
import { useTestDb } from '@italent/testkit';
import { Window } from 'happy-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { seedPermissionWorld } from '../../../../tests/acceptance/AC-PRM-support.js';
import { h, uiHarness } from '../../../../tests/acceptance/support/f474-ui.js';
import { CustomFieldDefinitionsPage } from './CustomFieldDefinitionsPage.js';
import { PATH, parseRows, receipt } from './model.js';

const database = useTestDb();
let ui: ReturnType<typeof uiHarness> | undefined;
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
afterEach(async () => {
  await ui?.close();
  ui = undefined;
});
it('AC-F474-FE06 真实后端的创建、列表与继承回执供页面消费', async () => {
  const w = await seedPermissionWorld(database().db);
  const created = await w.api.request('POST', PATH, {
    ...w.asAdmin,
    ifMatch: 0,
    body: { name: '合成后端字段', valueType: 'integer', objectType: 'employment' },
  });
  expect(created.status).toBe(201);
  const body = await created.json();
  expect(receipt(body, 0)).toEqual({ id: body.id });
  const updated = await w.api.request('PUT', `${PATH}/${body.id}/inheritance`, {
    ...w.asAdmin,
    ifMatch: 1,
    body: { inherit: false },
  });
  expect(updated.status).toBe(200);
  expect(receipt(await updated.json(), 1, body.id)).toEqual({ id: body.id });
  const list = await w.api.request('GET', `${PATH}?objectType=employment&page=1&pageSize=200`, w.asAdmin);
  expect(list.status).toBe(200);
  const response = await list.json();
  expect(parseRows(response)).toMatchObject([{ id: body.id, revision: 2, inherit: false }]);
  ui = uiHarness();
  await ui.render(h(CustomFieldDefinitionsPage), '/', ['name', 'valueType', 'objectType', 'inherit'], {
    [PATH]: response,
  });
  expect(ui.headers()).toEqual(['名称', '类型', '对象', '是否继承', '操作']);
  const cells = [...ui.host.querySelectorAll('tbody tr[data-row-key] td')].map((cell) => cell.textContent);
  expect(cells).toEqual(['合成后端字段', '整数', '任职记录', '否', '设置继承']);
});
