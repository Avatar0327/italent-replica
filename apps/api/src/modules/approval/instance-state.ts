import type { InstanceRow } from './store.js';

/** DEC-674：交接驳回为终态，与 DB 活动实例查询 / 唯一索引的生命周期保持一致。 */
export function isActiveInstance(instance: Pick<InstanceRow, 'status' | 'businessType'>): boolean {
  return instance.status === 'running' || (instance.status === 'returned' && instance.businessType !== 'exit_handover');
}
