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
import { advisoryLock, asUuid } from '../../advisory-lock.js';
import { and, eq, sql, survey360Links, survey360Outbox, type Tx } from '@italent/db';
import type { ActivityRow } from './access.js';
import { rows } from './context.js';
import { credentialConfig } from './credential-config.js';
import type { PersonRow } from './people.js';
import { recordSecurityEvent } from './security-events.js';
import { hasTask } from './tasks.js';
import { sealJson } from './secret-box.js';

/** 只供测试制造交错（取得链接锁之后 / 检查剩余关系之后、作废链接之前停一下）；生产不设。 */
export const linkHooks: {
  afterLock?: (() => void | Promise<void>) | undefined;
  afterTaskCheck?: (() => void | Promise<void>) | undefined;
} = {};

/**
 * 评价关系增删的全局取锁顺序（设计 §3.5.1；#234 第 2 轮审查 P2）。所有会增删评价关系、或据此保留 / 作废 / 新建作答链接的
 * 入口——管理端增删关系、移除评价对象、按组织架构自动添加、导入、启用活动、重发邀请，以及上级确认入口的增删——一律：
 *   ① 活动行 FOR UPDATE（最先）→ ② 确认单 / 评价对象 / 评价关系行 → ③ 写关系行与活动标记（addRelation 插入、
 *   removeRelation 标记移除）→ ④ 评价者 × 活动的链接锁，锁内判定并写链接（沿用 / 新建 / 作废）。
 * 管理端经 requireActivity(lock) 在第一步取得活动行；上级确认入口在锁确认单之前调用本函数。链接锁永远在活动行锁之内
 * 取得，所以链接锁之间、链接锁与活动行之间都不会成环（第 2 轮的死锁是确认入口先持链接锁、再等活动行）。设计 §3.5.1。
 * 返回加锁后重读的活动（已删除为 undefined），状态判定以它为准。
 */
export async function lockActivityForRelations(tx: Tx, activityId: string): Promise<ActivityRow | undefined> {
  const [row] = rows<ActivityRow>(
    await tx.execute(sql`SELECT * FROM survey360_activities WHERE id = ${activityId}::uuid AND NOT deleted FOR UPDATE`),
  );
  return row;
}

/**
 * 评价者 × 活动的链接锁（③，事务级咨询锁）：“检查剩余关系 → 作废链接”（removeRelation）与“新增关系 → 确保链接”
 * （addRelation / 启用 / 重发）在同一把锁里决定保留、作废或新建链接（第 1 轮审查 P2-1）。先补取活动行锁（①）：
 * 调用方已持有时不等待；漏取活动锁的新入口也不会反过来先持链接锁、再等活动行。须在判定之前取、持有到事务结束。
 */
export async function lockAnswerLink(tx: Tx, activityId: string, personId: string): Promise<void> {
  await tx.execute(sql`SELECT 1 FROM survey360_activities WHERE id = ${activityId}::uuid FOR UPDATE`);
  await advisoryLock(tx, ':survey360-answer-link:', asUuid(activityId), ':', asUuid(personId));
  await linkHooks.afterLock?.();
}

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
  await lockAnswerLink(tx, activityId, person.id);
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
  await lockAnswerLink(tx, activityId, person.id);
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
  await lockAnswerLink(tx, activityId, personId);
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
