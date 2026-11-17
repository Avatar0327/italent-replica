import { test, expect, seedDemoUser, snapshotFixture } from './fixtures.js';
import type { Page, Route } from '@playwright/test';

/**
 * F-481 S5 真浏览器主流程（设计 §8.2、§8.3）：电子签 > 签署记录 8 列、撤销确认与逐条回执；
 * 我的签署 详情确认签署后按钮消失；员工自助 > 我的签署 进入同一页面、同一接口。
 * 夹具形状按后端 apps/api esign：签署记录 record-access.ts presentRecord / records.ts listRecords、actOnRecords；
 * 我的签署 mine.ts mineViews（列表无正文、详情带 content 与 nodes）、signReceipt。
 */
const RECORD_OBJECT = 'TenantBase.ESignRecord';
const RECORDS = '/api/tenant/esign/records';
const MINE = '/api/tenant/esign/mine';
const R1 = '84810000-0000-4000-8000-000000000801';
const R2 = '84810000-0000-4000-8000-000000000802';
const M1 = '84820000-0000-4000-8000-000000000901';
const INITIATOR = '20000000-0000-4000-8000-000000000903';
const button = (label: string) => new RegExp(`^${label.split('').join('\\s*')}$`);
const at = (path: string) => (url: URL) => url.pathname === path;

const record = (id: string, owner: string, extra: Record<string, unknown> = {}) => ({
  id,
  revision: 1,
  initiator: { id: INITIATOR, name: '合成发起人' },
  owner: { id: `3${id.slice(1)}`, name: owner },
  ownerDepartment: { id: `5${id.slice(1)}`, name: '合成研发部' },
  scene: 'transfer',
  initiatedAt: '2026-11-15T16:30:05.000Z',
  completedAt: null,
  status: 'signing',
  files: [
    { seq: 1, name: '合成调动协议' },
    { seq: 2, name: '合成保密协议' },
  ],
  currentNode: 'employee',
  failureReason: null,
  ...extra,
});
const recordPermission = {
  objectCode: RECORD_OBJECT,
  dataOperations: { read: true },
  viewableFields: ['initiator', 'owner', 'ownerDepartment', 'scene', 'initiatedAt', 'completedAt', 'status', 'files'],
  editableFields: [],
  buttons: ['ESignRecord.Remind', 'ESignRecord.Revoke', 'ESignRecord.Download'].map((buttonCode) => ({
    buttonCode,
    level: 'list',
  })),
};
const signTask = (extra: Record<string, unknown> = {}) => ({
  id: M1,
  revision: 2,
  status: 'signing',
  currentNode: 'employee',
  employeeSignedAt: null as string | null,
  enterpriseSignedAt: null as string | null,
  completedAt: null as string | null,
  scene: 'transfer',
  initiator: { id: INITIATOR, name: '合成发起人' },
  initiatedAt: '2026-11-15T16:30:05.000Z',
  expiresAt: '2026-11-22T15:59:59.000Z',
  canSign: true,
  files: [{ seq: 1, templateId: '74820000-0000-4000-8000-000000000901', templateName: '合成调动协议' }],
  ...extra,
});

async function esignFixtures(page: Page) {
  // 菜单入口按应用的 entryObjects 放行：电子签菜单组挂在企业设置应用下（S4）。
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        apps: snapshotFixture.apps.map((app) =>
          app.app === 'settings' ? { ...app, entryObjects: [...app.entryObjects, RECORD_OBJECT] } : app,
        ),
      },
    }),
  );
  await page.route(`**/permission/me/objects/${RECORD_OBJECT}`, (route) => route.fulfill({ json: recordPermission }));
}

async function mineFixtures(page: Page) {
  let task = signTask();
  const writes: unknown[] = [];
  const list = (tab: string | null) =>
    tab === 'done' ? (task.employeeSignedAt ? [task] : []) : task.canSign ? [task] : [];
  await page.route(at(MINE), (route) => {
    const tab = new URL(route.request().url()).searchParams.get('tab');
    return route.fulfill({ json: { items: list(tab) } });
  });
  await page.route(at(`${MINE}/${M1}`), (route) =>
    route.fulfill({
      json: {
        ...task,
        files: task.files.map((item) => ({ ...item, content: '合成员工甲自 2026-11-20 起调入合成研发部。' })),
        nodes: [
          { node: 'employee', userId: snapshotFixture.session.userId, signedAt: task.employeeSignedAt },
          { node: 'enterprise', userId: INITIATOR, signedAt: task.enterpriseSignedAt },
        ],
      },
    }),
  );
  await page.route(at(`${MINE}/${M1}/sign`), (route: Route) => {
    writes.push(route.request().postDataJSON());
    task = {
      ...task,
      revision: task.revision + 1,
      currentNode: 'enterprise',
      employeeSignedAt: '2026-11-16T03:00:00.000Z',
      canSign: false,
    };
    const { id, revision, status, currentNode, employeeSignedAt, enterpriseSignedAt, completedAt } = task;
    return route.fulfill({
      json: { id, revision, status, currentNode, employeeSignedAt, enterpriseSignedAt, completedAt },
    });
  });
  return writes;
}

test('AC-TRF-F481-FE-S5-01 电子签 > 签署记录：8 列、撤销确认后逐条回执，冲突只提示刷新', async ({ page }) => {
  await esignFixtures(page);
  const writes: unknown[] = [];
  await page.route(at(RECORDS), (route) => {
    const items = [record(R1, '合成员工甲'), record(R2, '合成员工乙', { revision: 3, currentNode: 'enterprise' })];
    return route.fulfill({ json: { items, total: items.length, page: 1, pageSize: 20 } });
  });
  await page.route(at(`${RECORDS}/revoke`), (route) => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        items: [
          { id: R1, ok: true },
          { id: R2, ok: false, code: 'REVISION_CONFLICT' },
        ],
      },
    });
  });
  await seedDemoUser(page);
  await page.goto('/esign-records');
  const records = page.locator('.esign-records');
  await expect(records.getByRole('heading', { name: '签署记录' })).toBeVisible({ timeout: 15_000 });
  await expect(records.locator('.ant-tabs-tab')).toHaveText(['全部', '签署中', '签署完成']);
  await expect(records.locator('.ant-table-thead th:not(.ant-table-selection-column)')).toHaveText([
    '发起人',
    '业务所有者',
    '所有者部门',
    '签署场景',
    '发起时间',
    '签署完成时间',
    '签署状态',
    '电子文件',
  ]);
  const first = records.locator('.ant-table-row').filter({ hasText: '合成员工甲' });
  await expect(first).toContainText('2026-11-16 00:30:05');
  await expect(first).toContainText('签署中（待员工签署）');
  await expect(first).toContainText('合成调动协议，合成保密协议');
  const heading = records.locator('.page-heading');
  await heading.getByRole('button', { name: button('撤销') }).click();
  await expect(page.locator('.ant-message')).toContainText('请至少选择一条数据');
  await first.locator('.ant-checkbox-input').check();
  await records.locator('.ant-table-row').filter({ hasText: '合成员工乙' }).locator('.ant-checkbox-input').check();
  await heading.getByRole('button', { name: button('撤销') }).click();
  const dialog = page.locator('.ant-modal').filter({ hasText: '撤销后该签署将无法继续，是否继续' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: button('确定') }).click();
  const result = page.locator('.ant-modal').filter({ hasText: '已撤销' });
  await expect(result).toContainText('数据已变更，请刷新列表后重试');
  await expect(result).not.toContainText('REVISION_CONFLICT');
  expect(writes).toEqual([
    {
      items: [
        { id: R1, revision: 1 },
        { id: R2, revision: 3 },
      ],
    },
  ]);
});

test('AC-TRF-F481-FE-S5-02 电子签 > 我的签署：详情显示正文与模拟签署说明，确认后按钮消失', async ({ page }) => {
  await esignFixtures(page);
  const writes = await mineFixtures(page);
  await seedDemoUser(page);
  await page.goto('/esign-mine');
  const mine = page.locator('.esign-mine');
  await expect(mine.getByRole('heading', { name: '我的签署' })).toBeVisible({ timeout: 15_000 });
  await expect(mine.locator('.ant-tabs-tab')).toHaveText(['待我签署', '我已签署']);
  await expect(mine.locator('.ant-table-thead th')).toHaveText([
    '签署场景',
    '发起人',
    '发起时间',
    '截止时间',
    '文件名称',
    '状态',
  ]);
  const row = mine.locator('.ant-table-row').filter({ hasText: '合成调动协议' });
  await expect(row).toContainText('2026-11-22 23:59:59');
  await row.getByRole('button', { name: '调动电子签署' }).click();
  const drawer = page.locator('.ant-drawer-content');
  await expect(drawer).toContainText('合成员工甲自 2026-11-20 起调入合成研发部。');
  await expect(drawer).toContainText('复刻模拟签署，不发送短信、不做实名认证');
  await drawer.getByRole('button', { name: button('确认签署') }).click();
  await expect(drawer).toContainText('签署中（待企业确认）');
  await expect(drawer.getByRole('button', { name: button('确认签署') })).toHaveCount(0);
  expect(writes).toEqual([{ revision: 2 }]);
});

test('AC-TRF-F481-FE-S5-03 员工自助 > 我的签署：进入同一页面、读同一接口', async ({ page }) => {
  await mineFixtures(page);
  const reads: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === MINE) reads.push(url.searchParams.get('tab') ?? '');
  });
  await seedDemoUser(page);
  await page.goto('/self');
  const sidebar = page.locator('.shell-sidebar');
  const self = sidebar.getByRole('menuitem', { name: '员工自助', exact: true });
  await expect(self).toBeVisible({ timeout: 15_000 });
  // 侧栏首次加载时展开当前应用；没展开（从别处跳来）时先展开员工自助（同 AC-FE-F164）
  const item = sidebar.getByRole('menuitem', { name: '我的签署', exact: true });
  if ((await self.getAttribute('aria-expanded')) !== 'true') await self.click();
  await item.click();
  await expect(page).toHaveURL(/\/self\/esign$/);
  const mine = page.locator('.esign-mine');
  await expect(mine.getByRole('heading', { name: '我的签署' })).toBeVisible({ timeout: 15_000 });
  await expect(mine.locator('.ant-table-row').filter({ hasText: '合成调动协议' })).toBeVisible();
  expect(reads).toContain('pending');
});
