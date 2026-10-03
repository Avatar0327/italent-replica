import type { Tx } from '@italent/db';
import type { PersonnelContext, Row } from './store.js';
import type { SubsetKind } from '@italent/domain';
import { saveSubset } from './subsets.js';

/** DEC-087 trusted ingestion port. Public routes never accept provenance fields. */
export function saveInformationCollection(
  tx: Tx,
  ctx: PersonnelContext,
  employeeId: string,
  kind: SubsetKind,
  sourceId: string,
  fields: Row,
) {
  return saveSubset(tx, ctx, employeeId, kind, fields, undefined, false, { type: 'info_collection', id: sourceId });
}

/** 22 §2/3：绩效与学习未纳入首版；同步方须携带外部业务 ID 与可信事务，不开放越权公共接口。 */
export interface LearningPersonnelSync {
  training(tx: Tx, ctx: PersonnelContext, employeeId: string, activityNumber: string, fields: Row): Promise<void>;
  certificate(
    tx: Tx,
    ctx: PersonnelContext,
    employeeId: string,
    learningCertificateId: string,
    fields: Row,
  ): Promise<void>;
}
export interface AppraisalPersonnelSync {
  appraisal(tx: Tx, ctx: PersonnelContext, employeeId: string, performanceId: string, fields: Row): Promise<void>;
}
