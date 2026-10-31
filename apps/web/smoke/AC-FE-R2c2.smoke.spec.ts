import type { Page } from '@playwright/test';
import { test, expect, employee } from './fixtures.js';
import { VOID_LIMIT, ackToken, activate, ids, setupExits, type ExitServer } from './exit-list-fixtures.js';

const views = { in_progress: '离职中的员工', completed: '已完成的离职', all: '全部离职记录' } as const;
const base = ['姓名', '工号', '部门', '职位', '最后工作日', '离职生效日期', '离职类型'];
const headers = {
  in_progress: [...base, '离职原因', '办理方式', '审批状态'],
  completed: [...base, '离职原因', '离职去向'],
  all: [...base, '离职原因', '办理方式', '审批状态'],
};
const names = { inProgress: '合成离职中员工', completed: '合成已离职员工', failed: '合成生效失败员工' };
const dialog = (page: Page) => page.getByRole('dialog').last();
const list = (page: Page) => page.locator('.exit-card');
const rowOf = (page: Page, name: string) => list(page).getByRole('row').filter({ hasText: name });

async function date(page: Page, label: string, value: string) {
  const input = dialog(page)
    .locator('.ant-form-item')
    .filter({ has: page.locator('label').getByText(label, { exact: true }) })
    .locator('input');
  await input.fill(value);
  await input.press('Enter');
  await dialog(page).locator('.ant-modal-title').click();
}
/** 工具栏“直接离职”：选人 → 下一步 → 填最后工作日 → 提交（首次点击只做提交前检查）。 */
async function startDirect(page: Page, lastWorkDate: string) {
  await page.getByRole('button', { name: '直接离职', exact: true }).click();
  await dialog(page).locator('.ant-select-selector').click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').getByText('合成待离职员工').click();
  await dialog(page)
    .getByRole('button', { name: /下一步/ })
    .click();
  await expect(dialog(page).getByText('离职员工：合成待离职员工')).toBeVisible();
  await date(page, '最后工作日', lastWorkDate);
  await dialog(page)
    .getByRole('button', { name: /^提\s*交$/ })
    .click();
}
const writes = (server: ExitServer, suffix: string) => server.sent.filter((item) => item.path.endsWith(suffix));

test('AC-FE-R2c2-01 三视图各按 view 读，列按投影，切换视图不串数据', async ({ page }) => {
  const server = await setupExits(page);
  await expect(page.getByRole('heading', { name: '离职管理', exact: true })).toBeVisible();
  await expect.poll(() => server.queries[0]?.get('view')).toBe('in_progress');
  expect(server.queries[0]?.get('pageSize')).toBe('30');
  const expected = {
    in_progress: [names.inProgress, names.failed],
    completed: [names.completed],
    all: [names.inProgress, names.completed, names.failed],
  };
  for (const view of ['completed', 'all', 'in_progress'] as const) {
    await page.getByRole('button', { name: views[view], exact: true }).click();
    await expect(page.getByRole('button', { name: views[view], exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => server.queries.at(-1)?.get('view')).toBe(view);
    await expect(list(page).locator('.ant-table-thead th')).toHaveText([...headers[view], '操作']);
    for (const name of Object.values(names))
      await expect(rowOf(page, name)).toHaveCount(expected[view].includes(name) ? 1 : 0);
  }
  // 字典项显示保存时的名称；被裁剪 / 空值显示占位
  await expect(rowOf(page, names.inProgress).getByRole('cell', { name: '主动离职', exact: true })).toBeVisible();
  await expect(rowOf(page, names.inProgress).getByRole('cell', { name: '审批中', exact: true })).toBeVisible();
});

test('AC-FE-R2c2-02 直接离职：提交前检查 → 确认并提交带令牌，员工进离职中；生效进已完成', async ({ page }) => {
  const server = await setupExits(page);
  await startDirect(page, '2026-11-20');
  const preview = writes(server, '/preview');
  expect(preview).toHaveLength(1);
  expect(preview[0]!.body).toEqual({ lastWorkDate: '2026-11-20' });
  await expect(dialog(page).getByText('离职生效时将作废 1 条在途任职申请')).toBeVisible();
  await dialog(page).getByRole('button', { name: '确认并提交', exact: true }).click();
  await expect(dialog(page)).toBeHidden();
  const created = server.sent.filter((item) => item.path === `/exits/employees/${employee}`);
  expect(created).toHaveLength(1);
  expect(created[0]!.ifMatch).toBe('5');
  expect(created[0]!.key).toBeTruthy();
  expect(created[0]!.body).toMatchObject({ mode: 'direct', lastWorkDate: '2026-11-20' });
  expect(created[0]!.body.exit).toMatchObject({ pendingTransferAck: ackToken, addToBlacklist: false });
  expect(created[0]!.body).not.toHaveProperty('pendingTransferAck');
  await expect(rowOf(page, '合成待离职员工')).toHaveCount(1);
  activate(server, ids.created);
  await page.getByRole('button', { name: views.completed, exact: true }).click();
  await expect(rowOf(page, '合成待离职员工')).toHaveCount(1);
  await page.getByRole('button', { name: views.in_progress, exact: true }).click();
  await expect(rowOf(page, names.inProgress)).toHaveCount(1);
  await expect(rowOf(page, '合成待离职员工')).toHaveCount(0);
});

test('AC-FE-R2c2-03 F-240：超上限只提示上限，没有“确认并提交”，继续提交不带令牌', async ({ page }) => {
  const server = await setupExits(page);
  server.preview = 'tooMany';
  await startDirect(page, '2026-11-20');
  await expect(dialog(page).getByText(`超过上限 ${VOID_LIMIT} 条`, { exact: false })).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: '确认并提交', exact: true })).toHaveCount(0);
  await dialog(page).getByRole('button', { name: '继续提交', exact: true }).click();
  await expect(dialog(page)).toBeHidden();
  const created = server.sent.filter((item) => item.path === `/exits/employees/${employee}`);
  expect(created).toHaveLength(1);
  expect(created[0]!.body.exit).not.toHaveProperty('pendingTransferAck');
  // 详情：生效失败原因同一错误码
  await rowOf(page, names.failed).getByRole('button', { name: '查看详情', exact: true }).click();
  await expect(dialog(page).getByText('生效失败：在途任职申请过多', { exact: false })).toBeVisible();
});

test('AC-FE-R2c2-04 详情交接区只读展示交接事项', async ({ page }) => {
  await setupExits(page);
  await page.getByRole('button', { name: views.completed, exact: true }).click();
  await rowOf(page, names.completed).getByRole('button', { name: '查看详情', exact: true }).click();
  const section = dialog(page).getByRole('region', { name: '离职交接' });
  await expect(section.getByText('交接中', { exact: true })).toBeVisible();
  await expect(section.locator('.ant-table-thead th')).toHaveText(['交接事项', '分类', '状态']);
  await expect(section.getByRole('row').filter({ hasText: '归还门禁卡' })).toContainText('已完成');
  await expect(section.getByRole('row').filter({ hasText: '结清借款' })).toContainText('未完成');
  await expect(section.getByRole('button')).toHaveCount(0);
});

test('AC-FE-R2c2-05 改期：确认后 PATCH 只发改动字段、If-Match = 离职单 revision；撤销后移出离职中', async ({
  page,
}) => {
  const server = await setupExits(page);
  await rowOf(page, names.inProgress).getByRole('button', { name: '查看详情', exact: true }).click();
  await dialog(page)
    .getByRole('button', { name: /^编\s*辑$/ })
    .click();
  await expect(dialog(page).locator('.ant-modal-title')).toHaveText('编辑');
  await date(page, '最后工作日', '2026-12-10');
  await dialog(page)
    .getByRole('button', { name: /^保\s*存$/ })
    .click();
  await expect(page.getByText('最后工作日将修改为 2026-12-10，确定保存吗？')).toBeVisible();
  await page
    .getByRole('dialog')
    .filter({ hasText: '确认改期' })
    .getByRole('button', { name: /确\s*定/ })
    .click();
  await expect(page.getByRole('dialog').filter({ hasText: '确认改期' })).toBeHidden();
  const patched = server.sent.filter((item) => item.method === 'PATCH');
  expect(patched).toHaveLength(1);
  expect(patched[0]!.path).toBe(`/exits/${ids.inProgress}`);
  expect(patched[0]!.ifMatch).toBe('3');
  expect(patched[0]!.body).toEqual({ lastWorkDate: '2026-12-10' });
  await expect(dialog(page).getByText('2026-12-10', { exact: true })).toBeVisible();
  await dialog(page).getByRole('button', { name: '撤销离职', exact: true }).click();
  await dialog(page).getByLabel('撤销原因').fill('合成撤销原因');
  await dialog(page)
    .getByRole('button', { name: /^保\s*存$/ })
    .click();
  await expect.poll(() => writes(server, '/cancel').length).toBe(1);
  const sent = writes(server, '/cancel')[0]!;
  expect(sent.ifMatch).toBe('4');
  expect(sent.body).toEqual({ reason: '合成撤销原因' });
  await expect(rowOf(page, names.inProgress)).toHaveCount(0);
});
