import { test, expect } from './fixtures.js';
import { id, setupR3b } from './r3b-fixtures.js';

const detail = '.survey-detail-page';
async function openActivity(page: Parameters<typeof setupR3b>[0]) {
  await setupR3b(page, '/survey360');
  await page.getByRole('button', { name: '合成领导力评估', exact: true }).click();
}

test('AC-360 F475 整页八页签与基本信息分组、返回后可重新进入', async ({ page }) => {
  await openActivity(page);
  const content = page.locator(detail);
  await expect(content).toBeVisible();
  await expect(content.getByRole('tab')).toHaveText([
    '基本信息',
    '套卷',
    '评价关系',
    '进程控制',
    '数据筛选',
    '个人报告',
    '团队报告',
    '报表',
  ]);
  for (const title of ['评价者作答页面设置', '评价者不认真作答提醒设置', '结果处理方式设置', '活动授权'])
    await expect(content.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(content).toContainText('未完成（缺后端契约）');
  await content.getByRole('button', { name: '返回活动列表' }).click();
  await expect(page.locator(detail)).toHaveCount(0);
  await page.getByRole('button', { name: '合成领导力评估', exact: true }).click();
  await expect(page.locator(detail)).toBeVisible();
});

test('AC-360 F475 活动套卷仅显示关联集合，关联读取失败不得回退全库', async ({ page }) => {
  await openActivity(page);
  await page.route('**/survey360/questionnaires', (route) =>
    route.fulfill({
      json: {
        items: [
          { id, name: '合成关联套卷', type: 'rating', status: 'used', revision: 2 },
          { id: 'unrelated', name: '合成其他活动套卷', type: 'rating', status: 'enabled', revision: 1 },
        ],
      },
    }),
  );
  await page.locator(detail).getByRole('tab', { name: '套卷', exact: true }).click();
  await expect(page.getByRole('button', { name: '合成关联套卷', exact: true })).toBeVisible();
  await expect(page.getByText('合成其他活动套卷', { exact: true })).toHaveCount(0);
  await page.route(`**/survey360/activities/${id}/objects`, (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: 'UNAVAILABLE', message: '合成关联不可读' } },
    }),
  );
  await page
    .locator(detail)
    .getByRole('button', { name: /刷\s*新/, exact: true })
    .last()
    .click();
  await expect(page.locator(detail)).toContainText('加载失败，请稍后重试');
  await expect(page.locator(detail).locator('tr[data-row-key]')).toHaveCount(0);
  await expect(page.getByText('合成其他活动套卷', { exact: true })).toHaveCount(0);
});

test('AC-360 F475 进程、数据筛选与报告按真实信封读取，不生成截图样本', async ({ page }) => {
  await openActivity(page);
  await page.route(`**/survey360/activities/${id}/progress`, (route) =>
    route.fulfill({
      json: {
        total: { completed: 1, all: 2 },
        items: [
          {
            personId: id,
            name: '合成评价者',
            email: 'reviewer@example.com',
            status: 'completed',
            lastSentAt: null,
            progress: { done: 3, total: 3 },
            emailState: null,
            todo: null,
          },
          { personId: 'second', name: '合成待评人', status: 'not_started', progress: { done: 0, total: 1 } },
        ],
      },
    }),
  );
  await page.route(`**/survey360/activities/${id}/reports`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: null,
            objectId: id,
            objectName: '合成报告对象',
            department: '合成部门',
            position: null,
            template: { id: 'standard', name: '标准版' },
            status: 'not_generated',
            generatedAt: null,
          },
        ],
      },
    }),
  );
  const content = page.locator(detail);
  await content.getByRole('tab', { name: '进程控制', exact: true }).click();
  await expect(content).toContainText('50%');
  await expect(content).toContainText('3/3');
  await expect(content).toContainText('reviewer@example.com');
  await content.getByRole('tab', { name: '数据筛选', exact: true }).click();
  await expect(content).toContainText('合成参评人');
  await content.getByRole('tab', { name: '个人报告', exact: true }).click();
  await expect(content).toContainText('合成报告对象');
  await expect(content.locator('tr[data-row-key]')).toHaveCount(1);
  await expect(content).toContainText('标准版');
  await expect(content).not.toContainText('核心版');
  await content.getByRole('tab', { name: '团队报告', exact: true }).click();
  await expect(content).toContainText('未验证');
});

test('AC-360 F475 内置题库与角色默认显示不混用自定义数据或假保存', async ({ page }) => {
  await setupR3b(page, '/survey360');
  await page.getByRole('tab', { name: '题库 · 企业自定义', exact: true }).click();
  await page.getByRole('tab', { name: '北森内置', exact: true }).click();
  await expect(page.getByText('合成协作套卷', { exact: true })).toHaveCount(0);
  await expect(page.getByText('未完成（缺后端契约）', { exact: false }).first()).toBeVisible();
  await page.getByRole('tab', { name: '评价角色设置', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: '评价角色名称' })).toBeVisible();
  await page.getByRole('button', { name: '默认显示设置', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '默认显示设置', exact: true });
  await expect(modal.getByRole('radio')).toHaveCount(3);
  await expect(modal.getByRole('radio').first()).not.toBeChecked();
  await expect(modal.getByRole('button', { name: /确\s*定/, exact: true })).toBeDisabled();
  await modal.getByRole('button', { name: /取\s*消/, exact: true }).click();
  await expect(modal).toHaveCount(0);
});

for (const response of ['conflict', 'unknown', 'stale-receipt']) {
  test(`AC-360 F475 启停 ${response} 按原单恢复且使用实际提交版本`, async ({ page }) => {
    await setupR3b(page, '/survey360');
    const requests: { revision?: string; command?: string }[] = [];
    await page.route(`**/survey360/activities/${id}/enable`, (route) => {
      requests.push({
        revision: route.request().headers()['if-match'],
        command: route.request().headers()['idempotency-key'],
      });
      if (requests.length === 1 && response !== 'stale-receipt')
        return route.fulfill({
          status: response === 'conflict' ? 409 : 503,
          json: { error: { code: response === 'conflict' ? 'REVISION_CONFLICT' : 'RESULT_UNKNOWN' } },
        });
      return route.fulfill({ json: { id, revision: response === 'stale-receipt' ? 3 : 6 } });
    });
    await page.getByRole('button', { name: /启\s*用/, exact: true }).click();
    const form = page.getByRole('dialog', { name: /启\s*用/, exact: true });
    await form.getByRole('button', { name: /保\s*存/, exact: true }).click();
    expect(requests[0]?.revision).toBe('3');
    if (response === 'conflict') {
      await page.route(`**/survey360/activities/${id}`, (route) =>
        route.fulfill({
          json: {
            id,
            revision: 5,
            name: '合成领导力评估',
            status: 'draft',
            form: 'multiple',
          },
        }),
      );
      await form.getByRole('button', { name: '重读最新版本', exact: true }).click();
      await form.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
      await form.getByRole('button', { name: /保\s*存/, exact: true }).click();
      await expect(form).toHaveCount(0);
      expect(requests.map((r) => r.revision)).toEqual(['3', '5']);
      expect(requests[1]?.command).not.toBe(requests[0]?.command);
    } else {
      await expect(form).toContainText('结果待确认');
      await form.getByRole('button', { name: /取\s*消/, exact: true }).click();
      await page.getByRole('button', { name: '合成领导力评估', exact: true }).click();
      await page
        .locator(detail)
        .getByRole('button', { name: /启\s*用/, exact: true })
        .click();
      await expect(form).toContainText('结果待确认');
      await expect(form.getByRole('button', { name: /保\s*存/, exact: true })).toBeDisabled();
      expect(requests).toHaveLength(1);
    }
  });
}

test('AC-360 F475 活动编辑冲突重读后改回打开时的原值仍提交，未改字段取新值', async ({ page }) => {
  await openActivity(page);
  const requests: { revision?: string; body: unknown }[] = [];
  await page.route(`**/survey360/activities/${id}`, (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({
        json: {
          id,
          revision: 5,
          name: '合成远端名称',
          welcome: '合成远端欢迎语',
          status: 'draft',
          form: 'multiple',
          showAppraiserName: true,
          roleDisplay: 'name',
        },
      });
    requests.push({ revision: route.request().headers()['if-match'], body: route.request().postDataJSON() });
    return requests.length === 1
      ? route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT' } } })
      : route.fulfill({ json: { id, revision: 6 } });
  });
  await page
    .locator(detail)
    .getByRole('button', { name: /编\s*辑/, exact: true })
    .click();
  const form = page.getByRole('dialog', { name: /编\s*辑/, exact: true });
  await form.getByLabel('名称', { exact: true }).fill('合成草稿名称');
  await form.getByRole('button', { name: /保\s*存/, exact: true }).click();
  await form.getByRole('button', { name: '重读最新版本', exact: true }).click();
  await form.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
  await expect(form.getByLabel('欢迎语', { exact: true })).toHaveValue('合成远端欢迎语');
  await form.getByLabel('名称', { exact: true }).fill('合成领导力评估');
  await form.getByRole('button', { name: /保\s*存/, exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(requests[1]).toEqual({ revision: '5', body: { name: '合成领导力评估' } });
});
