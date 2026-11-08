/**
 * F-474-2b 共用夹具：真实授权器下的组织树 + 在岗人员 + 不同组织范围的查看人（合成数据，邮箱 example.com）。
 *
 * 行政树（asOf = AT）：根(租户) ├ 甲 ├ 甲一（甲的下级） └ 乙。
 * 人员：甲一 2 人在岗 + 1 人已离职；甲 1 人；乙 1 人。离职人员不计入在岗（docs/02_业务建模/18 §11）。
 */
import { MODULE_OBJECTS } from '@italent/domain';
import { loginEmailOf } from '../AC-EMP-support.js';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
} from '../AC-PRM-support.js';
import { tenantApi } from './tenant-api.js';
import { uniqueSuffix } from './unique.js';
import type { Db } from '@italent/db';
import { expect } from 'vitest';

export const AT = '2026-10-01';
const HIRE_DATE = '2026-01-01';
const clock = () => new Date(`${AT}T01:00:00.000Z`);

export interface OrgNodeDto {
  id: string;
  name?: string;
  code?: string;
  headcount?: number;
  children?: OrgNodeDto[];
  [field: string]: unknown;
}

export async function orgWorld(db: Db) {
  const world = await seedPermissionWorld(db);
  const api = tenantApi(db, { authorize: undefined, clock });
  const setup = tenantApi(db, { clock });
  const post = async (path: string, body: object, revision = 0) => {
    const response = await setup.request('POST', `/api/tenant/${path}`, { ...world.asAdmin, ifMatch: revision, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string; revision: number; employeeRevision: number };
  };
  const suffix = uniqueSuffix();
  const org = (name: string, parentId: string, extra: Record<string, unknown> = {}) =>
    post('org/organizations', {
      name: `${name}${suffix}`,
      establishedOn: '2000-01-01',
      parents: { admin: { parentId } },
      ...extra,
    });
  const a = await org('甲部', world.tenant.id);
  const a1 = await org('甲一组', a.id);
  const b = await org('乙部', world.tenant.id);

  async function hire(name: string, departmentId: string, fields: Record<string, unknown> = {}) {
    const employee = await post('employment/employees', { name: `${name}${suffix}`, code: `E${uniqueSuffix()}` });
    const hired = await post(
      `employment/employees/${employee.id}/businesses`,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: HIRE_DATE,
        fields: { employType: 'internal', departmentId, ...fields },
        loginEmail: loginEmailOf(employee.id),
      },
      employee.revision,
    );
    return { id: employee.id, name: `${name}${suffix}`, revision: hired.employeeRevision };
  }
  const regular = await hire('甲一正式', a1.id);
  await hire('甲一成员', a1.id);
  const leaver = await hire('甲一离职', a1.id);
  await hire('甲部成员', a.id);
  await hire('乙部成员', b.id);
  await post(
    `employment/employees/${leaver.id}/businesses`,
    { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-15' },
    leaver.revision,
  );
  // 甲的负责人：甲一的正式员工（姓名走人员版本链）
  await setup.request('PATCH', `/api/tenant/org/organizations/${a.id}`, {
    ...world.asAdmin,
    ifMatch: a.revision,
    body: { personInChargeId: regular.id, effectiveDate: AT },
  });

  const definition = MODULE_OBJECTS.organization;
  type Range = { orgId: string; includeDescendants: boolean };
  /** 组织范围 = ranges；ranges 为 null 表示不配置范围（fail-closed）；hidden 为被撤销查看的字段。 */
  let seq = 0;
  async function viewer(label: string, ranges: Range[] | null, hidden: string[] = []) {
    const code = `v${++seq}-${suffix}`;
    const user = await addMember(world, `${label}${suffix}`);
    const profile = await createProfile(world, code);
    const save = (hide: string[]) =>
      setObjectPermission(
        world,
        profile,
        {
          dataOperations: { create: false, update: false, delete: false },
          fields: definition.fields.map((f) => ({ fieldCode: f.code, view: !hide.includes(f.code), edit: false })),
          buttons: definition.buttons.map((button) => ({ buttonCode: button.code, level: button.level })),
        },
        definition.code,
      );
    expect((await save(hidden)).status).toBe(200);
    await makeGrantable(world, [profile.id]);
    expect((await grant(world, user.id, profile.id)).status).toBe(201);
    if (ranges) {
      const scope = await api.request('PUT', `/api/tenant/permission/scopes/${user.id}/TenantBase`, {
        ...world.asAdmin,
        ifMatch: 0,
        body: { kind: 'org_range', orgRanges: ranges },
      });
      expect(scope.status, await scope.clone().text()).toBe(200);
    }
    const as = { user: user.id, tenant: world.tenant.id };
    const get = (path: string) => api.request('GET', `/api/tenant/org/${path}`, as);
    return { as, get, save };
  }
  /** 全部放行的管理视角（allowAll），用于对照“范围内外”。 */
  const full = (path: string) => setup.request('GET', `/api/tenant/org/${path}`, world.asAdmin);
  return { world, a, a1, b, regular, viewer, full, suffix };
}

export type OrgWorld = Awaited<ReturnType<typeof orgWorld>>;
