/**
 * 组织调整审批世界（BE-10c）：在明细世界上加审批主体组织的 HRBP / 负责人、已发布的 org_adjustment 流程、
 * 提交 / 撤回（路由 10～11）与审批中心动作（经同一授权器的 api，审批人的按钮 / 字段 / 范围随 access 变化）。
 */
import { type Db, sql, withTenant } from '@italent/db';
import { approverSource, ORG_ADJUSTMENT_FORM_FIELDS } from '@italent/domain';
import { expect } from 'vitest';
import type { InstanceView, NodeInput, Person, ProcessInput } from './AC-APV-support.js';
import { BASE } from './AC-OA-head-support.js';
import { itemsWorld, type ItemsWorld, rename } from './AC-OA-items-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { uniqueSuffix } from './support/unique.js';

const APPROVAL = '/api/tenant/approval';
export const OA_CONDITIONS = {
  items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'OrganizationProcess' }],
} as const;

/** 两节点：HRBP（可单独编辑）→ 负责人；`over` 按节点覆盖。 */
export function oaNodes(over: readonly Partial<NodeInput>[] = []): NodeInput[] {
  return [
    {
      key: 'n1',
      name: 'HRBPLeader审批',
      approver: approverSource('approval_subject_org_hrbp'),
      formFields: ORG_ADJUSTMENT_FORM_FIELDS,
      editableFields: ['subject', 'content', 'orgItems.name', 'orgItems.shortName'],
      editMode: 'separate',
      exits: ['approve', 'disagree'],
      ...over[0],
    },
    {
      key: 'n2',
      name: 'HR负责人审批',
      approver: approverSource('approval_subject_org_head'),
      formFields: ORG_ADJUSTMENT_FORM_FIELDS,
      exits: ['approve', 'disagree'],
      ...over[1],
    },
  ];
}

export interface FlowOptions {
  readonly nodes?: NodeInput[];
  /** 发布前补充流程定义（如外部异常管理员）。 */
  readonly process?: (w: ItemsWorld) => Promise<Partial<ProcessInput>>;
}

export async function flowWorld(db: Db, label: string, options: FlowOptions = {}) {
  const w = await itemsWorld(db, label);
  const hrbp = await w.person(`HRBP${uniqueSuffix()}`, w.subject);
  const head = await w.person(`负责人${uniqueSuffix()}`, w.subject);
  await w.setOrgRoles(w.subject, { hrbp: hrbp.employeeId, head: head.employeeId });
  const process = await w.publishedProcess({
    approvalType: 'org_adjustment',
    conditions: OA_CONDITIONS,
    nodes: options.nodes ?? oaNodes(),
    ...(await options.process?.(w)),
  });
  const revisionOf = async (id: string) => (await w.stored(id))!.revision;

  /** 草稿：头 + 一条改名明细（目标为范围内的 a）。 */
  async function draft(item: Record<string, unknown> = rename(w.a)) {
    const view = await w.created();
    const added = await w.item(view.id, item);
    return { id: view.id, itemId: added.items[0]!.id };
  }
  const submit = async (id: string, ifMatch?: number, user = w.hr.id) =>
    w.call('POST', `${BASE}/${id}/submit`, { ifMatch: ifMatch ?? (await revisionOf(id)), body: {} }, user);
  const withdraw = async (id: string, ifMatch?: number, user = w.hr.id) =>
    w.call('POST', `${BASE}/${id}/withdraw`, { ifMatch: ifMatch ?? (await revisionOf(id)), body: {} }, user);
  async function submitted(id: string) {
    const res = await submit(id);
    expect(res.status, await res.clone().text()).toBe(200);
    return res.json() as Promise<{ approvalStatus: number; revision: number }>;
  }
  async function instances(id: string, user = w.hr.id): Promise<InstanceView[]> {
    const res = await w.call('GET', `${APPROVAL}/instances?role=initiated&businessId=${id}`, {}, user);
    expect(res.status, await res.clone().text()).toBe(200);
    const list = (await res.json()) as { items: { id: string }[] };
    return Promise.all(list.items.map((item) => detail(item.id, user)));
  }
  async function detail(instanceId: string, user = w.hr.id): Promise<InstanceView> {
    const res = await w.call('GET', `${APPROVAL}/instances/${instanceId}`, {}, user);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as InstanceView;
  }
  async function instance(id: string): Promise<InstanceView> {
    const all = await instances(id);
    expect(all).toHaveLength(1);
    return all[0]!;
  }
  /** 当前审批人对本单的待办动作（approve / disagree / reject / edit）。 */
  async function act(
    id: string,
    actor: Person,
    action: 'approve' | 'disagree' | 'reject' | 'edit',
    body: Record<string, unknown> = {},
  ) {
    const view = await instance(id);
    const task = view.tasks.find((t) => t.status === 'pending' && t.assigneeUserId === actor.userId);
    expect(task, `${actor.name} 没有待办`).toBeDefined();
    const payload = action === 'edit' ? body : { comment: '合成意见', ...body };
    return w.call(
      'POST',
      `${APPROVAL}/tasks/${task!.id}/${action}`,
      { ifMatch: view.revision, body: payload },
      actor.userId,
    );
  }
  async function acted(id: string, actor: Person, action: 'approve' | 'disagree' | 'reject') {
    const res = await act(id, actor, action);
    expect(res.status, await res.clone().text()).toBe(200);
  }
  const instanceAction = async (id: string, action: 'withdraw' | 'resubmit', user = w.hr.id) => {
    const view = await instance(id);
    return w.call('POST', `${APPROVAL}/instances/${view.id}/${action}`, { ifMatch: view.revision, body: {} }, user);
  };
  /** 审批 / 执行状态 + revision + 执行队列行数（BE-10c 不写队列）。 */
  async function state(id: string) {
    return withTenant(w.db, w.tenant.id, async (tx) => {
      const [row] = resultRows<{ approval: number; execution: number; revision: number; queued: number }>(
        await tx.execute(sql`SELECT approval_status AS approval, execution_status AS execution, revision,
          (SELECT count(*) FROM org_adjustment_executions e WHERE e.adjustment_id = a.id)::int
            + (SELECT count(*) FROM org_adjustment_scope_orgs s WHERE s.adjustment_id = a.id)::int AS queued
          FROM org_adjustments a WHERE a.id = ${id}`),
      );
      return row!;
    });
  }
  /** 实例记下的业务版本（审批中编辑后应随单据 revision 同步）。 */
  async function businessVersion(id: string) {
    return withTenant(w.db, w.tenant.id, async (tx) => {
      const [row] = resultRows<{ business_version: string }>(
        await tx.execute(sql`SELECT business_version FROM approval_instances
          WHERE business_type = 'org_adjustment' AND business_id = ${id} ORDER BY created_at DESC LIMIT 1`),
      );
      return row?.business_version;
    });
  }

  return {
    ...w,
    /** 头载荷构造（`head` 在本世界里是主体组织负责人）。 */
    headBody: w.head,
    hrbp,
    head,
    process,
    revisionOf,
    draft,
    submit,
    submitted,
    withdraw,
    instances,
    instance,
    detail,
    act,
    acted,
    instanceAction,
    state,
    businessVersion,
  };
}

export type FlowWorld = Awaited<ReturnType<typeof flowWorld>>;
