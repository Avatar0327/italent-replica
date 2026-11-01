/**
 * F-400（DEC-725）测试辅助：改写本租户“离职生效时终止在途流程”的勾选。
 * 走两层配置的覆盖服务（与 PUT /api/tenant/settings/:key 同一写入函数），只列要改的类型，其余沿用当前有效值。
 */
import { randomUUID } from 'node:crypto';
import { withTenant, type Db } from '@italent/db';
import { overrideSetting, readEffectiveSetting } from '../../../apps/api/src/modules/tenant-settings/service.js';

export const EXIT_TERMINATION_KEY = 'exit.termination_flow_types';

export function setExitTermination(db: Db, tenantId: string, userId: string, changes: Record<string, boolean>) {
  return withTenant(db, tenantId, async (tx) => {
    const current = await readEffectiveSetting(tx, tenantId, EXIT_TERMINATION_KEY);
    const write = {
      tenantId,
      userId,
      key: EXIT_TERMINATION_KEY,
      expectedRevision: current.revision,
      now: new Date(),
      commandId: randomUUID(),
    };
    return overrideSetting(tx, write, { ...(current.value as Record<string, boolean>), ...changes });
  });
}
