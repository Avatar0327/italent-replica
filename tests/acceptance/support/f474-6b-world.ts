/**
 * F-474-6b 共用夹具：真实授权器下的组织 + 租户自定义字段 + 按字段授权的操作人（合成数据，邮箱 example.com）。
 * 种子数据走“全放行”应用，被测请求走真实授权器，保证字段权限判定是真实的。
 */
import { MODULE_OBJECTS } from '@italent/domain';
import type { Db } from '@italent/db';
import { expect } from 'vitest';
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

export const AT = '2026-10-01';
const clock = () => new Date(`${AT}T01:00:00.000Z`);
const FIELDS = '/api/tenant/employment/custom-fields';
const ORG_BASE = '/api/tenant/org';

export type FieldMode = 'edit' | 'view' | 'none';
export type ValueType = 'text' | 'integer' | 'decimal' | 'boolean' | 'date' | 'select';
export interface Definition {
  id: string;
  revision: number;
}
export interface OrgDto {
  id: string;
  revision: number;
  name?: string;
  customFields?: Record<string, unknown>;
  [key: string]: unknown;
}

export async function customFieldWorld(db: Db) {
  const world = await seedPermissionWorld(db);
  const real = tenantApi(db, { authorize: undefined, clock });
  const setup = tenantApi(db, { clock });
  const suffix = uniqueSuffix();
  const object = MODULE_OBJECTS.organization;

  async function define(
    name: string,
    valueType: ValueType = 'text',
    options?: { value: string; label: string; enabled: boolean }[],
    target: typeof world = world,
  ): Promise<Definition> {
    const created = await target.api.request('POST', FIELDS, {
      ...target.asAdmin,
      ifMatch: 0,
      body: { name, objectType: 'organization', valueType, ...(valueType === 'select' ? { options } : {}) },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    return (await created.json()) as Definition;
  }

  /** 顶层组织：操作人的数据范围落在它及其下级。 */
  async function top(): Promise<OrgDto> {
    return seedOrg('顶层', world.tenant.id);
  }
  async function seedOrg(name: string, parentId: string, extra: Record<string, unknown> = {}): Promise<OrgDto> {
    const response = await setup.request('POST', `${ORG_BASE}/organizations`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { name: `${name}${suffix}`, establishedOn: '2000-01-01', parents: { admin: { parentId } }, ...extra },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as OrgDto;
  }

  /** modes：自定义字段 ID → 权限；标准字段对操作人全部可看可编辑（系统字段只读）。 */
  async function operator(rootOrgId: string, modes: Record<string, FieldMode>, label = 'op') {
    const profile = await createProfile(world, `c6b-${label}-${uniqueSuffix()}`);
    const standard = object.fields.map((field) => ({ fieldCode: field.code, view: true, edit: !field.system }));
    const custom = Object.entries(modes)
      .filter(([, mode]) => mode !== 'none')
      .map(([id, mode]) => ({ fieldCode: `custom:${id}`, view: true, edit: mode === 'edit' }));
    const saved = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: true, update: true, delete: false },
        fields: [...standard, ...custom],
        buttons: object.buttons.map((button) => ({ buttonCode: button.code, level: button.level })),
      },
      object.code,
    );
    expect(saved.status, await saved.clone().text()).toBe(200);
    await makeGrantable(world, [profile.id]);
    const user = await addMember(world, `${label}${suffix}`);
    expect((await grant(world, user.id, profile.id)).status).toBe(201);
    const scope = await real.request('PUT', `/api/tenant/permission/scopes/${user.id}/TenantBase`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { kind: 'org_range', orgRanges: [{ orgId: rootOrgId, includeDescendants: true }] },
    });
    expect(scope.status, await scope.clone().text()).toBe(200);
    const as = { user: user.id, tenant: world.tenant.id };
    /** 更新字段权限（撤销 / 追加）后同一身份下一次请求立即生效。 */
    const regrant = async (next: Record<string, FieldMode>) => {
      const rows = Object.entries(next)
        .filter(([, mode]) => mode !== 'none')
        .map(([id, mode]) => ({ fieldCode: `custom:${id}`, view: true, edit: mode === 'edit' }));
      const response = await setObjectPermission(
        world,
        profile,
        {
          dataOperations: { create: true, update: true, delete: false },
          fields: [...standard, ...rows],
          buttons: object.buttons.map((button) => ({ buttonCode: button.code, level: button.level })),
        },
        object.code,
      );
      expect(response.status, await response.clone().text()).toBe(200);
    };
    const request = (method: string, path: string, options: { body?: unknown; ifMatch?: number } = {}) =>
      real.request(method, `${ORG_BASE}${path}`, { ...as, ...options });
    return { as, request, regrant };
  }

  /** 全放行（管理视角），用于对照与种子。 */
  const admin = (method: string, path: string, options: { body?: unknown; ifMatch?: number } = {}) =>
    setup.request(method, `${ORG_BASE}${path}`, { ...world.asAdmin, ...options });

  return { world, real, setup, suffix, define, top, seedOrg, operator, admin };
}

export type CustomFieldWorld = Awaited<ReturnType<typeof customFieldWorld>>;
