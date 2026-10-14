/**
 * F-025 演示种子（含演示数据种子第 1 段：R1 规模化，规划 §5）：
 * - 规模：约 30 个组织（4 层）、约 200 名员工、职务体系、在途 / 已完成 / 驳回 / 撤回的调动审批单；
 * - 幂等、可恢复：先在员工阶段、再在调动阶段中途注入失败，之后重复运行补齐缺失、不重复；跑完后再运行不写数据；
 * - 原有 9 名演示身份及其组织 / 职位 / 角色不变，各身份的“我的申请 / 待办”有数据；
 * - 种子配置足以让 R1 调动主线各角色入口真实可用（真实授权器，不注入“全部允许”）：
 *   员工本人发起 → 直接上级审批 → HRBP 审核 → 生效 → 员工 / 经理 / HR / 审计可见（本文件最后一个用例，会改动员工甲）。
 * 整个文件只种一次租户（含两次注入失败后的续做），以控制耗时。
 */
import {
  approvalProcesses,
  employmentEmployees,
  eq,
  orgObjects,
  sql,
  tenants,
  users,
  withPlatform,
  withTenant,
} from '@italent/db';
import { createTestDb, useTestDb } from '@italent/testkit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DEMO_ORGS, DEMO_PEOPLE, DEMO_POSITIONS, ROLE_LABELS } from '../../apps/api/src/demo/data.js';
import { fileProgress, type DemoManifest, memoryProgress, seedDemo } from '../../apps/api/src/demo/seed.js';
import { DEMO_TRANSFERS } from '../../apps/api/src/demo/transfers.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
// 整份种子 200 名员工 + 15 张调动单，读取断言也要经完整授权，放宽单个用例的超时
vi.setConfig({ testTimeout: 300_000 });
const TODAY = '2026-10-07';
const clock = () => new Date(`${TODAY}T02:00:00.000Z`);
const options = { clock, nodeEnv: 'test' } as const;

type Row = Record<string, unknown> & { id: string };

let manifest: DemoManifest;
let api: ReturnType<typeof tenantApi>;
const personaId = (key: string) => {
  const name = DEMO_PEOPLE.find((p) => p.key === key)!.name;
  return manifest.personas.find((p) => p.name === name)!.userId;
};
const as = (key: string) => ({ user: personaId(key), tenant: manifest.tenantId });

async function json<T = Record<string, unknown>>(key: string, path: string): Promise<T> {
  const response = await api.request('GET', path, as(key));
  expect(response.status, `${key} ${path} ${await response.clone().text()}`).toBe(200);
  return (await response.json()) as T;
}

async function items(key: string, path: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const body = await json<{ items: Row[] }>(key, `${path}${separator}page=${page}&pageSize=200`);
    rows.push(...body.items);
    if (body.items.length < 200) return rows;
  }
}

const rowsOf = <T>(result: unknown): T[] =>
  (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];

/** 库内的原始计数与自然键（只读观测，不经权限）：用于幂等 / 恢复的比较。 */
async function inventory() {
  const db = database().db;
  const [tenant] = await withPlatform(db, (tx) => tx.select().from(tenants).where(eq(tenants.code, 'demo-r1')));
  const tenantId = tenant!.id;
  // 单连接的 PGlite 不能在租户事务里再开平台事务：平台侧的计数放在外面取
  const global = {
    tenants: (await withPlatform(db, (tx) => tx.select().from(tenants))).length,
    users: (await withPlatform(db, (tx) => tx.select().from(users))).length,
  };
  return withTenant(db, tenantId, async (tx) => {
    const employees = await tx.select().from(employmentEmployees);
    const orgs = await tx.select().from(orgObjects);
    const grouped = rowsOf<{ employeeId: string; kind: string; n: number }>(
      await tx.execute(sql`SELECT employee_id AS "employeeId", kind, count(DISTINCT business_id)::int AS n
        FROM employment_payload_versions GROUP BY employee_id, kind`),
    );
    return {
      ...global,
      processes: (await tx.select().from(approvalProcesses)).length,
      employeeCodes: employees.map((e) => e.code).sort(),
      employeeIds: employees.map((e) => e.id).sort(),
      orgIds: orgs.map((o) => o.id).sort(),
      hires: grouped.filter((g) => g.kind === 'hire').map((g) => g.n),
      transferBusinesses: grouped.filter((g) => g.kind === 'transfer').reduce((sum, g) => sum + g.n, 0),
      seededBusinesses: rowsOf<{ n: number }>(
        await tx.execute(
          sql`SELECT count(*)::int AS n FROM command_ledger WHERE command_id LIKE 'demo-seed:%:DEMO-TRF-%'`,
        ),
      )[0]!.n,
    };
  });
}

let ordinaryBusinessId = '';
/** 员工甲用公开本人入口提交的普通调动申请（不是种子场景）：续跑和后续启动都不得接管它。 */
async function submitOrdinaryApplication() {
  const db = database().db;
  const [tenant] = await withPlatform(db, (tx) => tx.select().from(tenants).where(eq(tenants.code, 'demo-r1')));
  const userOf = async (key: string) => {
    const email = DEMO_PEOPLE.find((p) => p.key === key)!.email;
    const [row] = await withPlatform(db, (tx) => tx.select().from(users).where(eq(users.email, email)));
    return { user: row!.id, tenant: tenant!.id };
  };
  const early = tenantApi(db, { authorize: undefined, clock });
  const read = async <T>(key: string, path: string): Promise<T> => {
    const response = await early.request('GET', path, await userOf(key));
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as T;
  };
  const orgs = await read<{ items: Row[] }>('hr', `/api/tenant/org/organizations?asOf=${TODAY}&pageSize=200`);
  const frontend = orgs.items.find((org) => org.name === '前端开发组')!;
  const profile = await read<{ employee: { revision: number } }>('employeeA', '/api/tenant/self-service/profile');
  const response = await early.request('POST', '/api/tenant/self-service/transfer', {
    ...(await userOf('employeeA')),
    ifMatch: profile.employee.revision,
    body: { effectiveDate: '2026-11-06', fields: { departmentId: frontend.id } },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  ordinaryBusinessId = ((await response.json()) as { id: string }).id;
}

describe('F-025 演示种子', () => {
  beforeAll(async () => {
    // 第 1 次：员工阶段写到第 57 个时失败（续做见下）；最后一次补齐
    let employees = 0;
    await expect(
      seedDemo(database().db, {
        ...options,
        onStep: ({ phase }) => {
          if (phase === 'employees' && (employees += 1) === 57) throw new Error('注入的员工阶段失败');
        },
      }),
    ).rejects.toThrow('注入的员工阶段失败');
    // 第 2 次：调动流程发布完、还没发起任何场景时中断；此时员工甲在公开本人入口自己提交了一张普通申请
    let published = 0;
    await expect(
      seedDemo(database().db, {
        ...options,
        onStep: ({ phase }) => {
          if (phase === 'transfers' && (published += 1) === 2) throw new Error('注入的流程发布后失败');
        },
      }),
    ).rejects.toThrow('注入的流程发布后失败');
    await submitOrdinaryApplication();
    // 第 3 次：续做到第 5 步时再次失败
    let transfers = 0;
    await expect(
      seedDemo(database().db, {
        ...options,
        onStep: ({ phase }) => {
          if (phase === 'transfers' && (transfers += 1) === 5) throw new Error('注入的调动阶段失败');
        },
      }),
    ).rejects.toThrow('注入的调动阶段失败');
    const resumed = await seedDemo(database().db, options);
    expect(resumed.created).toBe(true);
    manifest = resumed.manifest;
    api = tenantApi(database().db, { authorize: undefined, clock });
  }, 900_000);

  it('组织 ≥30 个且 4 层、职务体系条目齐全、员工约 200 名，中途失败续做后无重复', async () => {
    const inv = await inventory();
    expect(inv.employeeCodes).toHaveLength(new Set(inv.employeeCodes).size);
    expect(
      inv.hires.every((n) => n === 1),
      '每名员工恰有一次入职',
    ).toBe(true);
    // 15 张种子调动单（命令台账里有各自的确定性命令 ID）+ 续跑前用户自己提交的 1 张普通申请（不属于种子，也不被种子接管）
    expect(inv.seededBusinesses).toBe(15);
    expect(inv.transferBusinesses).toBe(16);
    const orgs = await items('hr', `/api/tenant/org/organizations?asOf=${TODAY}`);
    expect(orgs.length).toBeGreaterThanOrEqual(30);
    const parentOf = new Map(
      orgs.map((org) => [org.id, (org.parents as { admin: { parentId: string } }).admin.parentId] as const),
    );
    const depth = (id: string): number => (id === manifest.tenantId ? 0 : 1 + depth(parentOf.get(id)!));
    // 租户根（集团）→ 事业部 → 部门 → 小组：含根共 4 层
    expect(Math.max(...orgs.map((org) => depth(org.id)))).toBe(3);
    for (const org of orgs) {
      expect(org.code).toMatch(/^DEMO-ORG-\d{3}$/);
      expect(String(org.establishedOn) <= '2025-10-07', '设立日期早于演示当天至少一年').toBe(true);
      expect(org.personInChargeId, `${org.name} 应有负责人`).toBeTruthy();
    }

    const count = async (kind: string) => (await items('admin', `/api/tenant/job/${kind}`)).length;
    expect(await count('layers')).toBeGreaterThanOrEqual(3);
    expect(await count('grades')).toBeGreaterThanOrEqual(9);
    expect(await count('level-types')).toBeGreaterThanOrEqual(2);
    expect(await count('levels')).toBeGreaterThanOrEqual(9);
    expect(await count('sequences')).toBeGreaterThanOrEqual(4);
    expect(await count('sequences')).toBeLessThanOrEqual(6);
    expect(await count('posts')).toBeGreaterThanOrEqual(20);
    const positions = await items('admin', '/api/tenant/job/positions');
    const leaves = orgs.filter((org) => !orgs.some((other) => parentOf.get(other.id) === org.id));
    for (const leaf of leaves) {
      const own = positions.filter((position) => position.orgId === leaf.id).length;
      expect(own, `${leaf.name} 的职位数`).toBeGreaterThanOrEqual(1);
      expect(own, `${leaf.name} 的职位数`).toBeLessThanOrEqual(3);
    }

    const employees = await items('admin', '/api/tenant/employment/employees');
    expect(employees.length).toBeGreaterThanOrEqual(190);
    expect(employees.length).toBeLessThanOrEqual(210);
    expect(employees.every((employee) => employee.status === 'employed')).toBe(true);
  });

  it('调动单：在途 6 / 已完成 6 / 驳回 2 / 撤回 1，HR、经理、员工自助各至少 1 单', async () => {
    const ids = await withTenant(database().db, manifest.tenantId, async (tx) => {
      const result = await tx.execute(
        sql`SELECT response_body->>'id' AS id FROM command_ledger WHERE command_id LIKE 'demo-seed:%:DEMO-TRF-%'`,
      );
      return ((Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { id: string }[]).map(
        (row) => row.id,
      );
    });
    const states: Record<string, number> = {};
    for (const id of ids) {
      const business = await json<{ status: string }>('hr', `/api/tenant/employment/businesses/${id}`);
      states[business.status] = (states[business.status] ?? 0) + 1;
    }
    expect(states).toEqual({ in_review: 6, effective: 6, rejected: 2, draft: 1 });

    // 三种发起方都有单：HR（hr）、经理（platformManager）、员工自助（employeeB）
    for (const key of ['hr', 'platformManager', 'employeeB']) {
      const mine = await items(key, '/api/tenant/approval/instances?role=initiated');
      expect(mine.length, `${key} 发起的单`).toBeGreaterThan(0);
    }
    // 在途单停在不同审批步：经理待办是第一节点，HR 待办是第二节点
    const nodes = new Set<string>();
    for (const key of ['platformManager', 'dataManager', 'hr', 'exception']) {
      for (const todo of await items(key, '/api/tenant/approval/todos')) nodes.add(String(todo.nodeKey));
    }
    expect([...nodes].sort()).toEqual(['direct_head', 'in_hrbp']);
  });

  it('9 名演示身份及其组织 / 职位 / 角色不变', async () => {
    expect(manifest.personas.map((p) => [p.name, p.role])).toEqual(
      DEMO_PEOPLE.map((p) => [p.name, ROLE_LABELS[p.role]]),
    );
    const orgs = await items('hr', `/api/tenant/org/organizations?asOf=${TODAY}`);
    const positions = await items('admin', '/api/tenant/job/positions');
    const index = DEMO_PEOPLE.filter((p) => p.job);
    for (const [i, person] of index.entries()) {
      const code = `DEMO${String(i + 1).padStart(3, '0')}`;
      const [employee] = await items('hr', `/api/tenant/employment/employees?code=${code}`);
      const records = await json<{ items: { isCurrent: boolean; fields: Record<string, string | null> }[] }>(
        'hr',
        `/api/tenant/employment/employees/${employee!.id}/records?asOf=${TODAY}`,
      );
      const current = records.items.find((record) => record.isCurrent)!;
      const expectedOrg = DEMO_ORGS.find((org) => org.key === person.job!.org)!;
      expect(orgs.find((org) => org.id === current.fields.departmentId)?.name, person.name).toBe(expectedOrg.name);
      const expectedPosition = DEMO_POSITIONS.find((position) => position.key === person.job!.position);
      const positionName = positions.find((position) => position.id === current.fields.positionId)?.name;
      expect(positionName ?? null, person.name).toBe(expectedPosition?.name ?? null);
    }
  });

  it('各演示身份的“我的申请 / 待办”非空', async () => {
    // 员工自助与审计管理员：我发起的
    for (const key of ['employeeA', 'employeeB', 'employeeC', 'auditor']) {
      expect((await items(key, '/api/tenant/approval/instances?role=initiated')).length, key).toBeGreaterThan(0);
    }
    // 经理、HR：待办（审批中心）与已办 / 我发起
    for (const key of ['platformManager', 'dataManager', 'hr']) {
      expect((await items(key, '/api/tenant/approval/todos')).length, `${key} 待办`).toBeGreaterThan(0);
      expect(
        (await items(key, '/api/tenant/approval/instances?role=participated')).length,
        `${key} 已办`,
      ).toBeGreaterThan(0);
      expect(
        (await items(key, '/api/tenant/approval/instances?role=initiated')).length,
        `${key} 我发起`,
      ).toBeGreaterThan(0);
    }
    // 异常管理员接收审批人为空 / 自审回避转来的节点
    expect((await items('exception', '/api/tenant/approval/todos')).length, 'exception 待办').toBeGreaterThan(0);
    // 经理工作台：待处理 / 已处理 / 我发起
    for (const tab of ['pending', 'processed', 'initiated']) {
      const tabs = await json<{ items: unknown[] }>(
        'platformManager',
        `/api/tenant/employment/transfers/manager/todos?tab=${tab}`,
      );
      expect(tabs.items.length, `经理工作台 ${tab}`).toBeGreaterThan(0);
    }
  });

  it('连续运行：不写数据，计数与关键对象 ID 稳定', async () => {
    const before = await inventory();
    const orgsBefore = (await items('hr', `/api/tenant/org/organizations?asOf=${TODAY}`)).map((o) => [o.code, o.id]);
    const again = await seedDemo(database().db, options);
    expect(again.created).toBe(false);
    expect(again.manifest).toEqual(manifest);
    expect(await inventory()).toEqual(before);
    expect((await items('hr', `/api/tenant/org/organizations?asOf=${TODAY}`)).map((o) => [o.code, o.id])).toEqual(
      orgsBefore,
    );
    expect(before.employeeCodes).toHaveLength(200);
  });

  it('角色齐全，且全部是合成数据（example.com 邮箱、带“演示”字样）', () => {
    const roles = new Set(manifest.personas.map((p) => p.role));
    for (const role of ['系统管理员', 'HR（HRBP）', '部门负责人（经理）', '普通员工', '审计管理员']) {
      expect(roles).toContain(role);
    }
    for (const person of DEMO_PEOPLE) {
      expect(person.email).toMatch(/^demo\.[a-z.]+@example\.com$/);
      expect(person.name).toContain('演示');
    }
  });

  it('续跑不接管不是种子发起的普通申请：员工甲自己提交的申请保持审批中，种子另发自己的驳回单', async () => {
    const ordinary = await json<{ status: string }>('hr', `/api/tenant/employment/businesses/${ordinaryBusinessId}`);
    expect(ordinary.status).toBe('in_review');
    const marked = rowsOf<{ id: string }>(
      await withTenant(database().db, manifest.tenantId, (tx) =>
        tx.execute(
          sql`SELECT response_body->>'id' AS id FROM command_ledger WHERE command_id LIKE 'demo-seed:%:DEMO-TRF-13'`,
        ),
      ),
    );
    expect(marked).toHaveLength(1);
    expect(marked[0]!.id).not.toBe(ordinaryBusinessId);
    expect((await json<{ status: string }>('hr', `/api/tenant/employment/businesses/${marked[0]!.id}`)).status).toBe(
      'rejected',
    );
  });

  it('已完成的种子场景被用户改动后再启动种子：判定为用户接管、不回退（无进度记录每次判定，有进度记录整体跳过）', async () => {
    const [withdrawn] = rowsOf<{ id: string }>(
      await withTenant(database().db, manifest.tenantId, (tx) =>
        tx.execute(
          sql`SELECT response_body->>'id' AS id FROM command_ledger WHERE command_id LIKE 'demo-seed:%:DEMO-TRF-15'`,
        ),
      ),
    );
    const statusOf = async () =>
      (await json<{ status: string }>('hr', `/api/tenant/employment/businesses/${withdrawn!.id}`)).status;
    expect(await statusOf()).toBe('draft');
    // HR 把种子里已撤回的草稿重新提交
    const business = await json<{ revision: number }>('hr', `/api/tenant/employment/businesses/${withdrawn!.id}`);
    const resubmitted = await api.request('POST', `/api/tenant/employment/businesses/${withdrawn!.id}/submit`, {
      ...as('hr'),
      ifMatch: business.revision,
      body: {},
    });
    expect(resubmitted.status, await resubmitted.clone().text()).toBe(200);
    expect(await statusOf()).toBe('in_review');

    // 没有进度记录：HR 重提是种子台账外的操作，判定为用户接管，不再撤回（DEC-477）
    expect((await seedDemo(database().db, options)).created).toBe(false);
    expect(await statusOf()).toBe('in_review');
    // 有进度记录：同样不回退；其余场景记为已完成，DEMO-TRF-15 记为已接管
    const progress = memoryProgress();
    expect((await seedDemo(database().db, { ...options, progress })).created).toBe(false);
    expect(await statusOf()).toBe('in_review');
    const takenOver = await progress.takenOverTransfers(manifest.tenantId);
    expect(takenOver).toEqual(new Set(['DEMO-TRF-15']));
    expect(new Set([...(await progress.completedTransfers(manifest.tenantId)), ...takenOver])).toEqual(
      new Set(DEMO_TRANSFERS.map((s) => s.id)),
    );
    // 重提后又被经理审批通过第一节点：再跑种子（无进度记录，重新判定）也不撤回
    const todos = await json<{ items: { taskId: string; instanceId: string }[] }>(
      'dataManager',
      '/api/tenant/approval/todos',
    );
    const resubmittedInstance = await json<{ items: { id: string }[] }>(
      'hr',
      `/api/tenant/approval/instances?role=initiated&businessId=${withdrawn!.id}`,
    );
    const live = resubmittedInstance.items.map((item) => item.id);
    const todo = todos.items.find((item) => live.includes(item.instanceId))!;
    const instance = await json<{ revision: number }>(
      'dataManager',
      `/api/tenant/approval/instances/${todo.instanceId}`,
    );
    const approved = await api.request('POST', `/api/tenant/approval/tasks/${todo.taskId}/approve`, {
      ...as('dataManager'),
      ifMatch: instance.revision,
      body: {},
    });
    expect(approved.status, await approved.clone().text()).toBeLessThan(300);
    expect((await seedDemo(database().db, options)).created).toBe(false);
    expect(await statusOf()).toBe('in_review');
    // 全部场景都已完成或被接管：调动阶段整体跳过
    let steps = 0;
    await seedDemo(database().db, { ...options, progress, onStep: () => void (steps += 1) });
    expect(steps).toBe(0);
    expect(await statusOf()).toBe('in_review');
  });

  it('R1 主线：员工本人发起 → 经理审批 → HRBP 审核 → 当日生效，员工 / 经理 / HR / 审计侧可见', async () => {
    const api = tenantApi(database().db, { authorize: undefined, clock });
    const user = (key: string) => {
      const email = DEMO_PEOPLE.find((p) => p.key === key)!.email;
      const name = DEMO_PEOPLE.find((p) => p.email === email)!.name;
      return { user: manifest.personas.find((p) => p.name === name)!.userId, tenant: manifest.tenantId };
    };
    const json = async <T>(response: Response, status = 200): Promise<T> => {
      expect(response.status, await response.clone().text()).toBe(status);
      return (await response.json()) as T;
    };
    const employee = user('employeeA');
    const manager = user('platformManager');
    const hr = user('hr');

    // 员工自助：看到本人档案，向前端开发组发起调动（本人入口固定提交审批）
    const profile = await json<{ employee: { id: string; revision: number } }>(
      await api.request('GET', '/api/tenant/self-service/profile', employee),
    );
    const orgs = await json<{ items: { id: string; name: string }[] }>(
      await api.request('GET', `/api/tenant/org/organizations?asOf=${TODAY}&pageSize=200`, hr),
    );
    const frontend = orgs.items.find((org) => org.name === '前端开发组')!;
    const submitted = await json<{ id: string; status: string }>(
      await api.request('POST', '/api/tenant/self-service/transfer', {
        ...employee,
        ifMatch: profile.employee.revision,
        body: { effectiveDate: TODAY, fields: { departmentId: frontend.id } },
      }),
      201,
    );
    expect(submitted.status).toBe('in_review');

    // 种子里已有若干在途调动：待办里按本单对应的实例找，不假设待办只有一条
    const initiated = await json<{ items: { id: string }[] }>(
      await api.request('GET', `/api/tenant/approval/instances?role=initiated&businessId=${submitted.id}`, employee),
    );
    const instanceId = initiated.items[0]!.id;
    const pending = await json<{ items: { instanceId: string }[] }>(
      await api.request('GET', '/api/tenant/employment/transfers/manager/todos?tab=pending', manager),
    );
    expect(pending.items.map((item) => item.instanceId)).toContain(instanceId);

    // 审批中心：直接上级（部门负责人）→ 调入部门 HRBP，各自只在自己的待办里看到本单
    for (const approver of [manager, hr]) {
      const todos = await json<{ items: { taskId: string; instanceId: string }[] }>(
        await api.request('GET', '/api/tenant/approval/todos', approver),
      );
      const todo = todos.items.filter((item) => item.instanceId === instanceId);
      expect(todo).toHaveLength(1);
      const instance = await json<{ revision: number }>(
        await api.request('GET', `/api/tenant/approval/instances/${instanceId}`, approver),
      );
      await json(
        await api.request('POST', `/api/tenant/approval/tasks/${todo[0]!.taskId}/approve`, {
          ...approver,
          ifMatch: instance.revision,
          body: {},
        }),
      );
    }

    // 生效日 = 审批当天：通过即生效；HR 列表与本人任职记录都看到新部门
    const business = await json<{ status: string }>(
      await api.request('GET', `/api/tenant/employment/businesses/${submitted.id}`, hr),
    );
    expect(business.status).toBe('effective');
    const history = await json<{ items: { effectiveDate: string; fields: { departmentId?: string } }[] }>(
      await api.request('GET', `/api/tenant/employment/employees/${profile.employee.id}/records`, hr),
    );
    const latest = history.items.find((record) => record.effectiveDate === TODAY);
    expect(latest?.fields.departmentId).toBe(frontend.id);
    const records = await json<{ items: { fields: Record<string, unknown> }[] }>(
      await api.request('GET', `/api/tenant/self-service/employees/${profile.employee.id}/records`, employee),
    );
    expect(JSON.stringify(records.items)).toContain('前端开发组');

    // 经理工作台：可以发起他人调动，已处理待办里有这张单
    const entry = await json<{ canApply: boolean }>(
      await api.request('GET', '/api/tenant/employment/transfers/manager', manager),
    );
    expect(entry.canApply).toBe(true);
    const processed = await json<{ items: unknown[] }>(
      await api.request('GET', '/api/tenant/employment/transfers/manager/todos?tab=processed', manager),
    );
    expect(processed.items.length).toBeGreaterThan(0);

    // 审计管理员看得到任职变更日志；普通员工没有审计入口
    const audit = await json<{ items: unknown[] }>(
      await api.request('GET', '/api/tenant/audit/data-changes', user('auditor')),
    );
    expect(audit.items.length).toBeGreaterThan(0);
    expect((await api.request('GET', '/api/tenant/audit/data-changes', employee)).status).toBe(403);
  });
});

type TestDb = ReturnType<typeof database>['db'];

/** 第二个独立库上的公开接口调用（演示身份按邮箱取账号）。 */
async function independentActors(db: TestDb) {
  const [tenant] = await withPlatform(db, (tx) => tx.select().from(tenants).where(eq(tenants.code, 'demo-r1')));
  const request = tenantApi(db, { authorize: undefined, clock });
  const who = async (key: string) => {
    const email = DEMO_PEOPLE.find((p) => p.key === key)!.email;
    const [row] = await withPlatform(db, (tx) => tx.select().from(users).where(eq(users.email, email)));
    return { user: row!.id, tenant: tenant!.id };
  };
  const get = async <T>(key: string, path: string): Promise<T> => {
    const response = await request.request('GET', path, await who(key));
    expect(response.status, `${key} ${path} ${await response.clone().text()}`).toBe(200);
    return (await response.json()) as T;
  };
  /** 种子场景发起的业务单 ID（命令台账里的确定性命令 ID）。 */
  const businessOf = async (scenario: string) => {
    const [row] = rowsOf<{ id: string }>(
      await withTenant(db, tenant!.id, (tx) =>
        tx.execute(
          sql`SELECT response_body->>'id' AS id FROM command_ledger WHERE command_id LIKE ${`demo-seed:%:${scenario}`}`,
        ),
      ),
    );
    return row!.id;
  };
  /** 审批人（演示经理）在审批中心同意某张种子单当前的待办节点。 */
  const approveCurrentNode = async (scenario: string, approver: string) => {
    const businessId = await businessOf(scenario);
    const mine = await get<{ items: { id: string }[] }>(
      approver,
      `/api/tenant/approval/instances?role=participated&businessId=${businessId}`,
    );
    const instanceId = mine.items[0]!.id;
    const todos = await get<{ items: { taskId: string; instanceId: string }[] }>(
      approver,
      '/api/tenant/approval/todos',
    );
    const todo = todos.items.find((item) => item.instanceId === instanceId)!;
    const instance = await get<{ revision: number }>(approver, `/api/tenant/approval/instances/${instanceId}`);
    const response = await request.request('POST', `/api/tenant/approval/tasks/${todo.taskId}/approve`, {
      ...(await who(approver)),
      ifMatch: instance.revision,
      body: {},
    });
    expect(response.status, await response.clone().text()).toBeLessThan(300);
  };
  const statusOf = async (scenario: string) =>
    (await get<{ status: string }>('hr', `/api/tenant/employment/businesses/${await businessOf(scenario)}`)).status;
  return { approveCurrentNode, statusOf };
}

describe('F-025 演示种子：中断恢复时用户已经操作过的调动单，不被种子推进或回退', () => {
  it('驳回 / 撤回场景创建后中断，用户已审批通过第一节点（进度超过预设）：续跑不驳回、不撤回', async () => {
    const handle = await createTestDb();
    try {
      const stopAfter = (id: string) => ({
        ...options,
        onStep: ({ phase, key }: { phase: string; key: string }) => {
          if (phase === 'transfers' && key === id) throw new Error(`注入的失败：${id} 创建后`);
        },
      });
      // 第 1 次在 DEMO-TRF-14（驳回）创建后、驳回前中断；平台研发部经理已同意其第一节点
      await expect(seedDemo(handle.db, stopAfter('DEMO-TRF-14'))).rejects.toThrow('DEMO-TRF-14 创建后');
      const user = await independentActors(handle.db);
      await user.approveCurrentNode('DEMO-TRF-14', 'platformManager');
      // 第 2 次在 DEMO-TRF-15（撤回）创建后、撤回前中断；数据研发部经理已同意其第一节点
      await expect(seedDemo(handle.db, stopAfter('DEMO-TRF-15'))).rejects.toThrow('DEMO-TRF-15 创建后');
      await user.approveCurrentNode('DEMO-TRF-15', 'dataManager');
      // 无进度记录续跑到底：两张单都保持用户推进后的状态
      await seedDemo(handle.db, options);
      expect(await user.statusOf('DEMO-TRF-14')).toBe('in_review');
      expect(await user.statusOf('DEMO-TRF-15')).toBe('in_review');
      expect(await user.statusOf('DEMO-TRF-13')).toBe('rejected');
      // 再跑一遍仍不动
      expect((await seedDemo(handle.db, options)).created).toBe(false);
      expect(await user.statusOf('DEMO-TRF-14')).toBe('in_review');
      expect(await user.statusOf('DEMO-TRF-15')).toBe('in_review');
    } finally {
      await handle.close();
    }
  }, 900_000);

  it('状态文件内容结构异常（null / 非对象 / transfers 不是数组 / 含非字符串）：按缺失处理，不抛异常', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'italent-seed-state-'));
    try {
      const file = join(dir, 'seed-state.json');
      const bad = [
        'null',
        '[]',
        '3',
        '"x"',
        '{"t":null}',
        '{"t":3}',
        '{"t":{"transfers":3}}',
        '{"t":{"transfers":"a"}}',
      ];
      for (const text of [...bad, '{"t":{"transfers":[1,null]}}', '{']) {
        writeFileSync(file, text);
        const progress = fileProgress(file);
        expect([...(await progress.completedTransfers('t'))], text).toEqual([]);
        // 之后的写入仍可用，并把坏内容替换掉
        await progress.markTransferCompleted('t', 'DEMO-TRF-01');
        expect([...(await fileProgress(file).completedTransfers('t'))], text).toEqual(['DEMO-TRF-01']);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
