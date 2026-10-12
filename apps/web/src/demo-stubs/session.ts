import { initialTenantId } from '../demo/tenant.js';
import type { Session } from '../foundation/Session.js';
import { ui } from '../foundation/messages.js';

/** DEC-456：缺少当前租户资料接口；只在本地演示中使用合成名称和演示种子的租户时区。 */
export function demoSession(): Session {
  const match = /(?:^|;\s*)italent_demo_user=([^;]*)/.exec(document.cookie);
  return {
    tenantId: initialTenantId(),
    identityKey: match ? decodeURIComponent(match[1]!) : '',
    tenantName: ui.demo,
    timezone: 'Asia/Shanghai',
    displayName: ui.identity,
    source: 'demo',
  };
}
