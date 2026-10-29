import { test, expect } from '@playwright/test';
import { actionButton } from './action-button.js';

test('AC-FE-F227 动作定位跨加载态保持唯一，保留作用域和名称边界', async ({ page }) => {
  await page.setContent(`
    <button>保存</button>
    <section aria-label="合成表单">
      <button id="save"><span>保 存</span></button>
      <button>另存并保存</button>
      <button>保存并提交</button>
      <button>保存(草稿)</button>
    </section>
  `);
  const form = page.getByRole('region', { name: '合成表单' });
  const save = actionButton(form, '保存');
  await expect(save).toHaveCount(1);
  await expect(save).toBeEnabled();
  await expect(actionButton(form, '保存(草稿)')).toHaveCount(1);
  await page.locator('#save').evaluate((element: HTMLButtonElement) => {
    element.disabled = true;
    element.insertAdjacentHTML('afterbegin', '<span role="img" aria-label="loading"></span>');
  });
  await expect(save).toHaveAccessibleName('loading保 存');
  await expect(save).toBeDisabled();
  // 模拟请求完成、图标离场动画尚未移除：可访问名仍带 loading，按钮已重新可用。
  await page.locator('#save').evaluate((element: HTMLButtonElement) => {
    element.disabled = false;
  });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toHaveCount(1);
});
