import type { Page } from '@playwright/test';
import { test, expect, employee } from './fixtures.js';
import {
  VOID_LIMIT,
  ackToken,
  activate,
  addExit,
  ids,
  notLaunched,
  rowSubmit,
  setupExits,
  type ExitServer,
} from './exit-list-fixtures.js';

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
/** 工具栏“直接离职 / 离职申请”：选人 → 下一步 → 填最后工作日 → 提交（首次点击只做提交前检查）。 */
async function startDirect(page: Page, lastWorkDate: string, entry = '直接离职') {
  await page.getByRole('button', { name: entry, exact: true }).click();
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
const popconfirm = (page: Page) => page.locator('.ant-popconfirm:visible').getByRole('button', { name: /确\s*定/ });
const toast = (page: Page, text: string) => page.locator('.ant-message').getByText(text, { exact: true });
async function openDetail(page: Page, name: string) {
  await rowOf(page, name).getByRole('button', { name: '查看详情', exact: true }).click();
  await expect(dialog(page).locator('.ant-modal-title')).toHaveText('离职管理');
}
async function reschedule(page: Page, lastWorkDate: string) {
  await dialog(page)
    .getByRole('button', { name: /^编\s*辑$/ })
    .click();
  await date(page, '最后工作日', lastWorkDate);
  await dialog(page)
    .getByRole('button', { name: /^保\s*存$/ })
    .click();
  await page
    .getByRole('dialog')
    .filter({ hasText: '确认改期' })
    .getByRole('button', { name: /确\s*定/ })
    .click();
}

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
  // 清单里没有下游数据（只有未接入的薪资）：不弹提示
  await expect(page.getByText('下游数据提示')).toHaveCount(0);
});

// ---- 第 2 轮回归（.dev_inputs/rfer2c2_1.md） ----

test('AC-FE-R2c2-06 离职申请：先建草稿再按草稿 revision 提交审批；提交被拒后重试沿用原单，不再建单', async ({
  page,
}) => {
  const server = await setupExits(page);
  server.submitRejections = 1;
  await startDirect(page, '2026-11-20', '离职申请');
  await dialog(page).getByRole('button', { name: '确认并提交', exact: true }).click();
  await expect(dialog(page).getByText('合成的提交拒绝原因')).toBeVisible();
  await expect(toast(page, '已提交')).toHaveCount(0);
  const created = server.sent.filter((item) => item.path === `/exits/employees/${employee}`);
  expect(created).toHaveLength(1);
  expect(created[0]!.body).toMatchObject({ mode: 'application', lastWorkDate: '2026-11-20' });
  const submits = () => writes(server, `/exits/${ids.created}/submit`);
  expect(submits()).toHaveLength(1);
  expect(submits()[0]!.ifMatch).toBe('1');
  expect(submits()[0]!.body).toEqual({});
  await dialog(page).getByRole('button', { name: '提交审批', exact: true }).click();
  await expect(toast(page, '已提交')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(server.sent.filter((item) => item.path === `/exits/employees/${employee}`)).toHaveLength(1);
  expect(submits().map((item) => item.ifMatch)).toEqual(['1', '1']);
  await expect(rowOf(page, '合成待离职员工').getByRole('cell', { name: '审批中', exact: true })).toBeVisible();
});

test('AC-FE-R2c2-07 发起交接 409：弹窗内重读离职单，按新 revision 重提', async ({ page }) => {
  const server = await setupExits(page);
  server.handoverRaces = 1;
  await openDetail(page, names.inProgress);
  const section = dialog(page).getByRole('region', { name: '离职交接' });
  await section.getByRole('button', { name: '发起离职交接', exact: true }).click();
  await popconfirm(page).click();
  await section.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
  await section.getByRole('button', { name: '发起离职交接', exact: true }).click();
  await popconfirm(page).click();
  await expect(toast(page, '已发起离职交接')).toBeVisible();
  expect(writes(server, '/handover/submit').map((item) => item.ifMatch)).toEqual(['3', '4']);
});

test('AC-FE-R2c2-08 重新提交交接 409：重读交接单（不是离职单）revision 后重提', async ({ page }) => {
  const server = await setupExits(page);
  server.handovers[ids.inProgress] = notLaunched(ids.inProgress);
  server.handoverRaces = 1;
  await openDetail(page, names.inProgress);
  const section = dialog(page).getByRole('region', { name: '离职交接' });
  await section.getByRole('button', { name: '重新提交交接', exact: true }).click();
  await popconfirm(page).click();
  await section.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
  await section.getByRole('button', { name: '重新提交交接', exact: true }).click();
  await popconfirm(page).click();
  await expect(toast(page, '已发起离职交接')).toBeVisible();
  expect(writes(server, '/resubmit').map((item) => item.ifMatch)).toEqual(['1', '2']);
});

test('AC-FE-R2c2-09 批量发起整批未发起成功：刷新后没有可操作行，逐人结果仍在', async ({ page }) => {
  const server = await setupExits(page);
  server.rowActions = { [ids.inProgress]: [rowSubmit] };
  server.batchOutcome = { outcome: 'not_launched', reason: 'NO_INITIATOR_ACCOUNT' };
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await list(page).getByRole('button', { name: '批量发起离职交接', exact: true }).click();
  const result = page.getByRole('dialog').filter({ hasText: '批量发起结果' });
  await expect(result.getByRole('listitem')).toHaveText([`${names.inProgress}：未发起成功（NO_INITIATOR_ACCOUNT）`]);
  expect(writes(server, '/batch-submit')).toHaveLength(1);
  // 写后刷新：服务端不再给行动作，批量按钮消失，回执不随之消失
  await expect(list(page).getByRole('button', { name: '批量发起离职交接', exact: true })).toHaveCount(0);
  await expect(result.getByRole('listitem')).toHaveCount(1);
});

test('AC-FE-R2c2-10 已加黑单（详情无加黑三项）只改日期可保存，PATCH 不带加黑字段；改动加黑组仍校验', async ({
  page,
}) => {
  const server = await setupExits(page);
  server.blacklisted = [ids.inProgress];
  await openDetail(page, names.inProgress);
  await reschedule(page, '2026-12-10');
  await expect.poll(() => server.sent.filter((item) => item.method === 'PATCH').length).toBe(1);
  expect(server.sent.find((item) => item.method === 'PATCH')!.body).toEqual({ lastWorkDate: '2026-12-10' });
  await expect(dialog(page).locator('.ant-modal-title')).toHaveText('离职管理');
  await dialog(page)
    .getByRole('button', { name: /^编\s*辑$/ })
    .click();
  await date(page, '有效截止日期', '2027-12-31');
  await dialog(page)
    .getByRole('button', { name: /^保\s*存$/ })
    .click();
  await expect(dialog(page).getByText('请填写加黑原因')).toBeVisible();
  expect(server.sent.filter((item) => item.method === 'PATCH')).toHaveLength(1);
});

test('AC-FE-R2c2-11 改期 / 撤销成功后展示服务端下游清单（按权限裁剪的条数与附加项）', async ({ page }) => {
  const server = await setupExits(page);
  server.downstream = 'found';
  await openDetail(page, names.inProgress);
  await reschedule(page, '2026-12-10');
  const notice = page.getByRole('dialog').filter({ hasText: '下游数据提示' });
  await expect(notice).toContainText('假期余额：1 条，另有 2 条无权查看');
  await expect(notice).toContainText('未接入，需人工核对：薪资档案');
  await notice.getByRole('button', { name: /确\s*定/ }).click();
  await expect(notice).toHaveCount(0);
  await dialog(page).getByRole('button', { name: '撤销离职', exact: true }).click();
  await dialog(page).getByLabel('撤销原因').fill('合成撤销原因');
  await dialog(page)
    .getByRole('button', { name: /^保\s*存$/ })
    .click();
  await expect(notice).toContainText('合同：1 条，另有 1 条无权查看');
  await expect(notice).toContainText('被作废的在途任职申请：1 条，保持作废，需重新发起');
  await notice.getByRole('button', { name: /确\s*定/ }).click();
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: views.all, exact: true }).click();
  await expect(rowOf(page, names.inProgress).getByRole('cell', { name: '已作废', exact: true })).toBeVisible();
});

test('AC-FE-R2c2-12 普通生效失败与挂起：列表有标记，详情显示原因', async ({ page }) => {
  const server = await setupExits(page);
  const failed = { status: 'failed', reason: 'REBUILD_REQUIRED', blockedByBusinessId: null };
  addExit(server, '合成员工丙', { status: 'approved', activation: failed });
  const waiting = { status: 'suspended', reason: 'PREDECESSOR_FAILED', blockedByBusinessId: ids.failed };
  addExit(server, '合成员工丁', { status: 'approved', activation: waiting });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(rowOf(page, '合成员工丙')).toContainText('生效失败');
  await expect(rowOf(page, '合成员工丁')).toContainText('生效挂起');
  await expect(rowOf(page, names.inProgress)).not.toContainText('生效');
  await openDetail(page, '合成员工丙');
  await expect(dialog(page).getByText('生效失败：生效区间内有其他任职记录，需处理后重试')).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  await openDetail(page, '合成员工丁');
  await expect(dialog(page).getByText('生效挂起：前序业务生效失败')).toBeVisible();
});
