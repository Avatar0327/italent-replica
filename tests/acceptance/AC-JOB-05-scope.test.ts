/**
 * AC-JOB-05（F-006，PR #41 复审遗留；真实授权器）：
 * - 同步直线经理经任职模块写入，按操作人“新增任职”的字段权限与数据范围在同一事务内验权，无权时整单拒绝；
 * - 同步回执 managerSync.skipped 按操作人当前的任职数据范围与字段查看权裁剪，不泄露看不到的员工信息
 *   （幂等重放同样按当前权限裁剪，AGENTS §10）。
 */
import { randomUUID } from 'node:crypto';
import { createPermissionAuthorizer } from '@italent/api';
import { type Db } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { runCommand } from '../../apps/api/src/commands.js';
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

const testDb = useTestDb();
const D = '2026-10-02';
const clock = () => new Date(`${TODAY}T01:00:00.000Z`);
const EMPLOYMENT = MODULE_OBJECTS.employmentRecord;
const POSITION = MODULE_OBJECTS.jobPosition;

interface Created {
  readonly id: string;
  readonly revision: number;
  readonly employeeRevision: number;
  readonly [field: string]: unknown;
}

type ReceiptTrimmer = (
  deps: { db: Db; authorize: ReturnType<typeof createPermissionAuthorizer>; clock: () => Date },
  ctx: { tenantId: string; userId: string; timezone: string; now: Date },
  value: unknown,
) => Promise<unknown>;

// 动态路径：实现落地前用例因缺少裁剪函数而失败，而不是整个文件无法加载。
async function loadReceiptTrimmer(): Promise<ReceiptTrimmer> {
  const path = '../../apps/api/src/modules/job/employment-port.js';
  return ((await import(path)) as { trimManagerSync: ReceiptTrimmer }).trimManagerSync;
}

async function loadPatchSchema() {
  const path = '../../apps/api/src/modules/job/fields.js';
  return ((await import(path)) as { jobPatchSchema: (kind: string) => { parse(value: unknown): unknown } })
    .jobPatchSchema;
}

describe('AC-JOB-05 同步直线经理的人员权限与范围（真实授权器）', () => {
  let world: PermissionWorld;
  let fixture: Awaited<ReturnType<typeof scenario>>;
  beforeAll(async () => {
    const db = testDb().db;
    const seed = await seedPermissionWorld(db);
    world = { ...seed, api: tenantApi(db, { authorize: undefined, clock }) };
    fixture = await scenario();
  });

  async function scenario() {
    const setup = tenantApi(world.db, { clock });
    const create = async (path: string, body: object, ifMatch = 0): Promise<Created> => {
      const response = await setup.request('POST', `/api/tenant/${path}`, { ...world.asAdmin, ifMatch, body });
      expect(response.status, await response.clone().text()).toBe(201);
      return (await response.json()) as Created;
    };
    const parents = { admin: { parentId: world.tenant.id } };
    const inside = await create('org/organizations', { name: '同步范围内部门', parents });
    const outside = await create('org/organizations', { name: '同步范围外部门', parents });
    const post = await create('job/posts', {
      name: '同步职务',
      code: `P${randomUUID().slice(0, 8)}`,
      startDate: TODAY,
    });
    const position = (name: string, extra: object = {}) =>
      create('job/positions', {
        name,
        code: `S${randomUUID().slice(0, 8)}`,
        orgId: inside.id,
        postId: post.id,
        startDate: TODAY,
        ...extra,
      });
    const newParent = await position('同步新上级');
    const hire = async (name: string, fields: object) => {
      const employee = await create('employment/employees', { code: `E${randomUUID().slice(0, 8)}`, name });
      const hired = await create(
        `employment/employees/${employee.id}/businesses`,
        { kind: 'hire', mode: 'direct', effectiveDate: TODAY, fields: { employType: 'internal', ...fields } },
        employee.revision,
      );
      return { id: employee.id, recordId: hired.id };
    };
    const manager = await hire('同步新经理', { departmentId: inside.id, positionId: newParent.id });
    const outsider = await hire('范围外员工', { departmentId: outside.id });
    return { create, hire, inside, post, position, newParent, manager, outsider };
  }

  async function operator(options: { employmentCreate: boolean; employmentView?: readonly string[] }) {
    const profile = await createProfile(world, `sync-${randomUUID().slice(0, 8)}`);
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
    const view = options.employmentView ?? EMPLOYMENT.fields.map((field) => field.code);
    const employmentPermission = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: options.employmentCreate, update: false, delete: false },
        fields: EMPLOYMENT.fields.map((field) => ({
          fieldCode: field.code,
          view: view.includes(field.code),
          edit:
            options.employmentCreate &&
            !field.system &&
            ['kind', 'mode', 'effectiveDate', 'directManagerId'].includes(field.code),
        })),
        buttons: [],
      },
      EMPLOYMENT.code,
    );
    expect(employmentPermission.status, await employmentPermission.clone().text()).toBe(200);
    await makeGrantable(world, [profile.id]);
    const user = await addMember(world, 'sync-operator');
    expect((await grant(world, user.id, profile.id)).status).toBe(201);
    const scope = await world.api.request('PUT', `/api/tenant/permission/scopes/${user.id}/TenantBase`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { kind: 'org_range', orgRanges: [{ orgId: fixture.inside.id, includeDescendants: false }] },
    });
    expect(scope.status, await scope.clone().text()).toBe(200);
    return { user: user.id, tenant: world.tenant.id };
  }

  async function staffedPosition(label: string) {
    const target = await fixture.position(`${label}员工职位`);
    const employee = await fixture.hire(`${label}员工`, { departmentId: fixture.inside.id, positionId: target.id });
    return { target, employee };
  }

  const syncBody = () => ({
    parents: { admin: { parentId: fixture.newParent.id } },
    effectiveDate: D,
    adjustEmployeeDirectManager: true,
  });

  async function recordKinds(employeeId: string) {
    const setup = tenantApi(world.db, { clock });
    const response = await setup.request('GET', `/api/tenant/employment/employees/${employeeId}/records?asOf=${D}`, {
      ...world.asAdmin,
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { items: { kind: string }[] }).items.map((item) => item.kind);
  }

  it('操作人没有“新增任职”的字段权限时，勾选同步整单 403，职位与任职都不变', async () => {
    const as = await operator({ employmentCreate: false });
    const { target, employee } = await staffedPosition('无任职权限');
    const response = await world.api.request('PATCH', `/api/tenant/job/positions/${target.id}`, {
      ...as,
      ifMatch: target.revision,
      body: syncBody(),
    });
    expect(response.status, await response.clone().text()).toBe(403);
    expect(await recordKinds(employee.id)).toEqual(['hire']);
    const plain = await world.api.request('PATCH', `/api/tenant/job/positions/${target.id}`, {
      ...as,
      ifMatch: target.revision,
      body: { ...syncBody(), adjustEmployeeDirectManager: false },
    });
    expect(plain.status, await plain.clone().text()).toBe(200);
  });

  it('有新增任职权限且员工都在范围内时照常同步', async () => {
    const as = await operator({ employmentCreate: true });
    const { target, employee } = await staffedPosition('有任职权限');
    const response = await world.api.request('PATCH', `/api/tenant/job/positions/${target.id}`, {
      ...as,
      ifMatch: target.revision,
      body: syncBody(),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ revision: 2, managerSync: { skipped: [] } });
    expect(await recordKinds(employee.id)).toEqual(['hire', 'org_adjustment']);
  });

  it('同步回执按当前范围与字段查看权裁剪：范围外员工只留原因，看不到的字段不返回', async () => {
    const trim = await loadReceiptTrimmer();
    const authorize = createPermissionAuthorizer(world.db);
    const { employee } = await staffedPosition('回执');
    const receipt = {
      skipped: [
        { employeeId: employee.id, assignmentId: employee.recordId, reason: 'EMPLOYEE_IS_SOLE_MANAGER' },
        {
          employeeId: fixture.outsider.id,
          assignmentId: fixture.outsider.recordId,
          reason: 'EMPLOYEE_IS_SOLE_MANAGER',
        },
      ],
    };
    const ctx = (userId: string) => ({
      tenantId: world.tenant.id,
      userId,
      timezone: world.tenant.timezone,
      now: clock(),
    });
    const full = await operator({ employmentCreate: false });
    expect(await trim({ db: world.db, authorize, clock }, ctx(full.user), receipt)).toEqual({
      skipped: [
        { employeeId: employee.id, assignmentId: employee.recordId, reason: 'EMPLOYEE_IS_SOLE_MANAGER' },
        { reason: 'EMPLOYEE_IS_SOLE_MANAGER' },
      ],
    });
    const noEmployeeField = await operator({ employmentCreate: false, employmentView: ['id'] });
    expect(await trim({ db: world.db, authorize, clock }, ctx(noEmployeeField.user), receipt)).toEqual({
      skipped: [
        { assignmentId: employee.recordId, reason: 'EMPLOYEE_IS_SOLE_MANAGER' },
        { reason: 'EMPLOYEE_IS_SOLE_MANAGER' },
      ],
    });
  });

  it('幂等重放时回执同样按操作人当前权限裁剪（HTTP）', async () => {
    const as = await operator({ employmentCreate: true });
    const { target, employee } = await staffedPosition('重放回执');
    const jobPatchSchema = await loadPatchSchema();
    const body = syncBody();
    const key = randomUUID();
    const path = `/api/tenant/job/positions/${target.id}`;
    const stored = {
      ...target,
      revision: 2,
      directParentId: fixture.newParent.id,
      managerSync: {
        skipped: [
          { employeeId: employee.id, assignmentId: employee.recordId, reason: 'EMPLOYEE_IS_SOLE_MANAGER' },
          {
            employeeId: fixture.outsider.id,
            assignmentId: fixture.outsider.recordId,
            reason: 'EMPLOYEE_IS_SOLE_MANAGER',
          },
        ],
      },
    };
    // 模拟一次已成功的同一命令（同用户、同指纹）写入命令台账；R1 只有主职，本人跳过无法由真实数据构造。
    await runCommand(
      world.db,
      { tenantId: world.tenant.id, userId: as.user, timezone: world.tenant.timezone },
      {
        id: key,
        fingerprint: {
          method: 'PATCH',
          path,
          expectedRevision: target.revision,
          input: jobPatchSchema('positions').parse(body),
        },
        execute: async () => ({ status: 200, body: stored }),
      },
    );
    const replay = await world.api.request('PATCH', path, {
      ...as,
      ifMatch: target.revision,
      idempotencyKey: key,
      body,
    });
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(((await replay.json()) as { managerSync: unknown }).managerSync).toEqual({
      skipped: [
        { employeeId: employee.id, assignmentId: employee.recordId, reason: 'EMPLOYEE_IS_SOLE_MANAGER' },
        { reason: 'EMPLOYEE_IS_SOLE_MANAGER' },
      ],
    });
  });
});
