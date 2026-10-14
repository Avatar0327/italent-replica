/**
 * 邀请与站内待办（`25` §10.1～10.3 ①②③；开工通知：站内只用“待办”）：
 * - 待办按评价者 × 活动一条：重发覆盖原条、刷新发送时间、已处理的重新打开；只发给未完成且属于组织员工（360 人员
 *   挂接员工、员工绑定了有效账号，DEC-128）的评价者，全不符合时报原站文案；评价者提交全部对象后自动“已处理”；
 *   “取消待办”也移入已处理，但作答入口不失效（待办作答见 answering.ts，入口是登录账号本人）；
 * - 邮件邀请：给未完成的评价者重发，轮换令牌（links.ts），邮件只写 outbox；
 * - 发送与取消只在活动启用中（停用后原站按钮置灰）；精细化权限下只对范围内的评价者，范围外的与不存在的一样不符合。
 */
import { sql, type Tx, withTenant } from '@italent/db';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { uuidParam } from '../job/context.js';
import { type ActivityRow, iso, requireActivity } from './access.js';
import type { EntryOf } from './answering.js';
import {
  actor,
  type Admin,
  asIs,
  audit360,
  type C,
  fail,
  rows,
  type Survey360Context,
  uuid,
  write,
  type Writer,
} from './context.js';
import { type LinkRow, markSent, reissueAnswerLink } from './links.js';
import { loadPerson } from './people.js';
import { allRelationStates, byAppraiser, isComplete, relationStates } from './progress.js';
import { hasValidTask } from './tasks.js';

export const TODO_TITLE = '请你进行';

const targets = z.strictObject({ personIds: z.array(uuid).min(1).max(2000).optional() });

function requireOpen(activity: ActivityRow) {
  if (activity.status !== 'enabled') fail('CONFLICT', '活动未启用，不能发送或取消邀请与待办', 'ACTIVITY_NOT_OPEN');
}

/** 查看人范围内、未完成作答的评价者（可按选中的人员收窄）。 */
async function unfinished(tx: Tx, activityId: string, admin: Admin, personIds?: readonly string[]) {
  const chosen = personIds ? new Set(personIds) : null;
  return [...byAppraiser(await relationStates(tx, activityId, admin)).values()]
    .filter((p) => !isComplete(p) && (!chosen || chosen.has(p.personId)))
    .map((p) => p.personId);
}

/** 评价者挂接员工的有效账号（DEC-128 建档绑定；成员关系有效、账号未停用）。 */
async function accountsOf(tx: Tx, tenantId: string, personIds: readonly string[]): Promise<Map<string, string>> {
  if (!personIds.length) return new Map();
  const found = rows<{ person_id: string; user_id: string }>(
    await tx.execute(sql`SELECT p.id AS person_id, l.user_id FROM survey360_people p
      JOIN permission_user_person_links l ON l.tenant_id = p.tenant_id AND l.employee_id = p.employee_id
      JOIN tenant_memberships m ON m.tenant_id = l.tenant_id AND m.user_id = l.user_id AND m.status = 'active'
      WHERE p.tenant_id = ${tenantId}::uuid AND p.id = ANY(${`{${personIds.join(',')}}`}::uuid[])
        AND tenant_account_active(l.user_id)`),
  );
  return new Map(found.map((r) => [r.person_id, r.user_id]));
}

async function auditTodo(
  tx: Tx,
  ctx: Writer,
  activityId: string,
  todo: { id: string; person_id: string; status: string },
) {
  await audit360(tx, actor(ctx), {
    action: `survey360.todo.${todo.status === 'open' ? 'send' : 'done'}`,
    objectType: 'survey360-todo',
    objectId: todo.id,
    before: null,
    after: { activityId, personId: todo.person_id, status: todo.status },
  });
}

async function sendTodos(tx: Tx, ctx: Survey360Context, activityId: string, personIds?: readonly string[]) {
  const candidates = await unfinished(tx, activityId, ctx.admin, personIds);
  const accounts = await accountsOf(tx, ctx.tenantId, candidates);
  if (!accounts.size)
    fail(
      'CONFLICT',
      '仅支持给未完成作答且属于系统管理内部员工的评价者发送待办，目前选中的评价者均不符合条件。',
      'TODO_NOT_ELIGIBLE',
    );
  const now = ctx.now.toISOString();
  for (const [personId, userId] of accounts) {
    const [todo] = rows<{ id: string; person_id: string; status: string }>(
      await tx.execute(sql`INSERT INTO survey360_todos (tenant_id, activity_id, person_id, user_id, sent_at)
        VALUES (${ctx.tenantId}::uuid, ${activityId}::uuid, ${personId}::uuid, ${userId}::uuid, ${now}::timestamptz)
        ON CONFLICT (activity_id, person_id) DO UPDATE SET status = 'open', done_reason = NULL, done_at = NULL,
          user_id = EXCLUDED.user_id, sent_at = EXCLUDED.sent_at, revision = survey360_todos.revision + 1
        RETURNING id, person_id, status`),
    );
    await auditTodo(tx, ctx, activityId, todo!);
  }
  await markSent(tx, activityId, [...accounts.keys()], ctx.now);
  return { sent: accounts.size, message: `系统将陆续给${accounts.size}名评价者发送待办。` };
}

async function cancelTodos(tx: Tx, ctx: Survey360Context, activityId: string, personIds?: readonly string[]) {
  // 受限管理员只取消范围内看来尚未完成的评价者的待办：回执人数不随范围外任务变化（第 2 轮 P2-3）
  const visible = [...byAppraiser(await relationStates(tx, activityId, ctx.admin)).values()]
    .filter((p) => (!personIds || personIds.includes(p.personId)) && (!ctx.admin.people || !isComplete(p)))
    .map((p) => p.personId);
  const cancelled = visible.length
    ? rows<{ id: string; person_id: string; status: string }>(
        await tx.execute(sql`UPDATE survey360_todos SET status = 'done', done_reason = 'cancelled',
            done_at = ${ctx.now.toISOString()}::timestamptz, revision = revision + 1
          WHERE activity_id = ${activityId}::uuid AND status = 'open'
            AND person_id = ANY(${`{${visible.join(',')}}`}::uuid[])
          RETURNING id, person_id, status`),
      )
    : [];
  for (const todo of cancelled) await auditTodo(tx, ctx, activityId, todo);
  return { cancelled: cancelled.length, message: `系统将陆续取消${cancelled.length}名评价者与当前活动相关的待办。` };
}

async function sendInvitations(tx: Tx, ctx: Survey360Context, activityId: string, personIds?: readonly string[]) {
  const candidates = await unfinished(tx, activityId, ctx.admin, personIds);
  if (!candidates.length) fail('CONFLICT', '选中的评价者都已完成作答或不存在', 'NO_ELIGIBLE_APPRAISER');
  let credentialPending = 0;
  for (const personId of candidates) {
    const issued = await reissueAnswerLink(tx, ctx, activityId, await loadPerson(tx, personId));
    if (issued.credentialPending) credentialPending += 1;
  }
  await audit360(tx, actor(ctx), {
    action: 'survey360.invitation.send',
    objectType: 'survey360-activity',
    objectId: activityId,
    before: null,
    // 凭据进入待发放只记人数（F-076 设计 §2.6）
    after: { activityId, personIds: [...candidates].sort(), ...(credentialPending ? { credentialPending } : {}) },
  });
  return { sent: candidates.length };
}

/** 评价者提交全部评价对象后，其待办自动“已处理”（§10.3 ①完成条件）。按全部评价关系判定，与查看人无关。 */
export async function completeTodo(tx: Tx, ctx: Writer, activityId: string, personId: string): Promise<void> {
  const progress = byAppraiser(await allRelationStates(tx, activityId, { appraiserId: personId })).get(personId);
  if (!progress || !isComplete(progress)) return;
  const done = rows<{ id: string; person_id: string; status: string }>(
    await tx.execute(sql`UPDATE survey360_todos SET status = 'done', done_reason = 'completed',
        done_at = ${ctx.now.toISOString()}::timestamptz, revision = revision + 1
      WHERE activity_id = ${activityId}::uuid AND person_id = ${personId}::uuid AND status = 'open'
      RETURNING id, person_id, status`),
  );
  for (const todo of done) await auditTodo(tx, ctx, activityId, todo);
}

/** 待办作答入口：登录账号本人的待办 → 该评价者在活动内当前有效的作答链接；别人的待办与不存在同一 404。 */
export function todoEntry(): EntryOf {
  return async (c: C) => {
    const tenant = tenantOf(c);
    const todoId = uuidParam(c, 'todoId');
    const locate = async (tx: Tx): Promise<LinkRow | undefined> => {
      const [row] = rows<{ id: string; activity_id: string; person_id: string }>(
        await tx.execute(sql`SELECT l.id, l.activity_id, l.person_id FROM survey360_todos t
          JOIN survey360_links l ON l.tenant_id = t.tenant_id AND l.activity_id = t.activity_id
            AND l.person_id = t.person_id AND l.kind = 'answer' AND NOT l.revoked
          WHERE t.id = ${todoId}::uuid AND t.user_id = ${tenant.userId}::uuid`),
      );
      return row
        ? { id: row.id, activityId: row.activity_id, kind: 'answer', personId: row.person_id, confirmationId: null }
        : undefined;
    };
    return { tenant, caller: tenant, locate, avatarBase: `/api/tenant/survey360/my/todos/${todoId}` };
  };
}

export function registerTodoRoutes(module: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  // 发送 / 取消：评价关系对象的“邀请”按钮；回执是协议字段（人数与原站提示），不按对象字段裁剪
  const INVITE = { object: 'relation', operation: 'update', button: 'invite' } as const;
  type Run = (tx: Tx, ctx: Survey360Context, activityId: string, personIds?: readonly string[]) => Promise<object>;
  const RUNS: Readonly<Record<string, Run>> = {
    '/todos': sendTodos,
    '/todos/cancel': cancelTodos,
    '/invitations': sendInvitations,
  };
  // 路径写成字面量数组：F-039 静态扫描按注册处求值，三条路由各自定位到本处理函数
  for (const path of ['/todos', '/todos/cancel', '/invitations']) {
    const run = RUNS[path]!;
    module.post(`/activities/:id${path}`, (c) => {
      const id = uuidParam(c);
      return write(
        c,
        deps,
        targets,
        async (tx, ctx, input) => {
          const activity = await requireActivity(tx, ctx.admin, id, true);
          requireOpen(activity);
          return run(tx, ctx, activity.id, input.personIds);
        },
        {
          need: INVITE,
          fields: 'none',
          revisionFree: true,
          guard: async (tx, admin) => void (await requireActivity(tx, admin, id)),
          present: asIs,
        },
      );
    });
  }

  // 我的待办：只要租户成员身份，只看本人账号的；评价关系已全部消失的待办不再列出（F-084）
  module.get('/my/todos', async (c) => {
    const tenant = tenantOf(c);
    const items = await withTenant(deps.db, tenant.tenantId, async (tx) =>
      rows<{ id: string; activity_id: string; name: string; status: string; sent_at: Date; done_at: Date | null }>(
        await tx.execute(sql`SELECT t.id, t.activity_id, a.name, t.status, t.sent_at, t.done_at
          FROM survey360_todos t JOIN survey360_activities a ON a.tenant_id = t.tenant_id AND a.id = t.activity_id
          WHERE t.user_id = ${tenant.userId}::uuid AND NOT a.deleted
            AND ${hasValidTask(sql`t.activity_id`, sql`t.person_id`)} ORDER BY t.sent_at DESC, t.id LIMIT 500`),
      ),
    );
    return c.json({
      items: items.map((t) => ({
        id: t.id,
        activityId: t.activity_id,
        title: TODO_TITLE,
        content: t.name,
        status: t.status,
        sentAt: iso(t.sent_at),
        doneAt: iso(t.done_at),
      })),
    });
  });
}
