/** F-479 S3 清理调度器（设计 §2.5）。桩：实现见下一次提交。 */
import type { Db } from '@italent/db';
import type { AttachmentBlobStore } from './blob-store.js';

export function startAttachmentCleanupScheduler(
  _db: Db,
  _options: {
    readonly intervalMs?: number;
    readonly clock?: () => Date;
    readonly store?: AttachmentBlobStore;
    readonly onError?: (error: unknown) => void;
  } = {},
) {
  return { async stop() {} };
}
