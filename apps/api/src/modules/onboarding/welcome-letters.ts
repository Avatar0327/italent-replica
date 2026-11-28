import {
  and,
  asc,
  eq,
  sql,
  ne,
  onboardingWelcomeLetters as letters,
  pgErrorCode,
  type OnboardingWelcomeLetter,
  type Tx,
} from '@italent/db';
import { asUuid, advisoryLock } from '../../advisory-lock.js';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { requireNew } from '../job/context.js';
import { welcomeVariables, type WelcomeCreateInput, type WelcomePatchInput } from './welcome-input.js';
import { renderWelcomePreview, type PreviewSamples } from './welcome-preview.js';

export interface SettingsContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly now: Date;
  readonly commandId: string;
  readonly expectedRevision: number;
}

interface LetterQuery {
  readonly enabled?: boolean | undefined;
  readonly archived: boolean;
  readonly limit: number;
  readonly offset: number;
}

type LetterStatus = 'enabled' | 'disabled' | 'archived';
const statusOf = (row: OnboardingWelcomeLetter): LetterStatus =>
  row.archivedAt ? 'archived' : row.enabled ? 'enabled' : 'disabled';

export function welcomeLetterView(row: OnboardingWelcomeLetter) {
  const { id, name, title, body, variables, enabled, revision } = row;
  return { id, name, title, body, variables, enabled, status: statusOf(row), revision };
}

export function listWelcomeLetters(tx: Tx, tenantId: string, query: LetterQuery) {
  return tx
    .select()
    .from(letters)
    .where(
      and(
        eq(letters.tenantId, tenantId),
        query.archived ? undefined : sql`${letters.archivedAt} IS NULL`,
        query.enabled === undefined ? undefined : eq(letters.enabled, query.enabled),
      ),
    )
    .orderBy(asc(letters.name), asc(letters.id))
    .limit(query.limit)
    .offset(query.offset);
}

export async function readWelcomeLetter(tx: Tx, tenantId: string, id: string, lock = false) {
  const query = tx
    .select()
    .from(letters)
    .where(and(eq(letters.tenantId, tenantId), eq(letters.id, id)));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw new AppError('NOT_FOUND', '欢迎信模板不存在');
  return row;
}

async function auditLetter(
  tx: Tx,
  ctx: SettingsContext,
  action: 'create' | 'update' | 'archive',
  before: OnboardingWelcomeLetter | null,
  after: OnboardingWelcomeLetter,
) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action: `onboarding.welcome_letter.${action}`,
    objectType: 'onboarding-welcome-letter',
    objectId: after.id,
    before: before && { welcomeLetters: welcomeLetterView(before) },
    after: { welcomeLetters: welcomeLetterView(after) },
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
}

const receipt = (row: OnboardingWelcomeLetter) => ({ id: row.id, revision: row.revision, status: statusOf(row) });

/** 每租户至多一份启用中的发送模板（§3.2）；启用前在租户锁下复核，唯一索引兜底并发。 */
async function requireNoOtherEnabled(tx: Tx, tenantId: string, exceptId: string | null) {
  await advisoryLock(tx, 'onboarding:welcome:', asUuid(tenantId));
  const [other] = await tx
    .select({ id: letters.id })
    .from(letters)
    .where(
      and(eq(letters.tenantId, tenantId), eq(letters.enabled, true), exceptId ? ne(letters.id, exceptId) : undefined),
    )
    .limit(1);
  if (other) throw enabledTaken();
}

const enabledTaken = () =>
  new AppError('CONFLICT', '已有启用中的欢迎信模板，请先停用后再启用', { reason: 'WELCOME_ENABLED_EXISTS' });

export async function createWelcomeLetter(tx: Tx, ctx: SettingsContext, input: WelcomeCreateInput) {
  requireNew(ctx);
  const enabled = input.enabled ?? false;
  if (enabled) await requireNoOtherEnabled(tx, ctx.tenantId, null);
  const [row] = await tx
    .insert(letters)
    .values({
      tenantId: ctx.tenantId,
      name: input.name,
      title: input.title,
      body: input.body,
      variables: welcomeVariables(input),
      enabled,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .returning();
  await auditLetter(tx, ctx, 'create', null, row!);
  return receipt(row!);
}

async function lockAtRevision(tx: Tx, ctx: SettingsContext, id: string) {
  const row = await readWelcomeLetter(tx, ctx.tenantId, id, true);
  if (ctx.expectedRevision !== row.revision) throw new AppError('REVISION_CONFLICT', '欢迎信模板已变更，请刷新后重提');
  if (row.archivedAt) throw new AppError('CONFLICT', '欢迎信模板已归档', { reason: 'WELCOME_ARCHIVED' });
  return row;
}

async function saveLetter(
  tx: Tx,
  ctx: SettingsContext,
  before: OnboardingWelcomeLetter,
  set: Partial<typeof letters.$inferInsert>,
) {
  try {
    const [row] = await tx
      .update(letters)
      .set({ ...set, revision: before.revision + 1, updatedBy: ctx.userId, updatedAt: ctx.now })
      .where(and(eq(letters.tenantId, ctx.tenantId), eq(letters.id, before.id)))
      .returning();
    return row!;
  } catch (error) {
    if (pgErrorCode(error) === '23505') throw enabledTaken();
    throw error;
  }
}

export async function updateWelcomeLetter(tx: Tx, ctx: SettingsContext, id: string, input: WelcomePatchInput) {
  const before = await lockAtRevision(tx, ctx, id);
  const next = { title: input.title ?? before.title, body: input.body ?? before.body };
  const enabled = input.enabled ?? before.enabled;
  if (enabled && !before.enabled) await requireNoOtherEnabled(tx, ctx.tenantId, id);
  const row = await saveLetter(tx, ctx, before, {
    name: input.name,
    ...next,
    variables: welcomeVariables(next),
    enabled,
  });
  await auditLetter(tx, ctx, 'update', before, row);
  return receipt(row);
}

/** DEC-983：DELETE 即归档。归档同时停用，已入队的任务按当时模板状态在消费时复核。 */
export async function archiveWelcomeLetter(tx: Tx, ctx: SettingsContext, id: string) {
  const before = await lockAtRevision(tx, ctx, id);
  const row = await saveLetter(tx, ctx, before, { enabled: false, archivedAt: ctx.now });
  await auditLetter(tx, ctx, 'archive', before, row);
  return receipt(row);
}

export async function previewWelcomeLetter(tx: Tx, tenantId: string, id: string, samples: PreviewSamples) {
  return renderWelcomePreview(await readWelcomeLetter(tx, tenantId, id), samples);
}
