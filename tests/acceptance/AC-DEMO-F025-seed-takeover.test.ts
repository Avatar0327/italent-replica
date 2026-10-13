/**
 * F-025 演示种子：用户接管（DEC-477）。种子场景的单据上一旦出现不是种子自己发起的操作——转交、加签、管理员转交 /
 * 干预、催办、重提等——就视为用户接管，种子续跑永不再动这张单（不审批、不驳回、不撤回、不新增日志）。
 * 每条序列都是：种子在某场景创建后中断（没有完成记录）→ 用户经公开接口操作 → 续跑种子 → 单据与审批实例保持用户操作后的样子。
 * 节点转交 / 加签需要流程开关：在种子发布演示流程后中断，经公开流程配置接口发新版本打开开关，再继续。
 */
import { sql, tenants, users, eq, withPlatform, withTenant } from '@italent/db';
import { TRANSFER_FORM_FIELDS } from '@italent/domain';
import { createTestDb } from '@italent/testkit';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEMO_PEOPLE, DEMO_TRANSFER_PROCESS_CODE } from '../../apps/api/src/demo/data.js';
import { fileProgress, seedDemo } from '../../apps/api/src/demo/seed.js';
import { tenantApi } from './support/tenant-api.js';

vi.setConfig({ testTimeout: 900_000 });
const TODAY = '2026-10-07';
const clock = () => new Date(`${TODAY}T02:00:00.000Z`);
const options = { clock, nodeEnv: 'test' } as const;

type TestDb = Awaited<ReturnType<typeof createTestDb>>['db'];
type Json = Record<string, unknown>;

const rowsOf = <T>(result: unknown): T[] =>
  (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];

/** 在指定步骤之后注入失败（模拟种子中断）。 */
const stopAfter = (key: string) => ({
  ...options,
  onStep: (step: { phase: string; key: string }) => {
    if (step.phase === 'transfers' && step.key === key) throw new Error(`注入的失败：${key} 之后`);
  },
});

/** 独立库上的公开接口调用与只读观测。 */
async function actors(db: TestDb) {
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
  return { tenantId, persona, userIdOf, send, businessOf, instanceOf, pendingTask, snapshot };
}

/** 经公开流程配置接口给演示调动流程发新版本：两个节点都打开转交与加签。 */
async function enableTransferAndAddSign(user: Awaited<ReturnType<typeof actors>>) {
  const admin = await user.persona('admin');
  const base = '/api/tenant/approval/processes';
  const list = await user.send(admin, 'GET', `${base}?pageSize=200`);
  const found = (list.items as Json[]).find((row) => row.code === DEMO_TRANSFER_PROCESS_CODE)!;
  const read = async () => user.send(admin, 'GET', `${base}/${String(found.id)}`);
  await user.send(admin, 'POST', `${base}/${String(found.id)}/versions`, undefined, Number((await read()).revision));
  const node = (key: string, name: string, approver: string) => ({
    key,
    name,
    approver,
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

describe('F-025 演示种子：默认流程上用户接管后，续跑不再动这张单（DEC-477）', () => {
  it('催办（发起人）/ 驳回后重提 / 管理员转交后续跑：保持用户操作后的状态，无新增日志；记入接管后永久跳过', async () => {
    const handle = await createTestDb();
    const dir = mkdtempSync(join(tmpdir(), 'italent-seed-takeover-'));
    try {
      // DEMO-TRF-13（驳回，员工甲本人发起）创建后中断：员工甲催办
      await expect(seedDemo(handle.db, stopAfter('DEMO-TRF-13'))).rejects.toThrow('DEMO-TRF-13 之后');
      const user = await actors(handle.db);
      const employeeA = await user.persona('employeeA');
      const urged = await user.instanceOf('DEMO-TRF-13');
      await user.send(employeeA, 'POST', `/api/tenant/approval/instances/${urged.id}/urge`, {}, urged.revision);
      const after13 = await user.snapshot('DEMO-TRF-13');

      // DEMO-TRF-14（驳回，HR 发起）创建后中断：平台研发部经理驳回，HR 在申请单上重提（同一实例 round + 1）
      await expect(seedDemo(handle.db, stopAfter('DEMO-TRF-14'))).rejects.toThrow('DEMO-TRF-14 之后');
      const admin = await user.persona('admin');
      const hr = await user.persona('hr');
      const platformManager = await user.persona('platformManager');
      const rejected = await user.pendingTask('DEMO-TRF-14');
      await user.send(
        platformManager,
        'POST',
        `/api/tenant/approval/tasks/${rejected.task.id}/reject`,
        { comment: '演示：请补充' },
        rejected.instance.revision,
      );
      const businessPath = `/api/tenant/employment/businesses/${await user.businessOf('DEMO-TRF-14')}`;
      const business = await user.send(hr, 'GET', businessPath);
      await user.send(hr, 'POST', `${businessPath}/submit`, {}, Number(business.revision));
      const after14 = await user.snapshot('DEMO-TRF-14');
      expect(after14.instances).toHaveLength(1);
      expect(after14.instances[0]!.round).toBe(2);

      // DEMO-TRF-15（撤回）创建后中断：系统管理员把待办转交平台研发部经理（审查复现 1）
      await expect(seedDemo(handle.db, stopAfter('DEMO-TRF-15'))).rejects.toThrow('DEMO-TRF-15 之后');
      const transfer = await user.pendingTask('DEMO-TRF-15');
      await user.send(
        admin,
        'POST',
        `/api/tenant/approval/instances/${transfer.instance.id}/admin-transfer`,
        { taskId: transfer.task.id, toUserId: platformManager, reason: '演示：转交' },
        transfer.instance.revision,
      );
      const after15 = await user.snapshot('DEMO-TRF-15');
      expect([after13.status, after14.status, after15.status]).toEqual(['in_review', 'in_review', 'in_review']);

      // 无完成记录续跑到底：三张单原样不动
      await seedDemo(handle.db, options);
      expect(await user.snapshot('DEMO-TRF-13')).toEqual(after13);
      expect(await user.snapshot('DEMO-TRF-14')).toEqual(after14);
      expect(await user.snapshot('DEMO-TRF-15')).toEqual(after15);

      // 带状态文件再跑：判定为已接管并记入文件，之后整体跳过
      const file = join(dir, 'seed-state.json');
      await seedDemo(handle.db, { ...options, progress: fileProgress(file) });
      const state = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { takenOver?: string[] }>;
      expect(state[user.tenantId]!.takenOver).toEqual(['DEMO-TRF-13', 'DEMO-TRF-14', 'DEMO-TRF-15']);
      let steps = 0;
      await seedDemo(handle.db, { ...options, progress: fileProgress(file), onStep: () => void (steps += 1) });
      expect(steps).toBe(0);
      expect(await user.snapshot('DEMO-TRF-15')).toEqual(after15);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await handle.close();
    }
  });
});

describe('F-025 演示种子：开启节点转交 / 加签后用户接管，续跑不再动这张单（DEC-477）', () => {
  it('管理员干预改派 / 节点转交 / 前加签后续跑：保持用户操作后的状态，无新增日志', async () => {
    const handle = await createTestDb();
    try {
      // 演示流程发布后中断：经公开配置接口打开两个节点的转交与加签
      const published = `${DEMO_TRANSFER_PROCESS_CODE}:publish`;
      await expect(seedDemo(handle.db, stopAfter(published))).rejects.toThrow(`${published} 之后`);
      const user = await actors(handle.db);
      await enableTransferAndAddSign(user);

      // DEMO-TRF-02（在途，预设先过 1 个节点）创建后中断：系统管理员干预，把经理待办改派给数据研发部经理
      await expect(seedDemo(handle.db, stopAfter('DEMO-TRF-02'))).rejects.toThrow('DEMO-TRF-02 之后');
      const admin = await user.persona('admin');
      const platformManager = await user.persona('platformManager');
      const dataManager = await user.persona('dataManager');
      const intervene = await user.pendingTask('DEMO-TRF-02');
      await user.send(
        admin,
        'POST',
        `/api/tenant/approval/instances/${intervene.instance.id}/admin-intervene`,
        { kind: 'reassign', taskId: intervene.task.id, toUserId: dataManager, reason: '演示：改派' },
        intervene.instance.revision,
      );
      const after02 = await user.snapshot('DEMO-TRF-02');
      expect(after02.status).toBe('in_review');

      // DEMO-TRF-14（驳回）创建后中断：平台研发部经理把待办转交数据研发部经理（审查复现 2）
      await expect(seedDemo(handle.db, stopAfter('DEMO-TRF-14'))).rejects.toThrow('DEMO-TRF-14 之后');
      const transfer = await user.pendingTask('DEMO-TRF-14');
      await user.send(
        platformManager,
        'POST',
        `/api/tenant/approval/tasks/${transfer.task.id}/transfer`,
        { toUserId: dataManager, comment: '演示：转交' },
        transfer.instance.revision,
      );
      const after14 = await user.snapshot('DEMO-TRF-14');

      // DEMO-TRF-15（撤回）创建后中断：数据研发部经理前加签平台研发部经理（审查复现 3）
      await expect(seedDemo(handle.db, stopAfter('DEMO-TRF-15'))).rejects.toThrow('DEMO-TRF-15 之后');
      const addSign = await user.pendingTask('DEMO-TRF-15');
      await user.send(
        dataManager,
        'POST',
        `/api/tenant/approval/tasks/${addSign.task.id}/add-sign`,
        { userIds: [platformManager], type: 'before', comment: '演示：前加签' },
        addSign.instance.revision,
      );
      const after15 = await user.snapshot('DEMO-TRF-15');
      expect([after14.status, after15.status]).toEqual(['in_review', 'in_review']);

      // 无完成记录续跑到底，再跑一遍：三张单都原样不动
      for (let run = 0; run < 2; run += 1) {
        await seedDemo(handle.db, options);
        expect(await user.snapshot('DEMO-TRF-02')).toEqual(after02);
        expect(await user.snapshot('DEMO-TRF-14')).toEqual(after14);
        expect(await user.snapshot('DEMO-TRF-15')).toEqual(after15);
      }
    } finally {
      await handle.close();
    }
  });
});
