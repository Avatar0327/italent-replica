import type { Tx } from '@italent/db';
import type { PersonnelContext, Row } from './store.js';

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
