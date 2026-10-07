/**
 * 开发模式预填演示租户（F-025）：切换演示身份时写入 Cookie，各页面的租户输入以它为初值。
 * 生产构建里 import.meta.env.DEV 恒为 false，函数体被裁剪为直接返回空串（AC-DEMO-F025 构建产物检查）。
 */
export function initialTenantId(): string {
  if (!import.meta.env.DEV || typeof document === 'undefined') return '';
  const match = /(?:^|;\s*)italent_demo_tenant=([^;]*)/.exec(document.cookie);
  return match ? decodeURIComponent(match[1]!) : '';
}
