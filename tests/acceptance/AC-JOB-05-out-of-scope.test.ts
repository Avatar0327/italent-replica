/**
 * AC-JOB-05（F-006 第二轮，PR #54 astra 首审 P2-1；真实授权器）：职位变更同步直线经理不得绕过任职数据范围。
 * 每名在岗员工按“源任职的真实创建者 + 操作人当前范围”判断，与直接读取任职、直接新增任职同一口径；
 * 范围外的员工跳过，回执记 OUT_OF_SCOPE（裁剪后只留原因），其余照常同步，职位变更照常保存；
 * 同一次同步里任一员工写入失败时整单回滚，已追加的任职版本一并撤销。
 */
import type * as NodeCrypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { permissionUserPersonLinks, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
  type PermissionWorld,
} from './AC-PRM-support.js';
import { TODAY } from './AC-ORG-people-support.js';
import { tenantApi } from './support/tenant-api.js';

/** 确定在岗员工的处理顺序（按员工 ID）：设了前缀时服务端生成的 UUID 以它开头，其余位仍随机。 */
const uuidPrefix = vi.hoisted(() => ({ value: null as string | null }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  const randomUUID = () => {
    const id = actual.randomUUID();
    return uuidPrefix.value ? uuidPrefix.value + id.slice(uuidPrefix.value.length) : id;
  };
  return { ...actual, randomUUID };
});

const testDb = useTestDb();
const D = '2026-10-02';
const clock = () => new Date(`${TODAY}T01:00:00.000Z`);
const EMPLOYMENT = MODULE_OBJECTS.employmentRecord;
const POSITION = MODULE_OBJECTS.jobPosition;

interface Created {
  readonly id: string;
  readonly revision: number;
  readonly employeeRevision: number;
}

type Rule = { dimension: 'management' | 'reporting' | 'using_user'; relationMode?: string };

async function scenario(label: string) {
  const db = testDb().db;
  const seed = await seedPermissionWorld(db);
  const world: PermissionWorld = { ...seed, api: tenantApi(db, { authorize: undefined, clock }) };
  const setup = tenantApi(db, { clock });
  const create = async (path: string, body: object, ifMatch = 0): Promise<Created> => {
    const response = await setup.request('POST', `/api/tenant/${path}`, { ...world.asAdmin, ifMatch, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as Created;
  };
  const department = await create('org/organizations', {
    name: `${label}部门`,
    parents: { admin: { parentId: world.tenant.id } },
  });
  const post = await create('job/posts', {
    name: `${label}职务`,
    code: `P${randomUUID().slice(0, 8)}`,
    startDate: TODAY,
  });
  const position = (name: string) =>
    create('job/positions', {
      name,
      code: `S${randomUUID().slice(0, 8)}`,
      orgId: department.id,
      postId: post.id,
      startDate: TODAY,
    });
  const hire = async (name: string, fields: object = {}, prefix?: string) => {
    uuidPrefix.value = prefix ?? null;
    try {
      const employee = await create('employment/employees', { code: `E${randomUUID().slice(0, 8)}`, name });
      const hired = await create(
        `employment/employees/${employee.id}/businesses`,
        {
          kind: 'hire',
          mode: 'direct',
          effectiveDate: TODAY,
          fields: { employType: 'internal', departmentId: department.id, ...fields },
        },
        employee.revision,
      );
      return { id: employee.id, recordId: hired.id };
    } finally {
      uuidPrefix.value = null;
    }
  };
  const newParent = await position('新上级职位');
  const target = await position('本职位');
  return { db, world, setup, department, position, hire, newParent, target };
}

type Scenario = Awaited<ReturnType<typeof scenario>>;

/** 有职位变更权、“新增任职”的经理字段编辑权；任职实体的范围按 rules 配置，其他对象按本部门。 */
async function operator(s: Scenario, rules: readonly Rule[]) {
  const { world } = s;
  const profile = await createProfile(world, `oos-${randomUUID().slice(0, 8)}`);
  const positionPermission = await setObjectPermission(
    world,
    profile,
    {
      dataOperations: { create: false, update: true, delete: false },
      fields: POSITION.fields.map((field) => ({
        fieldCode: field.code,
        view: true,
        edit: !field.system && ['parents', 'effectiveDate'].includes(field.code),
      })),
      buttons: [],
    },
    POSITION.code,
  );
  expect(positionPermission.status, await positionPermission.clone().text()).toBe(200);
  const employmentPermission = await setObjectPermission(
    world,
    profile,
    {
      dataOperations: { create: true, update: false, delete: false },
      fields: EMPLOYMENT.fields.map((field) => ({
        fieldCode: field.code,
        view: true,
        edit: !field.system && ['kind', 'mode', 'effectiveDate', 'directManagerId'].includes(field.code),
      })),
      buttons: EMPLOYMENT.buttons.map((button) => ({ buttonCode: button.code, level: button.level })),
    },
    EMPLOYMENT.code,
  );
  expect(employmentPermission.status, await employmentPermission.clone().text()).toBe(200);
  await makeGrantable(world, [profile.id]);
  const user = await addMember(world, 'oos-operator');
  expect((await grant(world, user.id, profile.id)).status).toBe(201);
  const scope = await world.api.request('PUT', `/api/tenant/permission/scopes/${user.id}/TenantBase`, {
    ...world.asAdmin,
    ifMatch: 0,
    body: { kind: 'org_range', orgRanges: [{ orgId: s.department.id, includeDescendants: false }] },
  });
  expect(scope.status, await scope.clone().text()).toBe(200);
  const policy = await world.api.request(
    'PUT',
    `/api/tenant/permission/scope-policies/TenantBase/${EMPLOYMENT.code}/entity/${EMPLOYMENT.code}`,
    { ...world.asAdmin, ifMatch: 0, body: { rules } },
  );
  expect(policy.status, await policy.clone().text()).toBe(200);
  return { user: user.id, tenant: world.tenant.id };
}

function synchronize(s: Scenario, as: { user: string; tenant: string }, target = s.target, parent = s.newParent) {
  return s.world.api.request('PATCH', `/api/tenant/job/positions/${target.id}`, {
    ...as,
    ifMatch: target.revision,
    body: { parents: { admin: { parentId: parent.id } }, effectiveDate: D, adjustEmployeeDirectManager: true },
  });
}

async function records(s: Scenario, employeeId: string) {
  const response = await s.setup.request('GET', `/api/tenant/employment/employees/${employeeId}/records?asOf=${D}`, {
    ...s.world.asAdmin,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { items: { kind: string; isCurrent: boolean; fields: Record<string, unknown> }[] };
}

const kinds = async (s: Scenario, employeeId: string) => (await records(s, employeeId)).items.map((r) => r.kind);

describe('AC-JOB-05 同步直线经理不得绕过任职数据范围（真实授权器）', () => {
  it('“仅本人创建”范围下：读不到、直接新增也 404 的员工，经职位同步不写入，回执只留 OUT_OF_SCOPE', async () => {
    const s = await scenario('本人创建');
    const manager = await s.hire('新上级唯一在岗', { positionId: s.newParent.id });
    const outsider = await s.hire('他人创建员工', { positionId: s.target.id });
    const as = await operator(s, [{ dimension: 'using_user' }]);
    const read = await s.world.api.request('GET', `/api/tenant/employment/records/${outsider.recordId}`, as);
    expect(read.status).toBe(404);
    const direct = await s.world.api.request('POST', `/api/tenant/employment/employees/${outsider.id}/businesses`, {
      ...as,
      ifMatch: 2,
      body: { kind: 'transfer', mode: 'direct', effectiveDate: D, fields: { directManagerId: manager.id } },
    });
    expect(direct.status).toBe(404);
    const response = await synchronize(s, as);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      revision: 2,
      directParentId: s.newParent.id,
      managerSync: { skipped: [{ reason: 'OUT_OF_SCOPE' }] },
    });
    expect(await kinds(s, outsider.id)).toEqual(['hire']);
  });

  it('范围内的员工照常同步、范围外的跳过；范围外员工的标识不出现在回执里', async () => {
    const s = await scenario('汇报范围');
    const manager = await s.hire('新上级唯一在岗', { positionId: s.newParent.id });
    const lead = await s.hire('操作人本人');
    const as = await operator(s, [{ dimension: 'reporting', relationMode: 'direct' }]);
    await withTenant(s.db, s.world.tenant.id, (tx) =>
      tx
        .insert(permissionUserPersonLinks)
        .values({ tenantId: s.world.tenant.id, userId: as.user, employeeId: lead.id }),
    );
    const report = await s.hire('直接下属', { positionId: s.target.id, directManagerId: lead.id });
    const outsider = await s.hire('非下属', { positionId: s.target.id });
    const response = await synchronize(s, as);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as { managerSync: { skipped: unknown[] } };
    expect(body.managerSync).toEqual({ skipped: [{ reason: 'OUT_OF_SCOPE' }] });
    expect(JSON.stringify(body)).not.toContain(outsider.id);
    expect(JSON.stringify(body)).not.toContain(outsider.recordId);
    expect(await kinds(s, report.id)).toEqual(['hire', 'org_adjustment']);
    const synced = (await records(s, report.id)).items.find((item) => item.kind === 'org_adjustment');
    expect(synced?.fields).toMatchObject({ directManagerId: manager.id });
    expect(await kinds(s, outsider.id)).toEqual(['hire']);
  });

  it('整单回滚：先为一名员工追加了任职版本，后一名员工成环被拒时，职位与全部任职都不变', async () => {
    const s = await scenario('整单回滚');
    const as = await operator(s, [{ dimension: 'management' }]);
    const first = await s.hire('先处理员工', { positionId: s.target.id }, '00000000');
    const second = await s.hire('后处理员工', { positionId: s.target.id }, 'ffffffff');
    const manager = await s.hire('新上级唯一在岗', { positionId: s.newParent.id, directManagerId: second.id });
    const response = await synchronize(s, as);
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'REPORTING_CYCLE' } } });
    expect(await kinds(s, first.id)).toEqual(['hire']);
    expect(await kinds(s, second.id)).toEqual(['hire']);
    expect(await kinds(s, manager.id)).toEqual(['hire']);
    const position = await s.setup.request('GET', `/api/tenant/job/positions/${s.target.id}?asOf=${D}`, {
      ...s.world.asAdmin,
    });
    expect(await position.json()).toMatchObject({ revision: 1, directParentId: null });
  });
});
