import { randomUUID } from 'node:crypto';
import { bootstrapTenantAdmin } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { CONTRACT_OBJECT, PERSONNEL_OBJECT } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { objectCatalog } from '../../apps/api/src/modules/permission/catalog.js';
import { addMember, createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { createWorld, NOW } from './AC-IN-BE-R2d4c-support.js';
import { rows } from '../../apps/api/src/modules/personnel/store.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
async function fixture() {
  const db = database().db;
  const c = await createWorld(db, `f322-scope-${randomUUID()}`);
  const tenant = c.w.session.tenant;
  const admin = c.w.session.user;
  const adminRecord = await bootstrapTenantAdmin(db, { tenantId: tenant.id, userId: admin.id }, cmd());
  const api = tenantApi(db, { authorize: undefined, clock: () => NOW });
  const seed = { db, tenant, admin, adminRecord, api, asAdmin: { user: admin.id, tenant: tenant.id } };
  const user = await addMember(seed, 'f322-scope-intern-hr');
  const profile = await createProfile(seed, `f322-scope-${randomUUID()}`);
  const education = 'TenantBase.Education';
  for (const code of [
    'TenantBase.Employee',
    'TenantBase.EmploymentRecord',
    CONTRACT_OBJECT,
    PERSONNEL_OBJECT,
    education,
  ]) {
    const definition = objectCatalog.get(code)!;
    const saved = await setObjectPermission(
      seed,
      profile,
      {
        dataOperations: { create: true, update: true, delete: true },
        fields: definition.fields.map((f) => ({ fieldCode: f.code, view: true, edit: !f.system })),
        buttons: definition.buttons.map((b) => ({ buttonCode: b.code, level: b.level })),
      },
      code,
    );
    expect(saved.status, await saved.clone().text()).toBe(200);
    if (code !== education) {
      const scope = await api.request('PUT', `/api/tenant/permission/profiles/${profile.id}/data-scopes/TenantBase`, {
        ...seed.asAdmin,
        ifMatch: 0,
        body: { targetKind: 'entity', targetCode: code, seeAll: true },
      });
      expect(scope.status, await scope.clone().text()).toBe(200);
    }
  }
  await makeGrantable(seed, [profile.id]);
  expect((await grant(seed, user.id, profile.id)).status).toBe(201);
  const management = await api.request('PUT', `/api/tenant/permission/scopes/${user.id}/TenantBase`, {
    ...seed.asAdmin,
    ifMatch: 0,
    body: { kind: 'org_range', orgRanges: [{ orgId: c.w.org.id, includeDescendants: false }] },
  });
  expect(management.status, await management.clone().text()).toBe(200);
  const policy = await api.request(
    'PUT',
    `/api/tenant/permission/scope-policies/TenantBase/${education}/entity/${education}`,
    {
      ...seed.asAdmin,
      ifMatch: 0,
      body: { rules: [{ dimension: 'using_user' }], personField: 'employeeId' },
    },
  );
  expect(policy.status, await policy.clone().text()).toBe(200);
  const as = { user: user.id, tenant: tenant.id };

  const contract = { typeId: c.typeId, companyId: c.companyId, endDate: '2027-09-30' };
  const seeAll = async (code: string, enabled: boolean, revision: number) => {
    const result = await api.request('PUT', `/api/tenant/permission/profiles/${profile.id}/data-scopes/TenantBase`, {
      ...seed.asAdmin,
      ifMatch: revision,
      body: { targetKind: 'entity', targetCode: code, seeAll: enabled },
    });
    expect(result.status, await result.clone().text()).toBe(200);
  };
  const manage = async (orgId: string, revision: number) => {
    const result = await api.request('PUT', `/api/tenant/permission/scopes/${user.id}/TenantBase`, {
      ...seed.asAdmin,
      ifMatch: revision,
      body: { kind: 'org_range', orgRanges: [{ orgId, includeDescendants: false }] },
    });
    expect(result.status, await result.clone().text()).toBe(200);
  };
  const subset = (id: string, school: string) =>
    api.request('POST', `/api/tenant/personnel/employees/${id}/subsets/education`, {
      ...as,
      ifMatch: 0,
      body: { school, isHighestEducation: true, isMainMajor: true },
    });
  const intern = (body: object, revision = 0, key = randomUUID()) =>
    api.request('POST', '/api/tenant/employment/interns', {
      ...as,
      ifMatch: revision,
      idempotencyKey: key,
      body,
    });
  const snapshot = () =>
    withTenant(db, tenant.id, async (tx) => ({
      employment: rows(await tx.execute(sql`SELECT * FROM employment_records ORDER BY id`)),
      timeline: rows(await tx.execute(sql`SELECT * FROM employment_timeline ORDER BY record_id`)),
      contracts: rows(await tx.execute(sql`SELECT * FROM contract_records ORDER BY id`)),
      portfolios: rows(await tx.execute(sql`SELECT * FROM contract_portfolios ORDER BY id`)),
      education: rows(await tx.execute(sql`SELECT * FROM personnel_education ORDER BY id`)),
      educationVersions: rows(
        await tx.execute(sql`SELECT * FROM personnel_education_versions ORDER BY record_id,revision`),
      ),
      profileVersions: rows(
        await tx.execute(sql`SELECT * FROM personnel_employee_versions ORDER BY employee_id,revision`),
      ),
      audits: rows(
        await tx.execute(sql`SELECT * FROM audit_events
      WHERE object_type IN (${PERSONNEL_OBJECT},${education}) ORDER BY id`),
      ),
    }));
  return { c, api, as, seed, education, contract, seeAll, manage, subset, intern, snapshot };
}

it('DEC-082：范围内首次教育创建两入口均 201；撤管理范围后同键回查 404，恢复后不重复写入', async () => {
  const f = await fixture();
  const inside = await f.c.w.hire('合成管理内', 'intern');
  expect((await f.subset(inside.employee.id, '合成管理内首条')).status).toBe(201);
  const key = randomUUID();
  const body = f.c.hireBody({
    effectiveDate: '2026-09-01',
    contract: f.contract,
    profile: { lastSchool: '合成首次教育' },
  });
  const result = await f.intern(body, 0, key);
  expect(result.status, await result.clone().text()).toBe(201);
  const receipt = (await result.json()) as { employeeId: string; profile: { lastSchool: string } };
  expect(receipt.profile.lastSchool).toBe('合成首次教育');
  const before = await f.snapshot();
  expect(before.education.filter((row) => row.employee_id === receipt.employeeId)).toMatchObject([
    { school: '合成首次教育', is_highest_education: true, is_main_major: true },
  ]);
  await f.manage(f.c.w.other.id, 1);
  expect((await f.intern(body, 0, key)).status).toBe(404);
  expect(await f.snapshot()).toEqual(before);
  await f.manage(f.c.w.org.id, 2);
  expect(await (await f.intern(body, 0, key)).json()).toEqual(receipt);
  expect(await f.snapshot()).toEqual(before);
  await f.c.w.leave(receipt.employeeId, '2026-09-20');
  const rehire = await f.intern(
    f.c.rehireBody(receipt.employeeId, {
      contract: f.contract,
      profile: { lastSchool: '合成重聘学校' },
    }),
    await f.c.w.revision(receipt.employeeId),
  );
  expect(rehire.status, await rehire.clone().text()).toBe(201);
  expect(await rehire.json()).toMatchObject({ profile: { lastSchool: '合成重聘学校' } });
  const education = (await f.snapshot()).education.filter((row) => row.employee_id === receipt.employeeId);
  expect(education).toHaveLength(2);
  expect(education.find((row) => row.school === '合成首次教育')).toMatchObject({
    is_highest_education: false,
    is_main_major: false,
    deleted: false,
  });
  expect(education.find((row) => row.school === '合成重聘学校')).toMatchObject({
    is_highest_education: true,
    is_main_major: true,
  });
}, 120_000);

it('DEC-082：本人旧教育不授予范围外创建；两入口均 404，失败回查不改旧标记和档案反写', async () => {
  const f = await fixture();
  const outside = await f.c.w.hire('合成管理外', 'intern', {
    fields: { employType: 'intern', departmentId: f.c.w.other.id },
  });
  await f.seeAll(f.education, true, 0);
  expect((await f.subset(outside.employee.id, '合成历史学校')).status).toBe(201);
  await f.seeAll(f.education, false, 1);
  await f.c.w.leave(outside.employee.id, '2026-09-20');
  const before = await f.snapshot();
  expect((await f.subset(outside.employee.id, '范围外禁止学校')).status).toBe(404);
  const revision = await f.c.w.revision(outside.employee.id);
  const key = randomUUID();
  const body = f.c.rehireBody(outside.employee.id, {
    fields: { departmentId: f.c.w.other.id },
    contract: f.contract,
    profile: { lastSchool: '范围外禁止学校' },
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await f.intern(body, revision, key);
    expect.soft(result.status, await result.clone().text()).toBe(404);
    expect.soft(await f.snapshot()).toEqual(before);
    expect.soft(await f.c.w.revision(outside.employee.id)).toBe(revision);
  }
}, 120_000);

it('DEC-082：普通资料 update 与回执 view 保留创建人语义，管理范围外仍可修改本人创建的档案', async () => {
  const f = await fixture();
  const first = await f.intern(
    f.c.hireBody({
      effectiveDate: '2026-09-01',
      contract: f.contract,
      profile: {
        backupMail: 'before@example.com',
        idType: 'id_card',
        idNumber: `SYN-${randomUUID()}`,
        dailyWageStandard: '1.00',
      },
    }),
  );
  expect(first.status, await first.clone().text()).toBe(201);
  const receipt = (await first.json()) as { employeeId: string };
  await f.seeAll(PERSONNEL_OBJECT, false, 1);
  const policy = await f.api.request(
    'PUT',
    `/api/tenant/permission/scope-policies/TenantBase/${PERSONNEL_OBJECT}/entity/${PERSONNEL_OBJECT}`,
    {
      ...f.seed.asAdmin,
      ifMatch: 0,
      body: { rules: [{ dimension: 'using_user' }] },
    },
  );
  expect(policy.status, await policy.clone().text()).toBe(200);
  await f.manage(f.c.w.other.id, 1);
  await f.c.w.leave(receipt.employeeId, '2026-09-20');
  const revision = await f.c.w.revision(receipt.employeeId);
  const key = randomUUID();
  const values = { backupMail: 'after@example.com', idNumber: `SYN-${randomUUID()}`, dailyWageStandard: '250.50' };
  const body = f.c.rehireBody(receipt.employeeId, { contract: f.contract, profile: values });
  const result = await f.intern(body, revision, key);
  expect(result.status, await result.clone().text()).toBe(201);
  expect(await result.json()).toMatchObject({ profile: values });
  expect(await (await f.intern(body, revision, key)).json()).toMatchObject({ profile: values });
  const read = await f.api.request('GET', `/api/tenant/personnel/employees/${receipt.employeeId}`, f.as);
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject(values);
}, 120_000);
