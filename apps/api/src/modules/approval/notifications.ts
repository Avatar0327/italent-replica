/**
 * 待办与消息：节点消息规则（触发动作 → 渠道 → 模板 → 接收人，`14` §8.2）与催办（`14` §9.2）。
 * 只登记通知（状态 pending），外发由 outbox 消费者负责；仿真不调用这里（DEC-036）。
 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import type { ApprovalNode, MessageRule } from '@italent/domain';
import type { ApprovalContext } from './context.js';
import { isActiveAccount, userOfPerson } from './resolver.js';
import type { InstanceRow } from './store.js';

interface Notice {
  readonly recipientUserId: string;
  readonly kind: 'todo' | 'urge' | 'message' | 'cc';
  readonly channel: 'inbox' | 'email' | 'sms';
  readonly templateCode: string | null;
  readonly taskId: string | null;
}

/**
 * R5-4：只按已提交的状态判断——接收人成员关系已撤销或全局账号已停用时不发（与“接收人无账号不发”同一口径，
 * 不伪造接收人）；停用尚在进行（未提交、可能回滚）时照常登记（pending），发送意图不因临时的停用而丢失，
 * 外发时再按当时的状态处理。登记引用其成员行的外键不会等待：撤销只在接管完成后的最后一步才锁成员行。
 */
async function insertNotice(tx: Tx, ctx: ApprovalContext, instance: InstanceRow, notice: Notice): Promise<void> {
  if (!(await isActiveAccount(tx, ctx.tenantId, notice.recipientUserId))) return;
  await tx.execute(sql`INSERT INTO approval_notifications
    (id,tenant_id,instance_id,task_id,recipient_user_id,kind,channel,template_code,command_id,created_at)
    VALUES (${randomUUID()},${ctx.tenantId},${instance.id}::uuid,${notice.taskId},${notice.recipientUserId}::uuid,
      ${notice.kind},${notice.channel},${notice.templateCode},${ctx.commandId},${ctx.now.toISOString()})`);
}

export async function notifyTodo(tx: Tx, ctx: ApprovalContext, instance: InstanceRow, taskId: string, userId: string) {
  await insertNotice(tx, ctx, instance, {
    recipientUserId: userId,
    kind: 'todo',
    channel: 'inbox',
    templateCode: null,
    taskId,
  });
}

/** DEC-097：抄送通知（站内）。 */
export async function notifyCc(tx: Tx, ctx: ApprovalContext, instance: InstanceRow, taskId: string, userId: string) {
  await insertNotice(tx, ctx, instance, {
    recipientUserId: userId,
    kind: 'cc',
    channel: 'inbox',
    templateCode: null,
    taskId,
  });
}

export async function notifyUrge(tx: Tx, ctx: ApprovalContext, instance: InstanceRow, tasks: readonly UrgeTarget[]) {
  for (const task of tasks) {
    await insertNotice(tx, ctx, instance, {
      recipientUserId: task.userId,
      kind: 'urge',
      channel: 'inbox',
      templateCode: null,
      taskId: task.taskId,
    });
  }
}

export interface UrgeTarget {
  readonly taskId: string;
  readonly userId: string;
}

async function recipientOf(
  tx: Tx,
  ctx: ApprovalContext,
  instance: InstanceRow,
  rule: MessageRule,
  assigneeUserId: string | null,
): Promise<string | null> {
  if (rule.recipient === 'owner') return instance.initiatorUserId;
  if (rule.recipient === 'assignee') return assigneeUserId;
  return userOfPerson(tx, ctx.tenantId, instance.subjectEmployeeId);
}

/** 按节点消息规则生成通知；接收人无账号时不发（不伪造接收人）。 */
export async function applyMessageRules(
  tx: Tx,
  ctx: ApprovalContext,
  instance: InstanceRow,
  node: ApprovalNode,
  trigger: MessageRule['trigger'],
  task: { id: string; assigneeUserId: string | null },
): Promise<void> {
  for (const rule of node.messageRules.filter((candidate) => candidate.trigger === trigger)) {
    const recipient = await recipientOf(tx, ctx, instance, rule, task.assigneeUserId);
    if (!recipient) continue;
    for (const channel of rule.channels) {
      await insertNotice(tx, ctx, instance, {
        recipientUserId: recipient,
        kind: 'message',
        channel,
        templateCode: rule.template,
        taskId: task.id,
      });
    }
  }
}
