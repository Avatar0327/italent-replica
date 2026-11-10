/**
 * AC-DM-30-F493-16①②/23①②③/37：历史离职导入提交的权限链（S3a，设计 §6.1）。
 * 真实授权器（不注入 authorize 替身）：按身份逐对象配置字段写权、按钮、看全部范围，再用该身份提交。
 * 提交权限在入口与命令事务内各复核一次；任一不满足 403，且不落批次、不写人员。
 */
import './support/exit-gate-enforced.js';
import { bootstrapTenantAdmin } from '@italent/api';
import { MODULE_OBJECTS, PERSONNEL_OBJECT, PERSONNEL_OBJECTS, SUBSETS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { importWorld, type ImportWorld } from './AC-DM-30-support.js';
import { addMember, createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const BUTTON = 'Employment.DimissionImport';
const EMPLOYEE = MODULE_OBJECTS.employee.code;
const RECORD = MODULE_OBJECTS.employmentRecord.code;
const EDUCATION = SUBSETS.education.objectCode;
const OBJECTS = [...Object.values(MODULE_OBJECTS), ...PERSONNEL_OBJECTS];

/** 本身份缺的权限：某对象的某字段写权 / 新增权 / 看全部范围 / 导入按钮。 */
interface Revoke {
  field?: [object: string, field: string];
  noCreate?: string;
  noScope?: string;
  noButton?: boolean;
}

/** 配一个除 `revoke` 外什么都有的身份，返回用它提交的函数。 */
async function operator(x: ImportWorld, revoke: Revoke = {}) {
  const { tenant, user } = x.session;
  const pw = {
    db: x.db,
    tenant,
    admin: user,
    adminRecord: await bootstrapTenantAdmin(x.db, { tenantId: tenant.id, userId: user.id }, cmd()),
    api: tenantApi(x.db, { authorize: undefined, clock: () => new Date('2026-11-05T01:00:00Z') }),
    asAdmin: { user: user.id, tenant: tenant.id },
  };
  const profile = await createProfile(pw, `imp-${uniqueSuffix()}`, { apps: ['TenantBase'] });
  for (const definition of OBJECTS) {
    const response = await setObjectPermission(
      pw,
      profile,
      {
        dataOperations: { create: revoke.noCreate !== definition.code, update: true, delete: true },
        fields: definition.fields.map((f) => ({
          fieldCode: f.code,
          view: true,
          edit: !f.system && !(revoke.field?.[0] === definition.code && revoke.field[1] === f.code),
        })),
        buttons: definition.buttons
          .filter((b) => !(revoke.noButton && b.code === BUTTON.split('.')[1]))
          .map((b) => ({ buttonCode: b.code, level: b.level })),
      },
      definition.code,
    );
    expect(response.status, `${definition.code} ${await response.clone().text()}`).toBe(200);
  }
  for (const target of [RECORD, EMPLOYEE, PERSONNEL_OBJECT].filter((t) => t !== revoke.noScope)) {
    const response = await pw.api.request('PUT', `/api/tenant/permission/profiles/${profile.id}/data-scopes/TenantBase`, {
      ...pw.asAdmin,
      ifMatch: 0,
      body: { targetKind: 'entity', targetCode: target, seeAll: true },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }
  await makeGrantable(pw, [profile.id]);
  const member = await addMember(pw, `imp-op-${uniqueSuffix()}`);
  expect((await grant(pw, member.id, profile.id)).status).toBe(201);
  return (rows: readonly unknown[]) =>
    pw.api.request('POST', '/api/tenant/employment/exits/import', {
      user: member.id,
      tenant: tenant.id,
      body: { fileName: '合成导入.xlsx', rows },
      idempotencyKey: `dm30-authz-${uniqueSuffix()}`,
    });
}

const denied = async (x: ImportWorld, revoke: Revoke, rows: (d: string) => unknown[]) => {
  const d = await x.dept('权限部门');
  const submit = await operator(x, revoke);
  const before = await x.writeCounts();
  const response = await submit(rows(d.code));
  expect(response.status, await response.clone().text()).toBe(403);
  expect(await x.writeCounts()).toEqual(before);
};

describe('AC-DM-30-F493-16 ①② 提交权限', () => {
  it('① 没有导入按钮 → 403，不落批次', async () => {
    const x = await importWorld(database().db, '16-1');
    await denied(x, { noButton: true }, (code) => [x.row(1, code)]);
  });

  it.each([
    ['任职记录', RECORD],
    ['人员', EMPLOYEE],
    ['人员档案', PERSONNEL_OBJECT],
  ])('② 没有%s对象的显式看全部范围 → 403，不落批次', async (_name, target) => {
    const x = await importWorld(database().db, `16-2-${target}`);
    await denied(x, { noScope: target }, (code) => [x.row(1, code)]);
  });
});

describe('AC-DM-30-F493-23 真实授权器下的提交', () => {
  it('① 权限齐全 → 202，执行后建人、建账号', async () => {
    const x = await importWorld(database().db, '23-1');
    const d = await x.dept('齐权部门');
    const submit = await operator(x);
    const response = await submit([x.row(1, d.code)]);
    expect(response.status, await response.clone().text()).toBe(202);
    const { batchId } = (await response.json()) as { batchId: string };
    await x.settle();
    expect((await x.rowsOfBatch(batchId))[0]!.status).toBe('succeeded');
    expect(await x.employeeCount()).toBe(1);
  });

  it('② 收回任职 lastWorkDate 写权 → 403；③ 收回人员 code 写权 → 403；均不落批次', async () => {
    const x = await importWorld(database().db, '23-23');
    await denied(x, { field: [RECORD, 'lastWorkDate'] }, (code) => [x.row(1, code)]);
    await denied(x, { field: [EMPLOYEE, 'code'] }, (code) => [x.row(1, code)]);
  });
});

describe('AC-DM-30-F493-37 档案字段写权（真实授权器）', () => {
  it('收回档案 email 写权 → 403，不落批次', async () => {
    const x = await importWorld(database().db, '37-email');
    await denied(x, { field: [PERSONNEL_OBJECT, 'email'] }, (code) => [x.row(1, code)]);
  });

  it('只收回 mobilePhone 写权：L 列全空时 202；任一行 L 有值时 403', async () => {
    const x = await importWorld(database().db, '37-phone');
    const d = await x.dept('手机号部门');
    const submit = await operator(x, { field: [PERSONNEL_OBJECT, 'mobilePhone'] });
    const empty = await submit([x.row(1, d.code)]);
    expect(empty.status, await empty.clone().text()).toBe(202);
    await x.settle();
    const before = await x.writeCounts();
    const filled = await submit([x.row(2, d.code), x.row(3, d.code, { mobilePhone: '13800000002' })]);
    expect(filled.status).toBe(403);
    expect(await x.writeCounts()).toEqual(before);
  });

  it('T 列有值但没有教育经历新增权 → 403，不落批次', async () => {
    const x = await importWorld(database().db, '37-edu');
    await denied(x, { noCreate: EDUCATION }, (code) => [x.row(1, code, { school: '合成大学' })]);
  });
});
