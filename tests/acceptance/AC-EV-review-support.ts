/**
 * R3-T02 PR-B B3（评审组 + 人员引用出口）的验收夹具（设计 §3.2、§5.1“人员引用的出口”）。真实授权器：
 * - 租户管理员（缺省授权钩子）用来搭数据：两个组织、若干员工（入职到各组织）、管理员建的评审组；
 * - 被测操作人：身份含 TEvaluation 与 TenantBase 两个应用，TEvaluation 数据范围 = 若干组织（评审组按所属组织裁剪），
 *   TenantBase 数据范围 = 若干组织（员工信息的人员范围，决定成员是范围内还是范围外）。
 * 测试数据一律合成，邮箱用 example.com。
 */
import { randomUUID } from 'node:crypto';
import { EVALUATION_OBJECTS, PERSONNEL_OBJECT, PERSONNEL_OBJECTS } from '@italent/domain';
import type { Db } from '@italent/db';
import { expect } from 'vitest';
import { loginEmailOf } from './AC-EMP-support.js';
import { EV_APP, EV_BASE, EV_NOW } from './AC-EV-support.js';
import {
  addMember,
  BASE,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { type RequestOptions, tenantApi } from './support/tenant-api.js';

export const GROUPS = '/review-groups';
export const CANDIDATES = '/candidates/review-members';

export interface MemberView {
  readonly employeeId: string;
  readonly isLeader: boolean;
  readonly name?: string;
  readonly code?: string;
}
export interface GroupView {
  readonly id: string;
  readonly revision: number;
  readonly code: string;
  readonly name: string;
  readonly ownerId: string;
  readonly ownerOrgId: string;
  readonly enabled: boolean;
  readonly createdBy: string;
  readonly members: MemberView[];
}

export interface Employee {
  readonly id: string;
  readonly name: string;
  readonly code: string;
}

export async function reviewWorld(db: Db) {
  const original = await seedPermissionWorld(db);
  const clock = () => EV_NOW;
  const api = tenantApi(db, { authorize: undefined, clock });
  const setup = tenantApi(db, { clock });
  const world = { ...original, api };
  const admin = world.asAdmin;

  async function create<T>(path: string, body: unknown, revision = 0): Promise<T> {
    const response = await setup.request('POST', `/api/tenant/${path}`, { ...admin, ifMatch: revision, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as T;
  }
  const org = async (name: string) =>
    (
      await create<{ id: string }>('org/organizations', {
        name,
        establishedOn: '2025-01-01',
        parents: { admin: { parentId: world.tenant.id } },
      })
    ).id;
  /** 建档 + 入职到某个组织（人员范围按任职所在组织判定）。 */
  async function hire(name: string, orgId: string): Promise<Employee> {
    const code = `E${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const employee = await create<{ id: string; revision: number }>('employment/employees', { code, name });
    await create(
      `employment/employees/${employee.id}/businesses`,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-01-01',
        fields: { departmentId: orgId },
        loginEmail: loginEmailOf(employee.id),
      },
      employee.revision,
    );
    return { id: employee.id, name, code };
  }
  /** 把员工调到另一个组织（用于人员范围变化的复核用例）。 */
  async function transfer(employee: Employee, orgId: string) {
    const current = await setup.request('GET', `/api/tenant/employment/employees/${employee.id}`, admin);
    const revision = ((await current.json()) as { revision: number }).revision;
    await create(
      `employment/employees/${employee.id}/businesses`,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-01', fields: { departmentId: orgId } },
      revision,
    );
  }

  const orgA = await org('评审甲部');
  const orgB = await org('评审乙部');
  const orgC = await org('评审丙部');

  /** 管理员（缺省授权钩子，看全部）直接建评审组，返回响应体。 */
  async function adminGroup(body: Record<string, unknown>): Promise<GroupView> {
    const response = await setup.request('POST', `${EV_BASE}${GROUPS}`, { ...admin, ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as GroupView;
  }

  return { ...world, setup, orgA, orgB, orgC, hire, transfer, adminGroup, org };
}
export type ReviewWorld = Awaited<ReturnType<typeof reviewWorld>>;

export interface ReviewOperatorOptions {
  /** TEvaluation 数据范围：这些组织（不含下级）。 */
  readonly evOrgs?: readonly string[];
  /** TenantBase（员工信息）数据范围：这些组织（不含下级）。 */
  readonly personOrgs?: readonly string[];
  /** 评审组对象里看不到的字段。 */
  readonly hidden?: readonly string[];
  /** 评审组对象里看得到但不能编辑的字段。 */
  readonly readonly?: readonly string[];
  /** 员工信息里看不到的字段。 */
  readonly hiddenEmployeeFields?: readonly string[];
  /** 完全不授员工信息对象。 */
  readonly noEmployeeObject?: boolean;
  readonly noCreate?: boolean;
  readonly noUpdate?: boolean;
  readonly noDelete?: boolean;
  readonly noButtons?: boolean;
  /** 日志审计管理员。 */
  readonly auditor?: boolean;
}

const rangeBody = (orgs: readonly string[] | undefined) =>
  orgs?.length
    ? { kind: 'org_range', orgRanges: orgs.map((orgId) => ({ orgId, includeDescendants: false })) }
    : { kind: 'default' };

export async function reviewOperator(world: ReviewWorld, options: ReviewOperatorOptions = {}) {
  const profile = await createProfile(world, `evr-${randomUUID().slice(0, 8)}`, { apps: [EV_APP, 'TenantBase'] });
  const group = EVALUATION_OBJECTS.reviewGroup;
  const hidden = new Set(options.hidden ?? []);
  const readonly = new Set(options.readonly ?? []);
  const grantObject = async (code: string, body: Parameters<typeof setObjectPermission>[2]) => {
    const response = await setObjectPermission(world, profile, body, code);
    expect(response.status, await response.clone().text()).toBe(200);
  };
  await grantObject(group.code, {
    dataOperations: { create: !options.noCreate, update: !options.noUpdate, delete: !options.noDelete },
    fields: group.fields.map((field) => ({
      fieldCode: field.code,
      view: !hidden.has(field.code),
      edit: !field.system && !hidden.has(field.code) && !readonly.has(field.code),
    })),
    buttons: options.noButtons ? [] : group.buttons.map((button) => ({ buttonCode: button.code, level: button.level })),
  });
  if (!options.noEmployeeObject) {
    const personnel = PERSONNEL_OBJECTS.find((object) => object.code === PERSONNEL_OBJECT)!;
    const hiddenEmployee = new Set(options.hiddenEmployeeFields ?? []);
    await grantObject(PERSONNEL_OBJECT, {
      dataOperations: { create: false, update: false, delete: false },
      fields: personnel.fields.map((field) => ({
        fieldCode: field.code,
        view: !hiddenEmployee.has(field.code),
        edit: false,
      })),
      buttons: [],
    });
  }
  await makeGrantable(world, [profile.id]);
  const user = await addMember(world, `evr-op-${randomUUID().slice(0, 4)}`);
  expect((await grant(world, user.id, profile.id)).status).toBe(201);
  if (options.auditor) {
    const response = await world.api.request('POST', `${BASE}/admins`, {
      ...world.asAdmin,
      body: { userId: user.id, role: 'audit_admin', grantableAdminRoles: [], grantableProfileIds: [] },
    });
    expect(response.status, await response.clone().text()).toBe(201);
  }
  const revisions = new Map<string, number>();
  const setRange = async (app: string, orgs: readonly string[] | undefined) => {
    const response = await world.api.request('PUT', `${BASE}/scopes/${user.id}/${app}`, {
      ...world.asAdmin,
      ifMatch: revisions.get(app) ?? 0,
      body: rangeBody(orgs),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    revisions.set(app, ((await response.json()) as { revision: number }).revision);
  };
  if (options.evOrgs?.length) await setRange(EV_APP, options.evOrgs);
  if (options.personOrgs?.length) await setRange('TenantBase', options.personOrgs);
  const as = { user: user.id, tenant: world.tenant.id };
  const request = (method: string, path: string, extra: RequestOptions = {}) =>
    world.api.request(method, path.startsWith('/api/') ? path : `${EV_BASE}${path}`, { ...as, ...extra });
  return {
    request,
    as,
    userId: user.id,
    /** 改评审组的数据范围（所属组织）。 */
    setEvOrgs: (orgs: readonly string[] | undefined) => setRange(EV_APP, orgs),
    /** 改员工信息的人员范围。 */
    setPersonOrgs: (orgs: readonly string[] | undefined) => setRange('TenantBase', orgs),
  };
}
export type ReviewOperator = Awaited<ReturnType<typeof reviewOperator>>;
