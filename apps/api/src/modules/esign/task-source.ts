import type { ESignSourceKind, EsignScene } from '@italent/domain';
import type { SignTask } from './sign-events.js';

export type SignScene = EsignScene | ESignSourceKind;

export type TaskSource =
  | { readonly scene: 'transfer'; readonly businessId: string }
  | { readonly scene: 'entry'; readonly businessId: string; readonly sourceRevision: number }
  | { readonly scene: 'offer'; readonly offerId: string; readonly sourceRevision: number };

export function signTaskSourceAudit(task: Pick<SignTask, 'scene' | 'businessId' | 'offerId' | 'sourceRevision'>) {
  const source = task.scene === 'offer' ? { offerId: task.offerId } : { businessId: task.businessId };
  return {
    scene: task.scene,
    ...source,
    ...(task.sourceRevision === null ? {} : { sourceRevision: task.sourceRevision }),
  };
}
