/**
 * F-025 演示种子：接管判定与写入之间不留窗口（DEC-477，#309 第 5 轮）。
 * 可控调度：种子读完某场景的接管观测（查该场景步骤台账的那次读取）、事务提交之后，在它继续读业务单并写入之前，
 * 插入一次用户操作。种子随后不得审批 / 驳回 / 撤回这张单：业务单、审批实例、待办与步骤台账都保持用户操作后的样子，
 * 种子正常跑完，并把这张单记为已接管。设了 TEST_DATABASE_URL 时在真 PostgreSQL 上跑。
 */
import { createTestDb } from '@italent/testkit';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEMO_TRANSFER_PROCESS_CODE } from '../../apps/api/src/demo/data.js';
import { fileProgress, seedDemo } from '../../apps/api/src/demo/seed.js';
import { actors, enableTransferAndAddSign, options, stopAfter, type TestDb } from './support/demo-seed.js';

vi.setConfig({ testTimeout: 900_000 });

type Actors = Awaited<ReturnType<typeof actors>>;
type Hook = (user: Actors) => Promise<void>;
type Observed = { snapshot: unknown; steps: string[] };

const STEP_QUERY = /^demo-seed-step:(DEMO-TRF-\d+):%$/;

/** 语句里是否带着“查某场景步骤台账”的参数（接管观测的标志），带着就返回场景编号。 */
function observedScenario(statement: unknown): string | undefined {
  const chunks = (statement as { queryChunks?: unknown[] }).queryChunks ?? [];
  for (const chunk of chunks) {
    const match = typeof chunk === 'string' ? STEP_QUERY.exec(chunk) : null;
    if (match) return match[1];
  }
  return undefined;
}

const bound = (target: object, prop: string | symbol): unknown => {
  const value: unknown = Reflect.get(target, prop);
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
};

/**
 * 给种子用的库：某场景的接管观测事务提交后，先执行该场景的钩子（每个场景一次）再把控制权交还种子。
 * 钩子里的用户操作走测试自己的接口（原始库），与种子的后续读写真正交错。
 */
function interleaving(db: TestDb, hooks: Map<string, Hook>, after: Map<string, Observed>): TestDb {
  let user: Actors | undefined;
  const watch = (tx: object, seen: { scenario?: string }) =>
    new Proxy(tx, {
      get(target, prop) {
        if (prop !== 'execute') return bound(target, prop);
        const execute = bound(target, prop) as (statement: unknown) => Promise<unknown>;
        return (statement: unknown) => {
          seen.scenario ??= observedScenario(statement);
          return execute(statement);
        };
      },
    });
  return new Proxy(db, {
    get(target, prop) {
      if (prop !== 'transaction') return bound(target, prop);
      const transaction = bound(target, prop) as (fn: (tx: object) => Promise<unknown>, config?: unknown) => unknown;
      return async (fn: (tx: object) => Promise<unknown>, config?: unknown) => {
        const seen: { scenario?: string } = {};
        const result = await transaction((tx) => fn(watch(tx, seen)), config);
        const hook = seen.scenario ? hooks.get(seen.scenario) : undefined;
        if (hook && seen.scenario) {
          hooks.delete(seen.scenario);
          user ??= await actors(db);
          await hook(user);
          after.set(seen.scenario, {
            snapshot: await user.snapshot(seen.scenario),
            steps: await user.steps(seen.scenario),
          });
        }
        return result;
      };
    },
  }) as TestDb;
}

/** 按场景断言：用户操作后的样子原样保留，种子没有新增步骤台账，并记为已接管。 */
async function expectUntouched(db: TestDb, after: Map<string, Observed>, file: string, scenarios: string[]) {
  const user = await actors(db);
  expect([...after.keys()].sort()).toEqual(scenarios);
  for (const scenario of scenarios) {
    expect.soft(await user.snapshot(scenario), scenario).toEqual(after.get(scenario)!.snapshot);
    expect.soft(await user.steps(scenario), scenario).toEqual(after.get(scenario)!.steps);
  }
  const state = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { takenOver?: string[] }>;
  expect(state[user.tenantId]!.takenOver).toEqual(scenarios);
}

/** 插入用户操作的各场景钩子（每个场景在种子第一次观测它之后执行一次）。 */
const HOOKS: Record<string, Hook> = {
  // DEMO-TRF-02（在途，种子要审批第一节点）：系统管理员干预，把经理待办改派给数据研发部经理
  interveneTrf02: async (user) => {
    const { instance, task } = await user.pendingTask('DEMO-TRF-02');
    const path = `/api/tenant/approval/instances/${instance.id}/admin-intervene`;
    const dataManager = await user.persona('dataManager');
    const body = { kind: 'reassign', taskId: task.id, toUserId: dataManager, reason: '演示：改派' };
    await user.send(await user.persona('admin'), 'POST', path, body, instance.revision);
  },
  // DEMO-TRF-13（种子要驳回）：发起人员工甲催办（催办不改审批实例 revision）
  urgeTrf13: async (user) => {
    const instance = await user.instanceOf('DEMO-TRF-13');
    const path = `/api/tenant/approval/instances/${instance.id}/urge`;
    await user.send(await user.persona('employeeA'), 'POST', path, {}, instance.revision);
  },
  // DEMO-TRF-14（种子要驳回）：平台研发部经理自己审批通过第一节点
  approveTrf14: async (user) => {
    const { instance, task } = await user.pendingTask('DEMO-TRF-14');
    const path = `/api/tenant/approval/tasks/${task.id}/approve`;
    await user.send(await user.persona('platformManager'), 'POST', path, {}, instance.revision);
  },
  // DEMO-TRF-14（种子要驳回）：平台研发部经理前加签数据研发部经理（需打开加签）
  addSignTrf14: async (user) => {
    const { instance, task } = await user.pendingTask('DEMO-TRF-14');
    const body = { userIds: [await user.persona('dataManager')], type: 'before', comment: '演示：前加签' };
    const path = `/api/tenant/approval/tasks/${task.id}/add-sign`;
    await user.send(await user.persona('platformManager'), 'POST', path, body, instance.revision);
  },
  // DEMO-TRF-15（种子要撤回）：系统管理员把待办转交平台研发部经理（第 4 轮审查复现）
  adminTransferTrf15: async (user) => {
    const { instance, task } = await user.pendingTask('DEMO-TRF-15');
    const path = `/api/tenant/approval/instances/${instance.id}/admin-transfer`;
    const body = { taskId: task.id, toUserId: await user.persona('platformManager'), reason: '演示：转交' };
    await user.send(await user.persona('admin'), 'POST', path, body, instance.revision);
  },
  // DEMO-TRF-15（种子要撤回）：数据研发部经理把待办节点转交平台研发部经理（需打开转交）
  transferTrf15: async (user) => {
    const { instance, task } = await user.pendingTask('DEMO-TRF-15');
    const body = { toUserId: await user.persona('platformManager'), comment: '演示：转交' };
    const path = `/api/tenant/approval/tasks/${task.id}/transfer`;
    await user.send(await user.persona('dataManager'), 'POST', path, body, instance.revision);
  },
};

/** 整份种子跑一遍，按场景插入用户操作；之后不带状态文件再跑一遍，两次都断言原样不动。 */
async function race(hooks: Record<string, Hook>, enableActions = false) {
  const handle = await createTestDb();
  const dir = mkdtempSync(join(tmpdir(), 'italent-seed-race-'));
  try {
    if (enableActions) {
      const published = `${DEMO_TRANSFER_PROCESS_CODE}:publish`;
      await expect(seedDemo(handle.db, stopAfter(published))).rejects.toThrow(`${published} 之后`);
      await enableTransferAndAddSign(await actors(handle.db));
    }
    const after = new Map<string, Observed>();
    const scenarios = Object.keys(hooks).sort();
    const file = join(dir, 'seed-state.json');
    await seedDemo(interleaving(handle.db, new Map(Object.entries(hooks)), after), {
      ...options,
      progress: fileProgress(file),
    });
    await expectUntouched(handle.db, after, file, scenarios);
    await seedDemo(handle.db, options);
    await expectUntouched(handle.db, after, file, scenarios);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await handle.close();
  }
}

describe('F-025 演示种子：观测后、写入前用户接管，种子不再写这张单（DEC-477）', () => {
  it('默认流程：催办 / 管理员转交插在观测与写入之间——不驳回、不撤回', () =>
    race({ 'DEMO-TRF-13': HOOKS.urgeTrf13!, 'DEMO-TRF-15': HOOKS.adminTransferTrf15! }));

  it('默认流程：管理员干预改派 / 用户审批插在观测与写入之间——不审批、不驳回，种子正常跑完', () =>
    race({ 'DEMO-TRF-02': HOOKS.interveneTrf02!, 'DEMO-TRF-14': HOOKS.approveTrf14! }));

  it('开启节点转交 / 加签：前加签 / 节点转交插在观测与写入之间——不驳回、不撤回', () =>
    race({ 'DEMO-TRF-14': HOOKS.addSignTrf14!, 'DEMO-TRF-15': HOOKS.transferTrf15! }, true));
});
