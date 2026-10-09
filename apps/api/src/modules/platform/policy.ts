/**
 * 平台运营层路由的现状声明（F-039 PR-A；附录 A「/api/platform」7 条 + DEC-289③ 标准身份回补 1 条）。
 * 全部只认平台运营身份（platformContext），无字段目录；写路由是平台命令（Idempotency-Key + If-Match，platform.ledger）。
 */
import { defineTable } from '../../route-policy/index.js';
import { NOT_FOUND, none, platform, write } from '../../route-policy/presets.js';

const platformCommand = write(none('平台 DTO，无字段目录'), 'platform.ledger', none('平台对象无范围'));
/** `tenantParam`：tenantId 非 UUID → 404 NOT_FOUND「租户不存在」。 */
const byTenant = { invalidId: NOT_FOUND };

export const PLATFORM_POLICIES = defineTable('platform', {
  'POST /api/platform/users': platform({ write: platformCommand }),
  'POST /api/platform/tenants': platform({ write: platformCommand }),
  // DEC-199：平台命令失败的受限通道，对象编号打码
  'GET /api/platform/command-failures': platform(),
  'GET /api/platform/tenants/:tenantId': platform(byTenant),
  'POST /api/platform/tenants/:tenantId/status': platform({ ...byTenant, write: platformCommand }),
  // DEC-289③：存量租户回补开通后新增的标准身份；请求体须为空对象，只补缺失编码（平台命令台账）
  'POST /api/platform/tenants/:tenantId/standard-profiles/backfill': platform({ ...byTenant, write: platformCommand }),
  'GET /api/platform/tenants/:tenantId/licenses': platform(byTenant),
  // licenseType 不合法另报 400 VALIDATION_FAILED（不是 invalidId）
  'PUT /api/platform/tenants/:tenantId/licenses/:licenseType': platform({ ...byTenant, write: platformCommand }),
});
