/** F-479 S3 恢复校验（设计 §2.6）。桩：实现见下一次提交。 */
import type { Tx } from '@italent/db';

export type ManifestProblem = 'missing' | 'size_mismatch' | 'hash_mismatch';
export interface ManifestReport {
  readonly checked: number;
  readonly corrupted: readonly { readonly fileId: string; readonly problem: ManifestProblem }[];
}

export async function verifyAttachmentManifest(
  _tx: Tx,
  _tenantId: string,
  _options: { readonly now?: Date } = {},
): Promise<ManifestReport> {
  return { checked: 0, corrupted: [] };
}
