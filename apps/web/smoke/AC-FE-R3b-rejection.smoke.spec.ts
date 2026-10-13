import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { id, setupR3b } from './r3b-fixtures.js';

test.setTimeout(90_000);
const nextPerson = '40000000-0000-4000-8000-000000000002';
const saveButton = { name: /保\s*存/, exact: true };

async function choose(page: Page, form: Locator, label: string, candidate: string) {
  const item = form.locator('.ant-form-item').filter({ has: page.locator(`label[title="${label}"]`) });
  const select = item.getByRole('combobox');
  await item.locator('.ant-select-selector').click();
  const listbox = await select.getAttribute('aria-controls');
  await page
    .locator('.ant-select-dropdown')
    .filter({ has: page.locator(`[id="${listbox}"]`) })
    .locator(`.ant-select-item-option[title="${candidate}"]`)
    .click();
  await form.getByText('添加评价对象', { exact: true }).click();
}

for (const status of [409, 422]) {
  test(`AC-FE-R3b-R3-01 评价对象 ${status} 明确拒绝后保留套卷，改人发出新命令`, async ({ page }) => {
    await setupR3b(page, '/survey360');
    await page.route('**/survey360/people?*', (route) =>
      route.fulfill({
        json: {
          items: [
            { id, name: '合成已添加人员' },
            { id: nextPerson, name: '合成新人员' },
          ],
        },
      }),
    );
    const requests: { command: string; body: unknown }[] = [];
    await page.route(`**/survey360/activities/${id}/objects`, (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      requests.push({ command: request.headers()['idempotency-key']!, body: request.postDataJSON() });
      return requests.length === 1
        ? route.fulfill({
            status,
            json: {
              error: {
                code: status === 409 ? 'CONFLICT' : 'VALIDATION_FAILED',
                message: '合成拒绝：该人员已是评价对象',
                details: { reason: 'DUPLICATE' },
              },
            },
          })
        : route.fulfill({ json: { id: nextPerson, revision: 1 } });
    });
    await page.getByRole('button', { name: '合成领导力评估', exact: true }).click();
    await page.getByRole('dialog').getByRole('tab', { name: '评价关系', exact: true }).click();
    await page.getByRole('button', { name: '添加评价对象', exact: true }).click();
    const form = page.getByRole('dialog', { name: '添加评价对象', exact: true });
    await choose(page, form, '选择人员', '合成已添加人员');
    await choose(page, form, '选取套卷', '合成协作套卷');
    await form.getByRole('button', saveButton).click();
    await expect(form.getByRole('alert')).toContainText(status === 409 ? '该人员已是评价对象' : '请检查');
    await expect(form).toContainText('合成协作套卷');
    expect(requests).toHaveLength(1);
    await choose(page, form, '选择人员', '合成新人员');
    await form.getByRole('button', saveButton).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests.map((request) => request.body)).toEqual([
      { personId: id, questionnaireIds: [id] },
      { personId: nextPerson, questionnaireIds: [id] },
    ]);
    expect(requests[1]!.command).not.toBe(requests[0]!.command);
    await expect(form).toHaveCount(0);
  });

  test(`AC-FE-R3b-R3-02 活动 ${status} 明确拒绝后名称和欢迎语保留且可编辑重提`, async ({ page }) => {
    await setupR3b(page, '/survey360');
    const bodies: Record<string, unknown>[] = [];
    await page.route('**/survey360/activities', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      bodies.push(route.request().postDataJSON());
      return bodies.length === 1
        ? route.fulfill({
            status,
            json: { error: { code: status === 409 ? 'CONFLICT' : 'VALIDATION_FAILED', message: '合成活动被明确拒绝' } },
          })
        : route.fulfill({ json: { id, revision: 1 } });
    });
    await page.getByRole('button', { name: '新增活动', exact: true }).click();
    const form = page.getByRole('dialog', { name: '新增活动', exact: true });
    await form.getByLabel('名称', { exact: true }).fill('合成待修正活动');
    await form.getByLabel('欢迎语', { exact: true }).fill('合成欢迎语');
    await form.getByRole('button', saveButton).click();
    await expect(form.getByRole('alert')).toContainText(status === 409 ? '合成活动被明确拒绝' : '请检查');
    await expect(form.getByLabel('名称', { exact: true })).toHaveValue('合成待修正活动');
    await expect(form.getByLabel('欢迎语', { exact: true })).toHaveValue('合成欢迎语');
    await expect(form.getByLabel('欢迎语', { exact: true })).toBeEditable();
    await form.getByLabel('名称', { exact: true }).fill('合成已修正活动');
    await form.getByRole('button', saveButton).click();
    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies[1]).toMatchObject({ name: '合成已修正活动', welcome: '合成欢迎语' });
    await expect(form).toHaveCount(0);
  });
}
