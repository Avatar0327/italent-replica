/**
 * 企业设置 · 用户管理（R1-T15，DEC-128）验收测试的公共装配。
 * 权限接口走真实授权器；人员建档 / 入职走“全部允许”的业务接口（与 AC-PRM-scope-resolution 一致），
 * 只验证建档写入路径在同一事务里调用权限模块的用户端口。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { AdminRole } from '@italent/domain';
import { expect } from 'vitest';
import { addMember, BASE, type PermissionWorld } from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';

export const USERS_TODAY = '2026-10-01';

export interface TenantUserBody {
  userId: string;
  email: string;
  displayName: string;
  userType: 'internal' | 'external' | null;
  businessIdentity: string | null;
  employeeId: string | null;
  membershipStatus: 'active' | 'revoked';
  membershipRevision: number;
  accountStatus: 'active' | 'disabled';
  accountRevision: number;
}

export interface EmployeeBody {
  id: string;
  code: string;
  name: string;
  revision: number;
  status: string;
}

export function syntheticEmail(label: string): string {
  return `${label}-${randomBytes(3).toString('hex')}@example.com`;
}

/** 人员建档 / 入职的业务接口（全部允许）；时钟固定在 USERS_TODAY。 */
export function hrApi(world: PermissionWorld) {
  const api = tenantApi(world.db, { clock: () => new Date(`${USERS_TODAY}T01:00:00Z`) });
  const as = world.asAdmin;

  async function createEmployee(body: { name: string; loginEmail?: string; code?: string }): Promise<Response> {
    return api.request('POST', '/api/tenant/employment/employees', {
      ...as,
      ifMatch: 0,
      body: { code: body.code ?? `U_${randomUUID().replaceAll('-', '')}`, ...body },
    });
  }

  async function employee(name: string, loginEmail?: string): Promise<EmployeeBody> {
    const response = await createEmployee({ name, ...(loginEmail ? { loginEmail } : {}) });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as EmployeeBody;
  }

  async function org(name: string): Promise<string> {
    const response = await api.request('POST', '/api/tenant/org/organizations', {
      ...as,
      ifMatch: 0,
      body: { name, establishedOn: '2020-01-01', parents: { admin: { parentId: world.tenant.id } } },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }

  async function hire(employee: EmployeeBody, departmentId: string, extra: Record<string, unknown> = {}) {
    return api.request('POST', `/api/tenant/employment/employees/${employee.id}/businesses`, {
      ...as,
      ifMatch: employee.revision,
      body: { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { departmentId }, ...extra },
    });
  }

  async function getEmployee(id: string): Promise<EmployeeBody> {
    const response = await api.request('GET', `/api/tenant/employment/employees/${id}`, as);
    expect(response.status).toBe(200);
    return (await response.json()) as EmployeeBody;
  }

  return { api, createEmployee, employee, org, hire, getEmployee };
}

export async function listUsers(
  world: PermissionWorld,
  type: 'internal' | 'external' | 'all' = 'all',
  as = world.asAdmin,
): Promise<TenantUserBody[]> {
  const response = await world.api.request('GET', `${BASE}/users?type=${type}&limit=200`, as);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: TenantUserBody[] }).items;
}

export async function getTenantUser(world: PermissionWorld, userId: string): Promise<TenantUserBody> {
  const response = await world.api.request('GET', `${BASE}/users/${userId}`, world.asAdmin);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as TenantUserBody;
}

/** 由租户管理员为一名新成员开通某类企业管理员身份；返回其请求身份。 */
export async function memberWithAdminRole(world: PermissionWorld, role: AdminRole, label: string = role) {
  const member = await addMember(world, label);
  const response = await world.api.request('POST', `${BASE}/admins`, {
    ...world.asAdmin,
    body: { userId: member.id, role, grantableAdminRoles: [], grantableProfileIds: [] },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return { user: member, as: { user: member.id, tenant: world.tenant.id } };
}

export async function reasonOf(response: Response): Promise<{ status: number; code?: string; reason?: string }> {
  const body = (await response.json()) as { error?: { code?: string; details?: { reason?: string } } };
  return { status: response.status, code: body.error?.code, reason: body.error?.details?.reason };
}
