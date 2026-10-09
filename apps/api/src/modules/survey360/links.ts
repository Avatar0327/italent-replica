/**
 * 作答 / 确认链接（E3-R20）：一个评价者在一个活动内只有一个作答链接；确认链接按确认单一份。
 * 令牌只在邀请邮件（outbox）里出现一次，库里只存 SHA-256 摘要；请求经 X-Survey360-Token 头传递，
 * 不进入路径、失败命令审计与访问日志。邮件只写 outbox（pending），不接真实发送（派发单）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, survey360Links, survey360Outbox, type Tx } from '@italent/db';
import type { PersonRow } from './people.js';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface LinkContext {
  readonly tenantId: string;
  readonly commandId: string;
}

async function issue(
  tx: Tx,
  ctx: LinkContext,
  input: {
    kind: 'answer' | 'confirm';
    activityId: string;
    person: PersonRow;
    confirmationId?: string;
    eventType: string;
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  await tx.insert(survey360Links).values({
    tenantId: ctx.tenantId,
    activityId: input.activityId,
    kind: input.kind,
    personId: input.person.id,
    confirmationId: input.confirmationId ?? null,
    tokenHash: hashToken(token),
  });
  await tx.insert(survey360Outbox).values({
    tenantId: ctx.tenantId,
    eventType: input.eventType,
    objectId: input.person.id,
    commandId: ctx.commandId,
    payload: {
      channel: 'email',
      activityId: input.activityId,
      personId: input.person.id,
      to: input.person.email,
      name: input.person.name,
      token,
      ...input.extra,
    },
  });
}

/** 作答链接：该评价者在本活动已有有效链接则不重复发放（一个评价者一个链接）。 */
export async function ensureAnswerLink(tx: Tx, ctx: LinkContext, activityId: string, person: PersonRow) {
  const [existing] = await tx
    .select({ id: survey360Links.id })
    .from(survey360Links)
    .where(
      and(
        eq(survey360Links.activityId, activityId),
        eq(survey360Links.personId, person.id),
        eq(survey360Links.kind, 'answer'),
        eq(survey360Links.revoked, false),
      ),
    );
  if (existing) return false;
  await issue(tx, ctx, { kind: 'answer', activityId, person, eventType: 'survey360.answer_invitation' });
  return true;
}

export async function issueConfirmLink(
  tx: Tx,
  ctx: LinkContext,
  activityId: string,
  confirmationId: string,
  person: PersonRow,
) {
  await issue(tx, ctx, {
    kind: 'confirm',
    activityId,
    person,
    confirmationId,
    eventType: 'survey360.confirm_invitation',
    extra: { confirmationId },
  });
}

export interface LinkRow {
  readonly id: string;
  readonly activityId: string;
  readonly kind: 'answer' | 'confirm';
  readonly personId: string;
  readonly confirmationId: string | null;
}

export async function findLink(tx: Tx, token: string): Promise<LinkRow | undefined> {
  const [row] = await tx
    .select({
      id: survey360Links.id,
      activityId: survey360Links.activityId,
      kind: survey360Links.kind,
      personId: survey360Links.personId,
      confirmationId: survey360Links.confirmationId,
    })
    .from(survey360Links)
    .where(and(eq(survey360Links.tokenHash, hashToken(token)), eq(survey360Links.revoked, false)));
  return row ? { ...row, kind: row.kind as LinkRow['kind'] } : undefined;
}
