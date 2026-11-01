/**
 * 演示种子接管用例（AC-DEMO-F025-seed-takeover / seed-race）的共用辅助：独立库上的公开接口调用、只读观测、
 * 中断注入与打开节点转交 / 加签的流程配置。
 */
import { sql, tenants, users, eq, withPlatform, withTenant } from '@italent/db';
import { TRANSFER_FORM_FIELDS, approverSource, type ApproverExpression } from '@italent/domain';
import type { createTestDb } from '@italent/testkit';
import { expect } from 'vitest';
import { DEMO_PEOPLE, DEMO_TRANSFER_PROCESS_CODE } from '../../../apps/api/src/demo/data.js';
import { tenantApi } from './tenant-api.js';

export const TODAY = '2026-10-07';
export const clock = () => new Date(`${TODAY}T02:00:00.000Z`);
export const options = { clock, nodeEnv: 'test' } as const;

export type TestDb = Awaited<ReturnType<typeof createTestDb>>['db'];
export type Json = Record<string, unknown>;

export const rowsOf = <T>(result: unknown): T[] =>
  (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];

/** 在指定步骤之后注入失败（模拟种子中断）。 */
export const stopAfter = (key: string) => ({
  ...options,
  onStep: (step: { phase: string; key: string }) => {
    if (step.phase === 'transfers' && step.key === key) throw new Error(`注入的失败：${key} 之后`);
  },
});

/** 独立库上的公开接口调用与只读观测。 */
export async function actors(db: TestDb) {
  const [tenant] = await withPlatform(db, (tx) => tx.select().from(tenants).where(eq(tenants.code, 'demo-r1')));
  const tenantId = tenant!.id;
  const api = tenantApi(db, { authorize: undefined, clock });
  const userIdOf = async (email: string) => {
    const [row] = await withPlatform(db, (tx) => tx.select().from(users).where(eq(users.email, email)));
    return row!.id;
  };
  const persona = (key: string) => userIdOf(DEMO_PEOPLE.find((p) => p.key === key)!.email);
  const send = async (userId: string, method: string, path: string, body?: unknown, ifMatch?: number) => {
    const response = await api.request(method, path, { user: userId, tenant: tenantId, body, ifMatch });
    expect(response.status, `${method} ${path} ${await response.clone().text()}`).toBeLessThan(300);
    return (await response.json()) as Json;
  };
  const query = <T>(statement: ReturnType<typeof sql>) =>
    withTenant(db, tenantId, async (tx) => rowsOf<T>(await tx.execute(statement)));
  const businessOf = async (scenario: string) => {
    const commandId = `demo-seed:${tenantId}:${scenario}`;
    const [row] = await query<{ id: string }>(
      sql`SELECT response_body->>'id' AS id FROM command_ledger WHERE command_id = ${commandId}`,
    );
    return row!.id;
  };
  const instanceOf = async (scenario: string) => {
    const [row] = await query<{ id: string; revision: number }>(
      sql`SELECT id, revision FROM approval_instances WHERE business_id = ${await businessOf(scenario)}::uuid`,
    );
    return row!;
  };
  const pendingTask = async (scenario: string) => {
    const instance = await instanceOf(scenario);
    const [task] = await query<{ id: string; assignee: string }>(
      sql`SELECT id, assignee_user_id AS assignee FROM approval_tasks
        WHERE instance_id = ${instance.id}::uuid AND status = 'pending' ORDER BY seq LIMIT 1`,
    );
    return { instance, task: task! };
  };
  /** 单据与审批实例的完整可观测状态：业务单状态、实例状态 / 轮次 / revision、全部日志与任务。 */
  const snapshot = async (scenario: string) => {
    const businessId = await businessOf(scenario);
    const hr = await persona('hr');
    const business = await send(hr, 'GET', `/api/tenant/employment/businesses/${businessId}`);
    const instances = await query<Json>(
      sql`SELECT id, status, round, revision FROM approval_instances WHERE business_id = ${businessId}::uuid
        ORDER BY created_at`,
    );
    const ids = instances.map((row) => String(row.id));
    const logs = await query<Json>(
      sql`SELECT instance_id, seq, round, event, task_id, actor_user_id FROM approval_instance_logs
        WHERE instance_id = ANY(${`{${ids.join(',')}}`}::uuid[]) ORDER BY instance_id, seq`,
    );
    const tasks = await query<Json>(
      sql`SELECT id, seq, round, status, assignee_user_id, origin FROM approval_tasks
        WHERE instance_id = ANY(${`{${ids.join(',')}}`}::uuid[]) ORDER BY instance_id, seq`,
    );
    return { status: business.status, instances, logs, tasks };
  };
  /** 种子在该场景上记过的步骤台账（命令 ID）。 */
  const steps = async (scenario: string) =>
    (
      await query<{ commandId: string }>(
        sql`SELECT command_id AS "commandId" FROM command_ledger
          WHERE command_id LIKE ${`demo-seed-step:${scenario}:%`} ORDER BY command_id`,
      )
    ).map((row) => row.commandId);
  return { tenantId, persona, userIdOf, send, query, businessOf, instanceOf, pendingTask, snapshot, steps };
}

/** 经公开流程配置接口给演示调动流程发新版本：两个节点都打开转交与加签。 */
export async function enableTransferAndAddSign(user: Awaited<ReturnType<typeof actors>>) {
  const admin = await user.persona('admin');
  const base = '/api/tenant/approval/processes';
  const list = await user.send(admin, 'GET', `${base}?pageSize=200`);
  const found = (list.items as Json[]).find((row) => row.code === DEMO_TRANSFER_PROCESS_CODE)!;
  const read = async () => user.send(admin, 'GET', `${base}/${String(found.id)}`);
  await user.send(admin, 'POST', `${base}/${String(found.id)}/versions`, undefined, Number((await read()).revision));
  const node = (key: string, name: string, approver: ApproverExpression) => ({
    key,
    name,
    approver: approverSource(approver),
    formFields: TRANSFER_FORM_FIELDS,
    actions: { avoidSelf: true, transfer: true, addSign: true },
  });
  const definition = {
    name: '演示调动流程',
    priority: -1,
    exceptionAdminUserId: await user.persona('exception'),
    conditions: {
      items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'TransferProcessNew' }],
      expression: '1',
    },
    nodes: [
      node('direct_head', '直接上级审批', 'latest_record_department_head'),
      node('in_hrbp', '调入部门HRBP审核', 'record_department_hrbp'),
    ],
  };
  await user.send(admin, 'PUT', `${base}/${String(found.id)}/draft`, definition, Number((await read()).revision));
  await user.send(admin, 'POST', `${base}/${String(found.id)}/publish`, undefined, Number((await read()).revision));
}
