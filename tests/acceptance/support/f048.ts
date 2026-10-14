/**
 * F-048 PR-2 判定接入的验收夹具（docs/08_设计/F-048_审批多主体回避_设计.md §10）：
 * 集合审批的业务尚未接入（R3-T04），用测试适配器给任职业务临时挂 subjects 映射，用例结束即移除，不进产品代码；
 * 冻结行不可改但可追加，可信夹具直写一行模拟“冻结值与路由时不一致”的异常数据，验证办理 / 激活时的防御判定。
 */
import { randomUUID } from 'node:crypto';
import { permissionUserPersonLinks, sql, withTenant, type Db } from '@italent/db';
import { afterEach } from 'vitest';
import { ADAPTERS, type BusinessAdapter } from '../../../apps/api/src/modules/approval/adapters.js';
import type { ApprovalWorld, InstanceView, TaskView } from '../AC-APV-support.js';

const employment = ADAPTERS.employment as BusinessAdapter;

/** 在 describe 内调用一次：每个用例结束后移除测试适配器的 subjects。 */
export function useSubjectMapping(): (ids: () => readonly string[]) => void {
  afterEach(() => {
    delete (employment as { subjects?: unknown }).subjects;
  });
  return (ids) => {
    (employment as { subjects?: BusinessAdapter['subjects'] }).subjects = async () => ids();
  };
}

export const pendingOf = (view: InstanceView): TaskView[] => view.tasks.filter((task) => task.status === 'pending');

export async function reasonOf(response: Response) {
  const body = (await response.json()) as {
    error?: { code?: string; details?: { reason?: string; recusal?: string } };
  };
  return {
    status: response.status,
    code: body.error?.code,
    reason: body.error?.details?.reason,
    recusal: body.error?.details?.recusal,
  };
}

/** 状态快照：用于负向用例的前后对比（实例状态、revision、全部任务）。 */
export async function snapshotOf(w: ApprovalWorld, instanceId: string, actor = w.hr.id) {
  const view = await w.detail(instanceId, actor);
  return { status: view.status, revision: view.revision, currentNodeKey: view.currentNodeKey, tasks: view.tasks };
}

/** 绑定账号（可信夹具：模拟建档 / 入职的首次绑定）。 */
export async function bind(w: ApprovalWorld, employeeId: string, name: string): Promise<string> {
  const userId = await w.member(name);
  await withTenant(w.db, w.tenant.id, (tx) =>
    tx.insert(permissionUserPersonLinks).values({ tenantId: w.tenant.id, userId, employeeId }),
  );
  return userId;
}

export interface FrozenRow {
  round: number;
  employee_id: string;
  user_id: string | null;
}

export const rowsOf = <T>(value: unknown): T[] => (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];

export async function frozenOf(w: ApprovalWorld, instanceId: string): Promise<FrozenRow[]> {
  return withTenant(w.db, w.tenant.id, async (tx) =>
    rowsOf<FrozenRow>(
      await tx.execute(sql`SELECT round, employee_id::text, user_id::text FROM approval_instance_subjects
        WHERE tenant_id=${w.tenant.id} AND instance_id=${instanceId}::uuid ORDER BY round, employee_id`),
    ),
  );
}

/**
 * 可信夹具（连接角色直写）：追加一行冻结值，让某个账号“事后”成为主体账号，模拟异常数据。冻结表的 employee_id 没有外键，
 * 夹具用随机员工编号即可。
 */
export async function insertFrozen(db: Db, tenantId: string, instanceId: string, userId: string, round = 1) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    await tx.execute(sql`INSERT INTO approval_instance_subjects
      (tenant_id,instance_id,round,employee_id,user_id,created_at)
      VALUES (${tenantId},${instanceId}::uuid,${round},${randomUUID()}::uuid,${userId}::uuid,now())`);
  });
}

export const injectFrozen = (w: ApprovalWorld, instanceId: string, userId: string, round = 1) =>
  insertFrozen(w.db, w.tenant.id, instanceId, userId, round);

/** 只有指定节点的调动流程（节点 key 与审批人表达式沿用 TRANSFER_NODES 的命名）。 */
export const NODES = {
  outHead: { key: 'out_head', approver: 'latest_record_department_head' },
  inHrbp: { key: 'in_hrbp', approver: 'record_department_hrbp' },
  inHead: { key: 'in_head', approver: 'record_department_head' },
} as const;

/**
 * 可信夹具（连接角色直写）：删除某实例的冻结行，模拟 F-048 上线前创建、没有冻结行的存量实例。冻结表有只追加触发器，
 * 属主在同一事务内临时停用用户触发器后删除，提交前恢复。
 */
export async function dropFrozen(db: Db, tenantId: string, instanceId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    await tx.execute(sql`ALTER TABLE approval_instance_subjects DISABLE TRIGGER USER`);
    await tx.execute(sql`DELETE FROM approval_instance_subjects WHERE instance_id=${instanceId}::uuid`);
    await tx.execute(sql`ALTER TABLE approval_instance_subjects ENABLE TRIGGER USER`);
  });
}
