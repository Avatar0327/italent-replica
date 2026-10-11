/** 项目与四类关系的完整视图；关系随项目 revision 整组替换（设计 §2.4）。 */
import {
  and,
  asc,
  eq,
  talentReviewProjects as P,
  talentReviewProjectSharedOrgs as S,
  talentReviewProjectExcludedCategories as E,
  talentReviewProjectMatrices as M,
  talentReviewProjectCalibrationFields as C,
  type Tx,
} from '@italent/db';
import type { ProjectPatch } from './project-input.js';

export const projectWhere = (tenantId: string, id: string) => and(eq(P.tenantId, tenantId), eq(P.id, id));
export async function projectHeader(tx: Tx, tenantId: string, id: string) {
  const [row] = await tx.select().from(P).where(projectWhere(tenantId, id)).for('share');
  return row;
}
export type ProjectHeader = NonNullable<Awaited<ReturnType<typeof projectHeader>>>;
export async function loadProject(tx: Tx, tenantId: string, id: string) {
  const header = await projectHeader(tx, tenantId, id);
  if (!header) return undefined;
  const { tenantId: _tenant, updatedBy: _actor, ...view } = header;
  const shared = await tx
    .select({ orgId: S.orgId })
    .from(S)
    .where(and(eq(S.tenantId, tenantId), eq(S.projectId, id)))
    .orderBy(asc(S.orgId));
  const excluded = await tx
    .select({ categoryId: E.categoryId })
    .from(E)
    .where(and(eq(E.tenantId, tenantId), eq(E.projectId, id)))
    .orderBy(asc(E.categoryId));
  const matrices = await tx
    .select({ matrixId: M.matrixId, ratioGroupId: M.ratioGroupId, sortNo: M.sortNo })
    .from(M)
    .where(and(eq(M.tenantId, tenantId), eq(M.projectId, id)))
    .orderBy(asc(M.sortNo), asc(M.matrixId));
  const calibrationFields = await tx
    .select({ fieldId: C.fieldId, required: C.required })
    .from(C)
    .where(and(eq(C.tenantId, tenantId), eq(C.projectId, id)))
    .orderBy(asc(C.fieldId));
  return {
    ...view,
    sharedOrgIds: shared.map((x) => x.orgId),
    excludedCategoryIds: excluded.map((x) => x.categoryId),
    matrices,
    calibrationFields,
  };
}
export type ProjectView = NonNullable<Awaited<ReturnType<typeof loadProject>>>;
export function splitProject(input: ProjectPatch) {
  const { sharedOrgIds, excludedCategoryIds, matrices, calibrationFields, ...header } = input;
  return { header, sharedOrgIds, excludedCategoryIds, matrices, calibrationFields };
}
export async function writeProjectRelations(tx: Tx, tenantId: string, id: string, input: ProjectPatch) {
  const base = { tenantId, projectId: id };
  if (input.sharedOrgIds !== undefined) {
    await tx.delete(S).where(and(eq(S.tenantId, tenantId), eq(S.projectId, id)));
    if (input.sharedOrgIds.length) await tx.insert(S).values(input.sharedOrgIds.map((orgId) => ({ ...base, orgId })));
  }
  if (input.excludedCategoryIds !== undefined) {
    await tx.delete(E).where(and(eq(E.tenantId, tenantId), eq(E.projectId, id)));
    if (input.excludedCategoryIds.length)
      await tx.insert(E).values(input.excludedCategoryIds.map((categoryId) => ({ ...base, categoryId })));
  }
  if (input.matrices !== undefined) {
    await tx.delete(M).where(and(eq(M.tenantId, tenantId), eq(M.projectId, id)));
    if (input.matrices.length)
      await tx.insert(M).values(
        input.matrices.map((x, index) => ({
          ...base,
          ...x,
          ratioGroupId: x.ratioGroupId ?? null,
          sortNo: x.sortNo ?? index,
        })),
      );
  }
  if (input.calibrationFields !== undefined) {
    await tx.delete(C).where(and(eq(C.tenantId, tenantId), eq(C.projectId, id)));
    if (input.calibrationFields.length)
      await tx.insert(C).values(input.calibrationFields.map((x) => ({ ...base, ...x })));
  }
}
