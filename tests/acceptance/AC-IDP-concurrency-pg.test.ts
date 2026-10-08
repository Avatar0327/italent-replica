/**
 * R3-T07 IDP 配置在真实 PostgreSQL 16 上的强制交错（AGENTS §10「并发」；write-support.ts 取锁顺序 模板 → 流程 → 子流程）：
 * - 模板引用流程的事务先持流程共享锁（未提交），并发调整子流程顺序等待后读到引用 → 409 IDP_PROCESS_REFERENCED；
 * - 删除流程的事务先持锁（未提交），并发新建引用它的模板等待后读到流程已删除 → 404；
 * - 模板写节点配置的事务先持子流程共享锁（未提交），并发给该子流程换审批流程等待后读到节点配置 → 409；
 * - 同名模板并发新建：唯一约束兜底，一个 201、一个 409 IDP_TEMPLATE_NAME_TAKEN。
 */
import { type Db, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { idpApprovalProcess, idpWorld, type ProcessView, type TemplateView } from './AC-IDP-support.js';

const testDb = useTestDb();

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

async function blocked(db: Db, expected: number) {
  for (let i = 0; i < 200; i++) {
    const [row] = rowsOf<{ count: number }>(
      await db.execute(sql`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'`),
    );
    if (row?.count === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`未观测到 ${expected} 个被锁阻塞的并发操作`);
}

const inputOf = (process: ProcessView) => process.subProcesses.map(({ ruleText: _ruleText, ...rest }) => rest);

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('R3-T07 IDP 配置 PostgreSQL 16 强制交错', () => {
  it('模板引用流程未提交时调整子流程顺序：等待后读到引用 → 409，流程不变', async () => {
    const { db } = testDb();
    const w = await idpWorld(db, 'idppgref');
    const process = await w.process();
    const before = await w.read<ProcessView>(`/processes/${process.id}`);
    const [first, second, third] = inputOf(before);

    let pending: Promise<Response> | undefined;
    await withTenant(db, w.tenant.id, async (tx) => {
      // 模拟新建模板的事务：对流程加共享锁并写入引用，提交前调整顺序的请求到达
      await tx.execute(sql`SELECT id FROM idp_processes WHERE id = ${process.id}::uuid FOR SHARE`);
      await tx.execute(sql`INSERT INTO idp_templates (tenant_id, name, org_id, process_id, created_by)
        VALUES (${w.tenant.id}::uuid, '并发模板', ${w.orgId}::uuid, ${process.id}::uuid, ${w.user.id}::uuid)`);
      pending = w.request('PATCH', `/processes/${process.id}`, {
        ifMatch: before.revision,
        body: { subProcesses: [second, first, third] },
      });
      await blocked(db, 1);
    });
    const response = await pending!;
    expect(response.status, await response.clone().text()).toBe(409);
    expect(((await response.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'IDP_PROCESS_REFERENCED',
    );
    expect(await w.read<ProcessView>(`/processes/${process.id}`)).toEqual({ ...before, referenced: true });
  });

  it('删除流程未提交时新建引用它的模板：等待后读到流程已删除 → 404，不留模板', async () => {
    const { db } = testDb();
    const w = await idpWorld(db, 'idppgdel');
    const process = await w.process();

    let pending: Promise<Response> | undefined;
    await withTenant(db, w.tenant.id, async (tx) => {
      await tx.execute(sql`SELECT id FROM idp_processes WHERE id = ${process.id}::uuid FOR UPDATE`);
      pending = w.request('POST', '/templates', {
        ifMatch: 0,
        body: { name: '引用将删流程', orgId: w.orgId, processId: process.id },
      });
      await blocked(db, 1);
      await tx.execute(sql`DELETE FROM idp_processes WHERE id = ${process.id}::uuid`);
    });
    const response = await pending!;
    expect(response.status, await response.clone().text()).toBe(404);
    expect((await w.read<{ items: unknown[] }>('/templates')).items).toEqual([]);
  });

  it('写节点配置未提交时给该子流程换审批流程：等待后读到节点配置 → 409，审批流程不变', async () => {
    const { db } = testDb();
    const w = await idpWorld(db, 'idppgnode');
    const process = await w.process();
    const template = await w.addModule(await w.template(process.id), { moduleType: 'goal', name: '发展目标' });
    const goal = template.modules.find((m) => m.moduleType === 'goal')!;
    const before = await w.read<ProcessView>(`/processes/${process.id}`);
    const replacement = await idpApprovalProcess(db, w.as, 'idp_plan');
    const stage = before.subProcesses[0]!;

    let pending: Promise<Response> | undefined;
    await withTenant(db, w.tenant.id, async (tx) => {
      // 模拟模板写节点配置的事务：对子流程行加共享锁并写入配置，提交前换审批流程的请求到达
      await tx.execute(sql`SELECT id FROM idp_sub_processes WHERE id = ${stage.id}::uuid FOR SHARE`);
      await tx.execute(sql`INSERT INTO idp_template_node_settings
        (tenant_id, module_id, sub_process_id, node_key, seq, enabled, buttons)
        VALUES (${w.tenant.id}::uuid, ${goal.id}::uuid, ${stage.id}::uuid, 'set_goals', 1, true,
          ARRAY['RowAddIdpGoal']::text[])`);
      pending = w.request('PATCH', `/processes/${process.id}`, {
        ifMatch: before.revision,
        body: {
          subProcesses: inputOf(before).map((s, i) => (i === 0 ? { ...s, approvalProcessId: replacement.id } : s)),
        },
      });
      await blocked(db, 1);
    });
    const response = await pending!;
    expect(response.status, await response.clone().text()).toBe(409);
    expect(((await response.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'IDP_NODE_SETTINGS_EXIST',
    );
    expect((await w.read<ProcessView>(`/processes/${process.id}`)).subProcesses[0]!.approvalProcessId).toBe(
      stage.approvalProcessId,
    );
  });

  it('同名模板并发新建：一个 201、一个 409', async () => {
    const { db } = testDb();
    const w = await idpWorld(db, 'idppgname');
    const process = await w.process();
    const body = { name: '同名并发模板', orgId: w.orgId, processId: process.id };
    const responses = await Promise.all([
      w.request('POST', '/templates', { ifMatch: 0, body }),
      w.request('POST', '/templates', { ifMatch: 0, body }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    const rejected = responses.find((r) => r.status === 409)!;
    expect(((await rejected.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'IDP_TEMPLATE_NAME_TAKEN',
    );
    const list = await w.read<{ items: TemplateView[] }>('/templates');
    expect(list.items.map((t) => t.name)).toEqual(['同名并发模板']);
  });
});
