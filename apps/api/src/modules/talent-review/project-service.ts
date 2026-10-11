/** 项目状态与配置（设计 §2.4 / §3.1；DEC-353）：项目 X 锁 → revision → 业务守卫 → 写入及完整审计快照。 */
import { talentReviewProjects as P, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { recordAudit } from '../../audit/record.js';
import { auditActor } from '../../system-actor.js';
import { visible } from '../permission/module-route-access.js';
import { codeOf, notFoundMessage } from './access.js';
import { uniqueOr } from './config-kit.js';
import { checkProjectGuards, requireProjectEmpty, type ProjectAction } from './project-guards.js';
import type { ProjectInput, ProjectPatch } from './project-input.js';
import {
  checkProjectReferences,
  defaultProjectMatrices,
  resolveProjectMatrices,
  type ProjectWriteContext,
} from './project-references.js';
import { loadProject, projectWhere, splitProject, writeProjectRelations, type ProjectView } from './project-store.js';

import { requireProjectEditable } from './project-access.js';
const ended = () => new AppError('CONFLICT', '盘点项目已结束，禁止修改', { reason: 'PROJECT_ENDED' });
function checkDates(input: { periodStartDate: string; periodEndDate: string }) {
  if (input.periodStartDate > input.periodEndDate) {
    throw new AppError('VALIDATION_FAILED', '计划结束不能早于计划开始', { reason: 'PROJECT_DATE_RANGE_INVALID' });
  }
}
async function audit(
  tx: Tx,
  ctx: ProjectWriteContext,
  operation: string,
  before: ProjectView | null,
  after: ProjectView | null,
) {
  const view = (after ?? before)!;
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action: `talent-review.project.${operation}`,
    objectType: codeOf('project'),
    objectId: view.id,
    before,
    after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
    scope: { orgId: view.ownerOrgId },
  });
}
async function lockProject(tx: Tx, ctx: ProjectWriteContext, id: string) {
  const [row] = await tx.select().from(P).where(projectWhere(ctx.tenantId, id)).for('update');
  if (!row) throw new AppError('NOT_FOUND', notFoundMessage('project'));
  await requireProjectEditable(tx, ctx, ctx.scope, row);
  if (row.revision !== ctx.expectedRevision) {
    throw new AppError('REVISION_CONFLICT', '项目已变更，请刷新后显式重提', {
      expected: ctx.expectedRevision,
      actual: row.revision,
    });
  }
  return (await loadProject(tx, ctx.tenantId, id))!;
}
export async function createProject(tx: Tx, ctx: ProjectWriteContext, input: ProjectInput) {
  visible(ctx.scope, input.ownerOrgId, notFoundMessage('project'));
  checkDates(input);
  await checkProjectReferences(tx, ctx, input);
  const matrices =
    input.matrices === undefined
      ? await defaultProjectMatrices(tx, ctx.tenantId)
      : await resolveProjectMatrices(tx, ctx.tenantId, input.matrices);
  const { header } = splitProject(input);
  const [row] = await uniqueOr('PROJECT_DUPLICATE', '盘点项目', () =>
    tx
      .insert(P)
      .values({
        ...header,
        code: input.code,
        tenantId: ctx.tenantId,
        ownerId: ctx.userId,
        name: input.name,
        ownerOrgId: input.ownerOrgId,
        year: input.year,
        period: input.period,
        periodStartDate: input.periodStartDate,
        periodEndDate: input.periodEndDate,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .returning({ id: P.id }),
  );
  await writeProjectRelations(tx, ctx.tenantId, row!.id, { ...input, matrices });
  const view = (await loadProject(tx, ctx.tenantId, row!.id))!;
  await audit(tx, ctx, 'create', null, view);
  return view;
}
export async function updateProject(tx: Tx, ctx: ProjectWriteContext, id: string, input: ProjectPatch) {
  const before = await lockProject(tx, ctx, id);
  if (before.status === 'ended') throw ended();
  if (input.ownerOrgId !== undefined && input.ownerOrgId !== before.ownerOrgId) {
    visible(ctx.scope, input.ownerOrgId, notFoundMessage('project'));
  }
  checkDates({ ...before, ...input });
  await checkProjectReferences(tx, ctx, input, before);
  const { header } = splitProject(input);
  const matrices =
    input.matrices === undefined ? undefined : await resolveProjectMatrices(tx, ctx.tenantId, input.matrices);
  await tx
    .update(P)
    .set({ ...header, revision: before.revision + 1, updatedBy: ctx.userId, updatedAt: ctx.now })
    .where(projectWhere(ctx.tenantId, id));
  await writeProjectRelations(tx, ctx.tenantId, id, { ...input, matrices });
  const view = (await loadProject(tx, ctx.tenantId, id))!;
  await audit(tx, ctx, 'update', before, view);
  return view;
}
export async function transitionProject(tx: Tx, ctx: ProjectWriteContext, id: string, action: ProjectAction) {
  const before = await lockProject(tx, ctx, id);
  const allowed = {
    start: before.status === 'new',
    end: before.status !== 'ended',
    restart: before.status === 'ended',
  }[action];
  if (!allowed) throw new AppError('CONFLICT', '当前状态不能执行此操作', { reason: 'PROJECT_STATE_INVALID' });
  await checkProjectGuards(tx, ctx, action, before);
  await tx
    .update(P)
    .set({
      status: action === 'end' ? 'ended' : 'in_progress',
      endedCount: before.endedCount + (action === 'restart' ? 1 : 0),
      revision: before.revision + 1,
      updatedBy: ctx.userId,
      updatedAt: ctx.now,
    })
    .where(projectWhere(ctx.tenantId, id));
  const view = (await loadProject(tx, ctx.tenantId, id))!;
  await audit(tx, ctx, action, before, view);
  return view;
}
export async function deleteProject(tx: Tx, ctx: ProjectWriteContext, id: string) {
  const before = await lockProject(tx, ctx, id);
  await requireProjectEmpty(tx, ctx, id);
  await tx.delete(P).where(projectWhere(ctx.tenantId, id));
  await audit(tx, ctx, 'delete', before, null);
  return before;
}
