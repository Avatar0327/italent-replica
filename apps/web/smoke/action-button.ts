import type { Locator, Page } from '@playwright/test';

/**
 * 复用 r3d1-fixtures 的加载态定位策略：antd 的 loading 图标离场后仍可能留在可访问名中。
 * 保留动作名边界，只容许 loading 前缀和汉字间空格；禁用 / 加载状态仍由调用方断言。
 */
export function actionButton(scope: Page | Locator, label: string) {
  const escaped = [...label].map((character) => character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
  return scope.getByRole('button', { name: new RegExp(`^(?:loading\\s*)?${escaped}$`) });
}
