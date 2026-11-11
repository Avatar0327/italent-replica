/// <reference lib="dom" />
import { useTestDb } from '@italent/testkit';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import { h, uiHarness } from '../../../../tests/acceptance/support/f474-ui.js';
import { f516World } from '../../../../tests/acceptance/AC-PRM-F516-support.js';
import { BASE, createProfile, makeGrantable, grant } from '../../../../tests/acceptance/AC-PRM-support.js';
import { uniqueSuffix } from '../../../../tests/acceptance/support/unique.js';
import { UsersPage } from './UsersPage.js';
import { GrantsPage } from './GrantsPage.js';
import { AdminsPage } from './AdminsPage.js';
const database = useTestDb();
const responses: Record<string, unknown> = {};
let ui: ReturnType<typeof uiHarness> | undefined;
afterEach(async () => {
  await ui?.close();
  ui = undefined;
});
function installBrowser() {
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
}

beforeAll(async () => {
  const w = await f516World(database().db);
  const person = await w.person('合成联调员工', '13000000003', 'Zhang.Ui@example.com');
  const department = await w.hr.org('合成联调部门');
  expect((await w.hr.hire(person, department)).status).toBe(201);
  const profile = await createProfile(w, `F516UI_${uniqueSuffix()}`);
  await makeGrantable(w, [profile.id]);
  expect((await grant(w, person.userId, profile.id)).status).toBe(201);
  expect(
    (
      await w.call('POST', `${BASE}/admins`, {
        body: {
          userId: person.userId,
          role: 'audit_admin',
          grantableAdminRoles: [],
          grantableProfileIds: [],
        },
      })
    ).status,
  ).toBe(201);
  for (const resource of ['users', 'grants', 'admins']) responses[`${BASE}/${resource}`] = await w.page(`/${resource}`);
  const tree = await w.call('GET', '/api/tenant/org/organizations/tree?dimension=admin');
  expect(tree.status).toBe(200);
  responses['/api/tenant/org/organizations/tree'] = await tree.json();
});
it('AC-FE-F516 三页真实后端投影进入页面', async () => {
  for (const [Page, code, expected] of [
    [UsersPage, 'users.all', ['13000000003', '在职', 'Zhang.Ui@example.com']],
    [GrantsPage, 'permission.user_grant', ['13000000003', '合成联调员工']],
    [AdminsPage, 'permission.admins', ['合成联调部门']],
  ] as const) {
    installBrowser();
    ui = uiHarness();
    await ui.render(h(Page, { code, title: '合成联调', editable: false, canScope: false }), '/', undefined, responses);
    for (const value of expected) expect(ui.host.querySelector('tbody')?.textContent).toContain(value);
    await ui.close();
    ui = undefined;
  }
});
