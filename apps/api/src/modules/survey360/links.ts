/**
 * 作答 / 确认链接（E3-R20）：一个评价者在一个活动内只有一个作答链接；确认链接按确认单一份。
 * 令牌只在邀请邮件（outbox）里出现一次，库里只存 SHA-256 摘要；请求经 X-Survey360-Token 头传递，
 * 不进入路径、失败命令审计与访问日志。邮件只写 outbox（pending），不接真实发送（派发单）。
 * PR-B：重发邮件邀请时轮换令牌（旧链接作废、发新链接），同一时刻一个评价者仍只有一个有效链接；
 * 最后发送时间（last_sent_at）邮件与站内待办都计入（`25` §10.2 更正）。
 * F-076：令牌（及通用网址的序列号、密码）只以 AES-GCM 密文（payload.sealed）进入 outbox，payload 带 linkId 供发送方
 * 抑制被重发作废的旧邀请；作答链接在 SURVEY360_PORTAL_CREDENTIALS 打开时进入 pending，由维护任务异步发放凭据
 * （命令事务内不做 KDF，设计 §2.5）。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql, survey360Links, survey360Outbox, type Tx } from '@italent/db';
import { credentialConfig } from './credential-config.js';
import type { PersonRow } from './people.js';
import { recordSecurityEvent } from './security-events.js';
import { hasTask } from './tasks.js';
import { sealJson } from './secret-box.js';

/** 只供测试制造交错（检查剩余关系之后、作废链接之前停一下）；生产不设。 */
export const linkHooks: { afterTaskCheck?: (() => void | Promise<void>) | undefined } = {};

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface LinkContext {
  readonly tenantId: string;
  readonly commandId: string;
  readonly now: Date;
}

export interface IssuedLink {
  readonly linkId: string;
  /** 作答链接进入了凭据待发放（pending）；确认链接与开关关闭时为 false。 */
  readonly credentialPending: boolean;
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
): Promise<IssuedLink> {
  const config = credentialConfig();
  const credentialPending = input.kind === 'answer' && config.portalCredentials;
  const token = randomBytes(32).toString('base64url');
  const linkId = randomUUID();
  const outboxId = randomUUID();
  await tx.insert(survey360Links).values({
    id: linkId,
    tenantId: ctx.tenantId,
    activityId: input.activityId,
    kind: input.kind,
    personId: input.person.id,
    confirmationId: input.confirmationId ?? null,
    tokenHash: hashToken(token),
    lastSentAt: ctx.now,
    credentialState: credentialPending ? 'pending' : 'none',
  });
  await tx.insert(survey360Outbox).values({
    id: outboxId,
    tenantId: ctx.tenantId,
    eventType: input.eventType,
    objectId: input.person.id,
    commandId: ctx.commandId,
    // 凭据待发放期间不发送；维护任务写入序列号与密码后改为 pending（设计 §2.5）
    state: credentialPending ? 'awaiting_credential' : 'pending',
    payload: {
      channel: 'email',
      activityId: input.activityId,
      personId: input.person.id,
      to: input.person.email,
      name: input.person.name,
      linkId,
      sealed: sealJson(config, { token }, { tenantId: ctx.tenantId, outboxId, eventType: input.eventType }),
      ...input.extra,
    },
  });
  return { linkId, credentialPending };
}

/** 作答链接：该评价者在本活动已有有效链接则不重复发放（一个评价者一个链接）；已有时返回 undefined。 */
export async function ensureAnswerLink(
  tx: Tx,
  ctx: LinkContext,
  activityId: string,
  person: PersonRow,
): Promise<IssuedLink | undefined> {
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
  if (existing) return undefined;
  return issue(tx, ctx, { kind: 'answer', activityId, person, eventType: 'survey360.answer_invitation' });
}

/**
 * 重发邮件邀请（PR-B）：作废该评价者当前的作答链接、发新链接与邀请邮件；答卷挂在评价关系上，不受链接轮换影响。
 * F-076：凭据与个人链接同发、同换、同作废（DEC-401 Q4）——旧行上的凭据与会话随链接作废失效，新行重走 pending；
 * 开关打开时每个评价者写一条 credential_reissued 安全事件（同事务）。
 */
export async function reissueAnswerLink(
  tx: Tx,
  ctx: LinkContext,
  activityId: string,
  person: PersonRow,
): Promise<IssuedLink> {
  const [old] = await tx
    .update(survey360Links)
    .set({ revoked: true })
    .where(
      and(
        eq(survey360Links.activityId, activityId),
        eq(survey360Links.personId, person.id),
        eq(survey360Links.kind, 'answer'),
        eq(survey360Links.revoked, false),
      ),
    )
    .returning({ id: survey360Links.id });
  const issued = await issue(tx, ctx, { kind: 'answer', activityId, person, eventType: 'survey360.answer_invitation' });
  if (issued.credentialPending) {
    await recordSecurityEvent(tx, {
      tenantId: ctx.tenantId,
      kind: 'credential_reissued',
      occurredAt: ctx.now,
      linkId: issued.linkId,
      ...(old ? { oldLinkId: old.id } : {}),
      activityId,
    });
  }
  return issued;
}

/**
 * 评价者在本活动已没有任何有效评价关系时，作废其作答链接（DEC-409③ / DEC-401⑧）：链接上的凭据与全部会话随之失效
 * （会话与登录都要求链接未作废），登录提示与凭据错误完全相同。调用方须在关系已标记移除之后调用。
 */
export async function revokeAnswerLinkWithoutTask(tx: Tx, activityId: string, personId: string): Promise<void> {
  if (await hasTask(tx, activityId, personId)) return;
  await linkHooks.afterTaskCheck?.();
  await tx
    .update(survey360Links)
    .set({ revoked: true })
    .where(
      and(
        eq(survey360Links.activityId, activityId),
        eq(survey360Links.personId, personId),
        eq(survey360Links.kind, 'answer'),
        eq(survey360Links.revoked, false),
      ),
    );
}

/** 站内待办发送也计入最后发送时间。 */
export async function markSent(tx: Tx, activityId: string, personIds: readonly string[], at: Date) {
  if (!personIds.length) return;
  await tx.execute(sql`UPDATE survey360_links SET last_sent_at = ${at.toISOString()}::timestamptz
    WHERE activity_id = ${activityId}::uuid AND kind = 'answer' AND NOT revoked
      AND person_id = ANY(${`{${personIds.join(',')}}`}::uuid[])`);
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
