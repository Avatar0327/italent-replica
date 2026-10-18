/**
 * Offer 超编弱控（34 OF-R10，AC-OF-13，DEC-600）：发送 Offer 和管理员转为已接受时判断录用部门是否超编，超编先返回
 * 409 CONFIRMATION_REQUIRED，前端带 confirmed 标记重提；候选人答复不校验（R2e7 / F-183）。
 * 判定把“这位候选人按计划入职日入职”当作一次调入，复用编制单一判定入口（employmentEstablishmentAssessment）：
 * 没有人员，用临时 ID 投影，不落库。强控超编这里同样要求确认，强控的拒绝落在同步待入职（BE-14b2）。
 */
import { randomUUID } from 'node:crypto';
import type { Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { employmentEstablishmentAssessment } from '../establishment/employment-check.js';
import type { OfferContext } from './context.js';
import type { OfferRow } from './service.js';

export async function requireQuotaConfirmed(tx: Tx, ctx: OfferContext, offer: OfferRow, confirmed: boolean) {
  if (confirmed || !offer.departmentId || !offer.plannedEntryDate) return;
  const assessment = await employmentEstablishmentAssessment(
    tx,
    {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      timezone: ctx.timezone,
      now: ctx.now,
      commandId: ctx.commandId,
      expectedRevision: ctx.expectedRevision,
    },
    {
      businessId: randomUUID(),
      employeeId: randomUUID(),
      kind: 'transfer',
      effectiveDate: offer.plannedEntryDate,
      departmentId: offer.departmentId,
      positionId: offer.positionId,
      fields: {
        departmentId: offer.departmentId,
        positionId: offer.positionId,
        postId: offer.postId,
        levelId: offer.levelId,
        employType: offer.offerType === 'intern' ? 'intern' : 'internal',
      },
    },
  );
  if (assessment === 'none') return;
  throw new AppError('CONFLICT', '已超出设定编制，是否继续操作？', {
    reason: 'CONFIRMATION_REQUIRED',
    level: assessment,
    warnings: [{ departmentId: offer.departmentId, reason: 'ESTABLISHMENT_EXCEEDED' }],
  });
}
