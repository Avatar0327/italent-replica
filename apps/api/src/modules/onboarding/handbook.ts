import { and, asc, eq, sql, onboardingHandbooks as handbooks, type OnboardingHandbook, type Tx } from '@italent/db';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { requireNew } from '../job/context.js';
import { checkHandbook, type HandbookCreateInput, type HandbookPatchInput } from './welcome-input.js';
import { renderHandbookPreview, type PreviewSamples } from './welcome-preview.js';
import type { SettingsContext } from './welcome-letters.js';

interface HandbookQuery {
  readonly enabled?: boolean | undefined;
  readonly archived: boolean;
  readonly limit: number;
  readonly offset: number;
}

const statusOf = (row: OnboardingHandbook) => (row.archivedAt ? 'archived' : row.enabled ? 'enabled' : 'disabled');

export function handbookView(row: OnboardingHandbook) {
  const { id, name, title, blocks, enabled, revision } = row;
  return { id, name, title, blocks, enabled, status: statusOf(row), revision };
}

export function listHandbooks(tx: Tx, tenantId: string, query: HandbookQuery) {
  return tx
    .select()
    .from(handbooks)
    .where(
      and(
        eq(handbooks.tenantId, tenantId),
        query.archived ? undefined : sql`${handbooks.archivedAt} IS NULL`,
        query.enabled === undefined ? undefined : eq(handbooks.enabled, query.enabled),
      ),
    )
    .orderBy(asc(handbooks.name), asc(handbooks.id))
    .limit(query.limit)
    .offset(query.offset);
}

export async function readHandbook(tx: Tx, tenantId: string, id: string, lock = false) {
  const query = tx
    .select()
    .from(handbooks)
    .where(and(eq(handbooks.tenantId, tenantId), eq(handbooks.id, id)));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw new AppError('NOT_FOUND', '入职手册不存在');
  return row;
}

async function auditHandbook(
  tx: Tx,
  ctx: SettingsContext,
  action: 'create' | 'update' | 'archive',
  before: OnboardingHandbook | null,
  after: OnboardingHandbook,
) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action: `onboarding.handbook.${action}`,
    objectType: 'onboarding-handbook',
    objectId: after.id,
    before: before && { handbooks: handbookView(before) },
    after: { handbooks: handbookView(after) },
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
}

const receipt = (row: OnboardingHandbook) => ({ id: row.id, revision: row.revision, status: statusOf(row) });

export async function createHandbook(tx: Tx, ctx: SettingsContext, input: HandbookCreateInput) {
  requireNew(ctx);
  checkHandbook(input.title, input.blocks);
  const [row] = await tx
    .insert(handbooks)
    .values({
      tenantId: ctx.tenantId,
      name: input.name,
      title: input.title,
      blocks: input.blocks,
      enabled: input.enabled ?? false,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .returning();
  await auditHandbook(tx, ctx, 'create', null, row!);
  return receipt(row!);
}

async function lockAtRevision(tx: Tx, ctx: SettingsContext, id: string) {
  const row = await readHandbook(tx, ctx.tenantId, id, true);
  if (ctx.expectedRevision !== row.revision) throw new AppError('REVISION_CONFLICT', '入职手册已变更，请刷新后重提');
  if (row.archivedAt) throw new AppError('CONFLICT', '入职手册已归档', { reason: 'HANDBOOK_ARCHIVED' });
  return row;
}

async function saveHandbook(
  tx: Tx,
  ctx: SettingsContext,
  before: OnboardingHandbook,
  set: Partial<typeof handbooks.$inferInsert>,
) {
  const [row] = await tx
    .update(handbooks)
    .set({ ...set, revision: before.revision + 1, updatedBy: ctx.userId, updatedAt: ctx.now })
    .where(and(eq(handbooks.tenantId, ctx.tenantId), eq(handbooks.id, before.id)))
    .returning();
  return row!;
}

export async function updateHandbook(tx: Tx, ctx: SettingsContext, id: string, input: HandbookPatchInput) {
  const before = await lockAtRevision(tx, ctx, id);
  const title = input.title ?? before.title;
  const blocks = input.blocks ?? before.blocks;
  checkHandbook(title, blocks);
  const row = await saveHandbook(tx, ctx, before, { name: input.name, title, blocks, enabled: input.enabled });
  await auditHandbook(tx, ctx, 'update', before, row);
  return receipt(row);
}

/** DEC-983：DELETE 即归档；归档同时停用。 */
export async function archiveHandbook(tx: Tx, ctx: SettingsContext, id: string) {
  const before = await lockAtRevision(tx, ctx, id);
  const row = await saveHandbook(tx, ctx, before, { enabled: false, archivedAt: ctx.now });
  await auditHandbook(tx, ctx, 'archive', before, row);
  return receipt(row);
}

export async function previewHandbook(tx: Tx, tenantId: string, id: string, samples: PreviewSamples) {
  return renderHandbookPreview(await readHandbook(tx, tenantId, id), samples);
}
