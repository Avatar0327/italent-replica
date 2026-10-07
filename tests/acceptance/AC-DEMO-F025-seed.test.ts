/**
 * F-025 演示种子：可重复执行（幂等）、全部合成数据，且种子配置足以让 R1 调动主线各角色入口真实可用
 * （真实授权器，不注入“全部允许”）：员工本人发起 → 直接上级审批 → HRBP 审核 → 生效 → 员工 / 经理 / HR / 审计可见。
 */
import {
  approvalProcesses,
  employmentEmployees,
  eq,
  orgObjects,
  tenants,
  users,
  withPlatform,
  withTenant,
} from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEMO_PEOPLE } from '../../apps/api/src/demo/data.js';
import { type DemoManifest, seedDemo } from '../../apps/api/src/demo/seed.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const TODAY = '2026-10-07';
const clock = () => new Date(`${TODAY}T02:00:00.000Z`);

async function counts() {
  const db = database().db;
  const [tenant] = await withPlatform(db, (tx) => tx.select().from(tenants).where(eq(tenants.code, 'demo-r1')));
  const tenantId = tenant!.id;
  return {
    tenants: (await withPlatform(db, (tx) => tx.select().from(tenants))).length,
    users: (await withPlatform(db, (tx) => tx.select().from(users))).length,
    employees: (await withTenant(db, tenantId, (tx) => tx.select().from(employmentEmployees))).length,
    orgs: (await withTenant(db, tenantId, (tx) => tx.select().from(orgObjects))).length,
    processes: (await withTenant(db, tenantId, (tx) => tx.select().from(approvalProcesses))).length,
  };
}

describe('F-025 演示种子', () => {
  let manifest: DemoManifest;
  beforeAll(async () => {
    const first = await seedDemo(database().db, { clock, nodeEnv: 'test' });
    expect(first.created).toBe(true);
    manifest = first.manifest;
  }, 120_000);

  it('重复执行幂等：第二次不写数据、清单不变', async () => {
    const before = await counts();
    const again = await seedDemo(database().db, { clock, nodeEnv: 'test' });
    expect(again.created).toBe(false);
    expect(again.manifest).toEqual(manifest);
    expect(await counts()).toEqual(before);
    expect(before.employees).toBe(DEMO_PEOPLE.filter((p) => p.job).length);
    expect(before.orgs).toBeGreaterThanOrEqual(6);
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

    const pending = await json<{ items: unknown[] }>(
      await api.request('GET', '/api/tenant/employment/transfers/manager/todos?tab=pending', manager),
    );
    expect(pending.items).toHaveLength(1);

    // 审批中心：直接上级（部门负责人）→ 调入部门 HRBP，各自只在自己的待办里看到
    for (const approver of [manager, hr]) {
      const todos = await json<{ items: { taskId: string; instanceId: string }[] }>(
        await api.request('GET', '/api/tenant/approval/todos', approver),
      );
      expect(todos.items).toHaveLength(1);
      const instance = await json<{ revision: number }>(
        await api.request('GET', `/api/tenant/approval/instances/${todos.items[0]!.instanceId}`, approver),
      );
      await json(
        await api.request('POST', `/api/tenant/approval/tasks/${todos.items[0]!.taskId}/approve`, {
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
