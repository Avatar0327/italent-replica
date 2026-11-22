import { AppError } from '../../errors.js';
import type { BusinessAdapter } from '../approval/adapters.js';

// 设计 §4.1。16a-2b 接入真实业务单前，配置字典和草稿均不产生审批实例。
async function unavailable(): Promise<never> {
  throw new AppError('CONFLICT', '入职前信息采集审批尚未接通', { reason: 'ENTRY_INFO_COLLECTION_UNAVAILABLE' });
}

export const entryInfoCollectionAdapter: BusinessAdapter = {
  lock: unavailable,
  snapshot: unavailable,
  approved: unavailable,
  rejected: unavailable,
  disapproved: unavailable,
  withdrawn: unavailable,
  resubmit: unavailable,
  edit: unavailable,
};
