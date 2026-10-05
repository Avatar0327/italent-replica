/** PR #63 第二轮 P3-3：调动预览的字段配置与自动关联人员均遵守最小披露。 */
import { randomUUID } from 'node:crypto';
import { eq, orgHierarchyLinks, orgVersions, sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { loginEmailOf } from './AC-EMP-support.js';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const BASE = '/api/tenant/employment/transfers';
const DATE = '2026-10-01';
interface Created {
  id: string;
  revision: number;
  employeeRevision: number;
  code: string;
}
interface Preview {
  fields: Record<string, unknown>;
  customFields: Record<string, unknown>;
  before: { fields: Record<string, unknown>; customFields: Record<string, unknown> };
  form: { fieldModes: Record<string, string>; customFields: { id: string }[] };
}

async function fixture() {
  const db = database().db;
  const seed = await seedPermissionWorld(db);
  const clock = () => new Date(`${DATE}T01:00:00.000Z`);
  const api = tenantApi(db, { authorize: undefined, clock });
  const setup = tenantApi(db, { clock });
  const world = { ...seed, api };
  const create = async (path: string, body: unknown, revision = 0): Promise<Created> => {
    const response = await setup.request('POST', `/api/tenant/${path}`, {
      ...seed.asAdmin,
      body,
      ifMatch: revision,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as Created;
  };
  const org = (name: string) =>
    create('org/organizations', {
      name,
      startDate: '2025-01-01',
      parents: { admin: { parentId: seed.tenant.id } },
    });
  const inside = await org('可见任职部门');
  const outside = await org('范围外目标部门');
  const custom = (name: string) =>
    create('employment/custom-fields', {
      name,
      objectType: 'employment',
      valueType: 'text',
    });
  const visibleCustom = await custom('可见调动附加项');
  const secretCustom = await custom('不可见调动附加项');
  const person = async (departmentId: string, directManagerId?: string) => {
    const employee = await create('employment/employees', { code: `TRF_${randomUUID()}`, name: '合成披露员工' });
    await create(
      `employment/employees/${employee.id}/businesses`,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-01-01',
        loginEmail: loginEmailOf(employee.id),
        fields: { departmentId, directManagerId, place: '不可见原工作地点' },
        customFields: { [visibleCustom.id]: '可见附加值', [secretCustom.id]: '不可见附加值' },
      },
      employee.revision,
    );
    return employee;
  };
  const setHead = async (org: Created, employeeId: string) => {
    // 负责人写入服务随R1-T12接入；复用审批验收的可信组织版本夹具，不放开生产引用校验。
    await withTenant(db, seed.tenant.id, async (tx) => {
      const [old] = await tx
        .select()
        .from(orgVersions)
        .where(eq(orgVersions.orgId, org.id))
        .orderBy(sql`version_no DESC`)
        .limit(1);
      const versionId = randomUUID();
      await tx.insert(orgVersions).values({
        ...old!,
        id: versionId,
        versionNo: old!.versionNo + 1,
        previousVersionId: old!.id,
        personInChargeId: employeeId,
      });
      const links = await tx.select().from(orgHierarchyLinks).where(eq(orgHierarchyLinks.versionId, old!.id));
      if (links.length) await tx.insert(orgHierarchyLinks).values(links.map((link) => ({ ...link, versionId })));
    });
  };
  return { ...world, setup, create, person, setHead, inside, outside, visibleCustom, secretCustom };
}

async function actor(world: Awaited<ReturnType<typeof fixture>>) {
  const user = await addMember(world, 'transfer-disclosure-reader');
  const profile = await createProfile(world, `DISC_${randomUUID()}`);
  const definition = MODULE_OBJECTS.employmentRecord;
  const fields = definition.fields.map((field) => ({
    fieldCode: field.code,
    view: field.code !== 'place',
    edit: !field.system && field.code !== 'place',
  }));
  fields.push({ fieldCode: `custom:${world.visibleCustom.id}`, view: true, edit: true });
  fields.push({ fieldCode: `custom:${world.secretCustom.id}`, view: false, edit: false });
  const permission = await setObjectPermission(
    world,
    profile,
    {
      dataOperations: { create: true, update: true, delete: false },
      fields,
      buttons: [{ buttonCode: 'Transfer.Hr', level: 'detail' }],
    },
    definition.code,
  );
  expect(permission.status, await permission.clone().text()).toBe(200);
  await makeGrantable(world, [profile.id]);
  expect((await grant(world, user.id, profile.id)).status).toBe(201);
  const scope = await world.api.request('PUT', `/api/tenant/permission/scopes/${user.id}/TenantBase`, {
    ...world.asAdmin,
    ifMatch: 0,
    body: { kind: 'org_range', orgRanges: [{ orgId: world.inside.id, includeDescendants: false }] },
  });
  expect(scope.status).toBe(200);
  return { user: user.id, tenant: world.tenant.id };
}

describe('AC-TRF PR #63 第二轮预览最小披露', () => {
  let world: Awaited<ReturnType<typeof fixture>>;
  let caller: Awaited<ReturnType<typeof actor>>;
  beforeAll(async () => {
    world = await fixture();
    caller = await actor(world);
  });
  const preview = async (employeeId: string, departmentId: string, extra: Record<string, unknown> = {}) => {
    const response = await world.api.request('POST', `${BASE}/employees/${employeeId}/preview`, {
      ...caller,
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        mode: 'application',
        effectiveDate: DATE,
        fields: { departmentId, ...extra },
      },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Preview;
  };

  it('不可查看的自定义字段ID和预置字段不能通过form.fieldModes泄露', async () => {
    const employee = await world.person(world.inside.id);
    const result = await preview(employee.id, world.inside.id);
    expect(JSON.stringify(result)).not.toContain(world.secretCustom.id);
    expect(JSON.stringify(result)).not.toContain(world.secretCustom.code);
    expect(result.form.fieldModes).not.toHaveProperty('preset:place');
    expect(result.form.fieldModes).toHaveProperty(`custom:${world.visibleCustom.id}`, 'editable');
    expect(result.form.customFields.map((field) => field.id)).toContain(world.visibleCustom.id);
    expect(result.before.customFields).toHaveProperty(world.visibleCustom.id, '可见附加值');
  });

  it('标准表单可选范围外部门，但自动带出的经理及原经理UUID不能越出当前人员范围', async () => {
    const hiddenManager = await world.person(world.outside.id);
    await world.setHead(world.outside, hiddenManager.id);
    const employee = await world.person(world.inside.id, hiddenManager.id);
    const result = await preview(employee.id, world.outside.id);
    expect(result.fields.departmentId).toBe(world.outside.id);
    expect([null, undefined]).toContain(result.fields.directManagerId);
    expect([null, undefined]).toContain(result.before.fields.directManagerId);
    expect(JSON.stringify(result)).not.toContain(hiddenManager.id);
  });

  it('当前范围内自动带出的经理和合法手选经理仍可见', async () => {
    const visibleManager = await world.person(world.inside.id);
    await world.setHead(world.inside, visibleManager.id);
    const employee = await world.person(world.inside.id, visibleManager.id);
    const automatic = await preview(employee.id, world.inside.id);
    expect(automatic.fields.directManagerId).toBe(visibleManager.id);
    expect(automatic.before.fields.directManagerId).toBe(visibleManager.id);
    const selected = await preview(employee.id, world.inside.id, { directManagerId: visibleManager.id });
    expect(selected.fields.directManagerId).toBe(visibleManager.id);
  });
  it('保存及详情响应同样裁剪自动范围外经理，但业务快照保留合法自动派生结果', async () => {
    const hiddenManager = await world.person(world.outside.id);
    await world.setHead(world.outside, hiddenManager.id);
    const employee = await world.person(world.inside.id, hiddenManager.id);
    const formId = 'TenantBase.JobLevelTransferMultiFormView';
    const configured = await world.setup.request('PUT', `${BASE}/forms/${formId}`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: {
        name: '披露验证表单',
        group: 'transfer',
        fieldModes: { 'preset:levelId': 'readonly', 'preset:gradeId': 'hidden' },
      },
    });
    expect(configured.status).toBe(200);
    const response = await world.api.request('POST', `${BASE}/employees/${employee.id}`, {
      ...caller,
      ifMatch: 2,
      body: {
        initiator: 'hr',
        transferTypeCode: 'job_level',
        formId,
        mode: 'application',
        effectiveDate: DATE,
        fields: { departmentId: world.outside.id },
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const saved = (await response.json()) as { id: string; fields: Record<string, unknown> };
    expect(JSON.stringify(saved)).not.toContain(hiddenManager.id);
    const path = `/api/tenant/employment/businesses/${saved.id}`;
    const scoped = await world.api.request('GET', path, caller);
    expect(scoped.status).toBe(200);
    expect(await scoped.text()).not.toContain(hiddenManager.id);
    const trusted = await world.setup.request('GET', path, world.asAdmin);
    expect(trusted.status).toBe(200);
    expect(await trusted.json()).toMatchObject({ fields: { directManagerId: hiddenManager.id } });
  });
});
