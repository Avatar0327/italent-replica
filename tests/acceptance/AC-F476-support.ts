/**
 * F-476 P1 验收夹具：组织调整审批世界 + 「办理时」与「申请人事后改单」两个时间点的内容对照。
 * 内容用合成名称（ZZ_ 前缀）；办理份只经 withTenant 查询（app_owner + FORCE RLS 下也能通过）。
 * 断言刻意不依赖 content 的内部形状（只用 jsonb 文本是否含某个名称），形状由 P1 实现决定。
 */
import { sql, withTenant } from '@italent/db';
import { expect } from 'vitest';
import type { Person } from './AC-APV-support.js';
import { type FlowWorld } from './AC-OA-approval-support.js';
import { rename } from './AC-OA-items-support.js';
import { reader } from './AC-OA-read-support.js';
import { resultRows } from './AC-ORG-people-support.js';

export const APPROVAL = '/api/tenant/approval';
export const NAME_A = 'ZZ_办理时名称';
export const NAME_B = 'ZZ_申请人改后名称';
export const NAME_C = 'ZZ_第三次名称';
export const SUBJECT_A = 'ZZ_办理时主题';
export const SUBJECT_B = 'ZZ_改后主题';

export interface Copy {
  id: string;
  task_id: string;
  handling_log_id: string;
  round: number;
  node_key: string;
  actor_user_id: string | null;
  handling_kind: string;
  action: string;
  business_type: string;
  content_schema_version: number;
  payload_bytes: number;
  event: string;
  text: string;
}

/** 红测的“行为式失败”：表不存在时先断言失败，而不是抛 SQL 错误。 */
export async function expectTable(w: FlowWorld): Promise<void> {
  const [row] = await withTenant(w.db, w.tenant.id, async (tx) =>
    resultRows<{ t: string | null }>(
      await tx.execute(sql`SELECT to_regclass('approval_handling_contents')::text AS t`),
    ),
  );
  expect(row?.t, '缺少 approval_handling_contents 表').toBe('approval_handling_contents');
}

/** 某实例的全部办理份（按办理日志序号），连同对应日志事件。 */
export async function copiesOf(w: FlowWorld, instanceId: string): Promise<Copy[]> {
  await expectTable(w);
  return withTenant(w.db, w.tenant.id, async (tx) =>
    resultRows<Copy>(
      await tx.execute(sql`SELECT c.id::text, c.task_id::text, c.handling_log_id::text, c.round, c.node_key,
        c.actor_user_id::text, c.handling_kind, c.action, c.business_type, c.content_schema_version, c.payload_bytes,
        l.event, c.content::text AS text
        FROM approval_handling_contents c
        JOIN approval_instance_logs l ON l.tenant_id = c.tenant_id AND l.id = c.handling_log_id
        WHERE c.instance_id = ${instanceId} ORDER BY l.seq`),
    ),
  );
}

export const copiesOfActor = async (w: FlowWorld, instanceId: string, actor: Person) =>
  (await copiesOf(w, instanceId)).filter((copy) => copy.actor_user_id === actor.userId);

export interface Scenario {
  id: string;
  itemId: string;
  instanceId: string;
}

/**
 * 办理时 = A、事后 = B：草稿（名称 A、主题 A）→ 提交 → HRBP 同意 → 负责人驳回 → 申请人把名称与主题改为 B。
 * 此后 HRBP（已办 n1）与负责人（已办 n2，驳回）的“已办”都应读到办理时的 A。
 */
export async function handledThenChanged(w: FlowWorld): Promise<Scenario> {
  const { id, itemId } = await w.draft(rename(w.a, { name: NAME_A }));
  const first = await w.patch(id, { subject: SUBJECT_A }, await w.revisionOf(id));
  expect(first.status, await first.clone().text()).toBe(200);
  await w.submitted(id);
  await w.acted(id, w.hrbp, 'approve');
  await w.acted(id, w.head, 'reject');
  await changeTo(w, { id, itemId }, NAME_B, SUBJECT_B);
  return { id, itemId, instanceId: (await w.instance(id)).id };
}

/** 申请人（已驳回单）改名称与主题。 */
export async function changeTo(w: FlowWorld, s: { id: string; itemId: string }, name: string, subject: string) {
  const item = await w.patchItem(s.id, s.itemId, { name });
  expect(item.status, await item.clone().text()).toBe(200);
  const head = await w.patch(s.id, { subject }, await w.revisionOf(s.id));
  expect(head.status, await head.clone().text()).toBe(200);
}

export interface Seen {
  /** 审批中心详情。 */
  centerNames: unknown[];
  centerSubject: unknown;
  mode: string | undefined;
  /** 组织调整详情 / 明细路由；读不到时为 undefined（状态码另见 orgStatus）。 */
  orgSubject: unknown;
  orgNames: unknown[];
  orgStatus: number;
}

/** 同一人在审批中心与组织调整两个入口读到的“名称 / 主题”。 */
export async function seenBy(w: FlowWorld, s: Scenario, user: string, viaCenter = true): Promise<Seen> {
  const r = reader(w);
  const orgDetail = await r.detailRes(s.id, user);
  const orgItems = await r.itemsRes(s.id, 'org', user);
  const detail = orgDetail.status === 200 ? ((await orgDetail.json()) as Record<string, unknown>) : {};
  const items = orgItems.status === 200 ? ((await orgItems.json()) as { items: Record<string, unknown>[] }) : null;
  let centerNames: unknown[] = [];
  let centerSubject: unknown;
  let mode: string | undefined;
  if (viaCenter) {
    const view = await w.detail(s.instanceId, user);
    const values = view.form.values;
    centerNames = ((values['orgItems.name'] as { value: unknown }[] | undefined) ?? []).map((e) => e.value);
    centerSubject = values.subject;
    mode = (view as unknown as { contentView?: { mode: string } }).contentView?.mode;
  }
  return {
    centerNames,
    centerSubject,
    mode,
    orgSubject: detail.subject,
    orgNames: items?.items.map((item) => item.name) ?? [],
    orgStatus: orgDetail.status,
  };
}

/** 对某个待办人发动作（带当前实例 revision）；task 取自该单实例当前 pending。 */
export async function post(w: FlowWorld, id: string, actor: Person, path: string, body: Record<string, unknown> = {}) {
  const view = await w.instance(id);
  const task = view.tasks.find((t) => t.status === 'pending' && t.assigneeUserId === actor.userId);
  expect(task, `${actor.name} 没有待办`).toBeDefined();
  return w.call('POST', `${APPROVAL}/tasks/${task!.id}/${path}`, { ifMatch: view.revision, body }, actor.userId);
}
