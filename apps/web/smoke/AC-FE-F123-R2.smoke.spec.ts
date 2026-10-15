import type { Locator } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { activity, ev, id, questionnaire, setupR3b } from './r3b-fixtures.js';

const save = { name: /保\s*存/, exact: true };
const edit = { name: /编\s*辑/, exact: true };
const field = (form: Locator, label: string) =>
  form.locator('.ant-form-item').filter({ has: form.page().locator(`label[title="${label}"]`) });

async function expectContentLocked(form: Locator) {
  const content = field(form, '题目与计分');
  const inputs = content.locator('input, textarea');
  expect(await inputs.count()).toBeGreaterThan(10);
  for (const input of await inputs.all()) await expect(input).toBeDisabled();
  for (const button of await content.getByRole('button').all()) await expect(button).toBeDisabled();
}

for (const [tab, path] of [
  ['套卷', 'questionnaires'],
  ['题库 · 企业自定义', 'questionnaire-templates'],
]) {
  for (const outcome of ['slow', 'conflict']) {
    test(`AC-FE-F123-R2 ${tab} ${outcome} 所有内容控件合并提交锁`, async ({ page }) => {
      await setupR3b(page, '/survey360');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const writes: unknown[] = [];
      await page.route(`**/survey360/${path}/${id}`, async (route) => {
        if (route.request().method() === 'GET')
          return route.fulfill({ json: { ...questionnaire, revision: writes.length ? 3 : 2 } });
        writes.push(route.request().postDataJSON());
        if (outcome === 'slow') {
          await gate;
          return route.fulfill({ json: { ...questionnaire, revision: 3 } });
        }
        return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT' } } });
      });
      await page.getByRole('tab', { name: tab, exact: true }).click();
      await page.getByRole('button', { name: questionnaire.name, exact: true }).click();
      await page.getByRole('button', edit).click();
      const form = page.getByRole('dialog', { name: '编辑', exact: true });
      await field(form, '名称').getByRole('textbox').fill('待保存名称');
      await form.getByRole('button', save).click();
      await expect.poll(() => writes.length).toBe(1);
      try {
        if (outcome === 'conflict') await expect(form.getByText('重读最新版本', { exact: true })).toBeVisible();
        await expectContentLocked(form);
      } finally {
        release();
      }
      if (outcome === 'slow') {
        await expect(form).toHaveCount(0);
        expect(writes).toEqual([{ name: '待保存名称' }]);
        return;
      }
      await form.getByRole('button', { name: '重读最新版本', exact: true }).click();
      await expect(form.getByRole('button', { name: '已核对差异，继续编辑', exact: true })).toBeEnabled();
      await expectContentLocked(form);
      await expect(form.getByRole('spinbutton', { name: /^分值/ })).toHaveValue('5');
      await form.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
      await expect(form.getByRole('spinbutton', { name: /^分值/ })).toBeEnabled();
      await expect(field(form, '名称').getByRole('textbox')).toHaveValue('待保存名称');
      expect(writes).toEqual([{ name: '待保存名称' }]);
    });
  }
}

test('AC-FE-F123-R2 360 冲突重读启用后只读评价形式显示最新值、可编辑名称保留草稿', async ({ page }) => {
  await setupR3b(page, '/survey360');
  const writes: unknown[] = [];
  await page.route(`**/survey360/activities/${id}`, (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({
        json: writes.length ? { ...activity, form: 'single', status: 'enabled', revision: 4 } : activity,
      });
    writes.push(route.request().postDataJSON());
    return writes.length === 1
      ? route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT' } } })
      : route.fulfill({ json: { ...activity, revision: 5 } });
  });
  await page.getByRole('button', { name: activity.name, exact: true }).click();
  await page.getByRole('button', edit).click();
  const form = page.getByRole('dialog', { name: '编辑', exact: true });
  await field(form, '名称').getByRole('textbox').fill('保留名称草稿');
  await form.getByRole('button', save).click();
  await form.getByRole('button', { name: '重读最新版本', exact: true }).click();
  await expect(field(form, '评价形式')).toContainText('single');
  await expect(field(form, '评价形式').getByRole('combobox')).toHaveCount(0);
  await form.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
  await expect(field(form, '名称').getByRole('textbox')).toHaveValue('保留名称草稿');
  await form.getByRole('button', save).click();
  await expect(form).toHaveCount(0);
  expect(writes[1]).toEqual({ name: '保留名称草稿' });
});

for (const completed of [false, true]) {
  test(`AC-FE-F123-R2 评定重读${completed ? '完成' : '有报名'}后只读字段使用最新记录`, async ({ page }) => {
    await setupR3b(page, '/evaluation');
    let writes = 0;
    const latest = {
      ...ev,
      revision: 3,
      applyCount: 1,
      status: completed ? 'completed' : 'enabled',
      effectiveDate: '2026-11-30',
      name: '服务端最新名称',
      chains: ev.chains.map((chain) => ({ ...chain, name: `最新${chain.name}` })),
      conditions: [{ kind: 'common', applicantKind: 'self', expression: '1', details: [] }],
    };
    await page.route(`**/evaluation/activities/${id}`, (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ json: writes ? latest : ev });
      writes++;
      return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT' } } });
    });
    await page.getByRole('button', { name: ev.name, exact: true }).click();
    await page.getByRole('button', edit).click();
    const form = page.getByRole('dialog', { name: '编辑', exact: true });
    await form.getByRole('textbox', { name: /名称$/, exact: true }).fill('我的名称草稿');
    await form.getByRole('button', { name: '下一步', exact: true }).click();
    await form.getByRole('button', { name: '下一步', exact: true }).click();
    if (!completed) {
      await form.getByRole('textbox', { name: '环节名称', exact: true }).first().fill('我的链路草稿');
      await form.getByRole('checkbox').check();
    }
    await form.getByRole('button', save).click();
    await form.getByRole('button', { name: '重读最新版本', exact: true }).click();
    await form.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
    if (!completed) {
      await expect(form.getByRole('checkbox')).not.toBeChecked();
      await expect(form.getByRole('checkbox')).toBeDisabled();
      await expect(form.getByRole('textbox', { name: '环节名称', exact: true }).first()).toHaveValue('我的链路草稿');
    }
    if (completed) {
      await expect(form.getByRole('textbox', { name: '环节名称', exact: true }).first()).toHaveValue('最新资格申报');
      await expect(form.getByRole('textbox', { name: '环节名称', exact: true }).first()).toBeDisabled();
    }
    await form.getByRole('button', { name: '上一步', exact: true }).click();
    if (completed) {
      await expect(form.getByRole('textbox', { name: '组合表达式', exact: true })).toHaveValue('1');
      await expect(form.getByRole('textbox', { name: '组合表达式', exact: true })).toBeDisabled();
    }
    await form.getByRole('button', { name: '上一步', exact: true }).click();
    await expect(field(form, '评定生效日期')).toContainText('2026-11-30');
    await expect(field(form, '评定生效日期').locator('input')).toHaveCount(0);
    if (completed) await expect(field(form, '名称')).toContainText('服务端最新名称');
    else await expect(form.getByRole('textbox', { name: /名称$/, exact: true })).toHaveValue('我的名称草稿');
    expect(writes).toBe(1);
  });
}

test('AC-FE-F123-R2 套卷重读变为已使用，只读分值用最新值且可编辑标签保留草稿', async ({ page }) => {
  await setupR3b(page, '/survey360');
  const writes: { content?: { scales: { options: { value: number; label: string }[] }[] } }[] = [];
  const latest = {
    ...questionnaire,
    status: 'used',
    revision: 3,
    scales: [{ ...questionnaire.scales[0], options: [{ key: 'yes', label: '服务端标签', value: 7 }] }],
  };
  await page.route(`**/survey360/questionnaires/${id}`, (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: writes.length ? latest : questionnaire });
    writes.push(route.request().postDataJSON());
    return writes.length === 1
      ? route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT' } } })
      : route.fulfill({ json: { ...latest, revision: 4 } });
  });
  await page.getByRole('tab', { name: '套卷', exact: true }).click();
  await page.getByRole('button', { name: questionnaire.name, exact: true }).click();
  await page.getByRole('button', edit).click();
  const form = page.getByRole('dialog', { name: '编辑', exact: true });
  await form.getByRole('spinbutton', { name: /^分值/ }).fill('9');
  await form.getByRole('textbox', { name: '选项文字', exact: true }).fill('我的选项草稿');
  await form.getByRole('button', save).click();
  await form.getByRole('button', { name: '重读最新版本', exact: true }).click();
  await form.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
  await expect(form.getByRole('spinbutton', { name: /^分值/ })).toHaveValue('7');
  await expect(form.getByRole('spinbutton', { name: /^分值/ })).toBeDisabled();
  await expect(form.getByRole('textbox', { name: '选项文字', exact: true })).toHaveValue('我的选项草稿');
  await form.getByRole('button', save).click();
  await expect(form).toHaveCount(0);
  expect(writes[1]?.content?.scales[0]?.options[0]).toMatchObject({ value: 7, label: '我的选项草稿' });
});

test('AC-FE-F123-R2 已使用套卷只改名称，不把只读投影误判为内容修改', async ({ page }) => {
  await setupR3b(page, '/survey360');
  const writes: unknown[] = [];
  const original = { ...questionnaire, status: 'used' };
  await page.route(`**/survey360/questionnaires/${id}`, (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: original });
    writes.push(route.request().postDataJSON());
    return route.fulfill({ json: { ...original, revision: 3 } });
  });
  await page.getByRole('tab', { name: '套卷', exact: true }).click();
  await page.getByRole('button', { name: questionnaire.name, exact: true }).click();
  await page.getByRole('button', edit).click();
  const form = page.getByRole('dialog', { name: '编辑', exact: true });
  await field(form, '名称').getByRole('textbox').fill('只改名称');
  await form.getByRole('button', save).click();
  await expect(form).toHaveCount(0);
  expect(writes).toEqual([{ name: '只改名称' }]);
});
