import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('缺少 #root 挂载点');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// F-025 本地演示：只在开发模式加载“切换演示身份”工具条；生产构建里此分支与组件整体被裁掉
if (import.meta.env.DEV) {
  void import('./demo/mount.js').then(({ mountDemoIdentitySwitcher }) => mountDemoIdentitySwitcher());
}
