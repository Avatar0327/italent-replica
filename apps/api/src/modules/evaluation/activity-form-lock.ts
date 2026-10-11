/** B6 / EV-R5：全部引用活动参与共享锁；已发布且已有报名才禁止改评分内容。 */
import type { Tx } from '@italent/db';
import { registerFormLock } from './form-lock.js';
import { lockActivitiesForForm } from './reference-locks.js';

async function activityFormLocked(tx: Tx, tenantId: string, formId: string): Promise<boolean> {
  const rows = await lockActivitiesForForm(tx, tenantId, formId);
  return rows.some((row) => row.status === 'published' && Number(row.apply_count) > 0);
}

export function registerActivityFormLock(): void {
  registerFormLock(activityFormLocked);
}
