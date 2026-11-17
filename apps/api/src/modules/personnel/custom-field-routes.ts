// F-474-6c 第 2 轮：人员页读取自定义字段定义的业务侧只读目录（P2-2）。
// 准入 = 人员对象查看权；裁剪与最小字段由 custom-field-directory.ts 统一处理，配置接口的准入不放宽。
import type { Hono } from 'hono';
import { PERSONNEL_OBJECT } from '@italent/domain';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { access } from './access.js';
import { listVisibleCustomFields } from './custom-field-directory.js';
import { safe } from './http.js';

export const CUSTOM_FIELD_DEFINITIONS_PATH = '/api/tenant/personnel/custom-field-definitions';

export function registerCustomFieldRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(CUSTOM_FIELD_DEFINITIONS_PATH, (c) =>
    safe(async () => {
      const ctx = await access(c, deps, PERSONNEL_OBJECT, 'view', {}, undefined, 0, 'list');
      const items = await listVisibleCustomFields(deps, ctx, { objectType: 'personnel', objectCode: PERSONNEL_OBJECT });
      return c.json({ items });
    }),
  );
}
