/**
 * F-493 历史离职导入验收：真实授权器下的“导入操作员”（S3c 错误文件裁剪等场景用）。
 * 与 AC-DM-30-authz.test.ts 的 operator 同一构造，另提供：按字段撤“查看权”、撤对象看全部范围、
 * 以该操作员身份发任意请求（GET 下载等）。读写租户数据一律走 withTenant（app_owner 可过，DEC-568）。
 */
import { bootstrapTenantAdmin } from '@italent/api';
import { MODULE_OBJECTS, PERSONNEL_OBJECT, PERSONNEL_OBJECTS, SUBSETS } from '@italent/domain';
import { expect } from 'vitest';
import type { ImportWorld } from '../AC-DM-30-support.js';
import { addMember, createProfile, grant, makeGrantable, setObjectPermission } from '../AC-PRM-support.js';
import { cmd, tenantApi } from './tenant-api.js';
import { uniqueSuffix } from './unique.js';

export const IMPORT_BUTTON = 'Employment.DimissionImport';
export const EMPLOYEE_OBJECT_CODE = MODULE_OBJECTS.employee.code;
export const RECORD_OBJECT_CODE = MODULE_OBJECTS.employmentRecord.code;
export const PROFILE_OBJECT_CODE = PERSONNEL_OBJECT;
const EDUCATION = SUBSETS.education.objectCode;
const OBJECTS = [...Object.values(MODULE_OBJECTS), ...PERSONNEL_OBJECTS];
const SCOPE_TARGETS = [RECORD_OBJECT_CODE, EMPLOYEE_OBJECT_CODE, PROFILE_OBJECT_CODE, EDUCATION];

/** 本身份缺的权限。 */
export interface OperatorRevoke {
  /** 某对象的某字段没有查看权（编辑权一并收回）。 */
  noView?: readonly (readonly [object: string, field: string])[];
  noButton?: boolean;
}

export async function importOperator(x: ImportWorld, revoke: OperatorRevoke = {}) {
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
  const configure = async (missing: OperatorRevoke) => {
    const hidden = (object: string, field: string) => missing.noView?.some(([o, f]) => o === object && f === field);
    for (const definition of OBJECTS) {
      const response = await setObjectPermission(
        pw,
        profile,
        {
          dataOperations: { create: true, update: true, delete: true },
          fields: definition.fields.map((f) => ({
            fieldCode: f.code,
            view: !hidden(definition.code, f.code),
            edit: !f.system && !hidden(definition.code, f.code),
          })),
          buttons: definition.buttons
            .filter((b) => !(missing.noButton && b.code === IMPORT_BUTTON))
            .map((b) => ({ buttonCode: b.code, level: b.level })),
        },
        definition.code,
      );
      expect(response.status, `${definition.code} ${await response.clone().text()}`).toBe(200);
    }
  };
  await configure(revoke);
  /** 看全部范围：第一次 PUT 为 revision 0 → 1；撤销再 PUT 一次（revision 1），同 F061 的写法。 */
  const putScope = async (target: string, seeAll: boolean, ifMatch: number) => {
    const response = await pw.api.request(
      'PUT',
      `/api/tenant/permission/profiles/${profile.id}/data-scopes/TenantBase`,
      { ...pw.asAdmin, ifMatch, body: { targetKind: 'entity', targetCode: target, seeAll } },
    );
    expect(response.status, await response.clone().text()).toBe(200);
  };
  for (const target of SCOPE_TARGETS) await putScope(target, true, 0);
  await makeGrantable(pw, [profile.id]);
  const member = await addMember(pw, `imp-op-${uniqueSuffix()}`);
  expect((await grant(pw, member.id, profile.id)).status).toBe(201);

  const as = { user: member.id, tenant: tenant.id };
  const submit = (rows: readonly unknown[], fileName = '合成导入.xlsx') =>
    pw.api.request('POST', '/api/tenant/employment/exits/import', {
      ...as,
      body: { fileName, rows },
      idempotencyKey: `dm30-op-${uniqueSuffix()}`,
    });
  const get = (path: string) => pw.api.request('GET', `/api/tenant/employment${path}`, as);
  return {
    userId: member.id,
    submit,
    get,
    /** 以该操作员读自己的站内消息。 */
    notifications: () => pw.api.request('GET', '/api/tenant/approval/notifications', as),
    reconfigure: configure,
    /** 撤销某对象的“看全部”范围。 */
    revokeScope: (target: string) => putScope(target, false, 1),
  };
}
