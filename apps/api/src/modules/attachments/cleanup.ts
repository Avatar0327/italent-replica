/** F-479 S3 过期清理（设计 §2.5）。桩：先让验收测试在行为断言上变红，实现见下一次提交。 */
import type { Db } from '@italent/db';
import type { AttachmentBlobStore } from './blob-store.js';

export interface CleanupInput {
  readonly db: Db;
  readonly clock: () => Date;
  readonly tenantId?: string;
  readonly store?: AttachmentBlobStore;
  readonly limit?: number;
}
export interface CleanupOutcome {
  readonly fileId: string;
  readonly kind: 'expire' | 'purge';
  readonly state: 'succeeded' | 'failed';
  readonly error?: string;
}
export interface CleanupRun {
  readonly tenantId: string;
  readonly outcomes: readonly CleanupOutcome[];
}

export async function runAttachmentCleanup(_input: CleanupInput): Promise<{ runs: readonly CleanupRun[] }> {
  return { runs: [] };
}
