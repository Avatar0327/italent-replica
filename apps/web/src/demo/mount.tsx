import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DemoIdentitySwitcher } from './DemoIdentitySwitcher.js';

/** 只由 main.tsx 在 import.meta.env.DEV 分支里动态加载；挂在独立节点上，不影响业务页面。 */
export function mountDemoIdentitySwitcher(): void {
  const host = document.createElement('div');
  host.id = 'demo-identity';
  document.body.prepend(host);
  createRoot(host).render(
    <StrictMode>
      <DemoIdentitySwitcher />
    </StrictMode>,
  );
}
