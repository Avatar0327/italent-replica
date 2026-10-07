/** AC-TRF-01/02/03/19/20/24/25：真实授权器校验发起方、源员工范围和目标部门范围。 */
import { randomUUID } from 'node:crypto';
import { permissionUserPersonLinks, withTenant } from '@italent/db';
import { createEmploymentBusiness } from '../../apps/api/src/modules/employment/write-service.js';
import { MODULE_OBJECTS } from '@italent/domain';
import type { Db } from '@italent/db';
import { expect } from 'vitest';
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

const BASE = '/api/tenant/employment/transfers';
const STANDARD = 'TenantBase.CrossDepartmentTransferMultiFormView';
const EFFECTIVE_DATE = '2026-10-01';
const INITIATOR_BUTTONS = ['Transfer.Hr', 'Transfer.Manager', 'Transfer.Self'];
const DIRECT_BUTTONS = ['EmploymentRecord.LineOp.Transfer', 'Employment.Tranfer'];

interface Person {
  readonly id: string;
  readonly revision: number;
}
interface Actor {
  readonly user: string;
  readonly tenant: string;
}

export async function transferWorld(db: Db) {
  const original = await seedPermissionWorld(db);
  const clock = () => new Date(`${EFFECTIVE_DATE}T01:00:00.000Z`);
  const api = tenantApi(db, { authorize: undefined, clock });
  const setup = tenantApi(db, { clock });
  const world = { ...original, api };
  async function create(path: string, body: object, revision = 0) {
    const response = await setup.request('POST', `/api/tenant/${path}`, {
      ...world.asAdmin,
      ifMatch: revision,
      body,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string; revision: number; employeeRevision: number };
  }
  const org = (name: string) =>
    create('org/organizations', {
      name,
      establishedOn: '2025-01-01',
      parents: { admin: { parentId: world.tenant.id } },
    });
  const inside = await org('调动管理范围内部门');
  const outside = await org('调动管理范围外部门');
  // 本组聚焦部门范围；其他场景排除字段配置只读，DEC-163 的部门必填与留空另有真实表单验收。
  const configured = await setup.request('PUT', `${BASE}/forms/${STANDARD}`, {
    ...world.asAdmin,
    ifMatch: 0,
    body: {
      name: '合成部门范围调动表单',
      group: 'transfer',
      fieldModes: {
        'preset:positionId': 'readonly',
        'preset:directManagerId': 'readonly',
        'preset:dottedManagerId': 'readonly',
      },
    },
  });
  expect(configured.status, await configured.clone().text()).toBe(200);

  async function person(
    departmentId = inside.id,
    binding?: Actor,
    directManagerId?: string,
    options: {
      effectiveDate?: string;
      employType?: string;
      /** F-022 入职写入端口（R2-T01 接线前由可信夹具调用）：待入职、是否有试用期。 */
      entry?: { pendingEntry?: boolean; probation?: boolean };
    } = {},
  ): Promise<Person> {
    const employee = await create('employment/employees', { name: '合成调动员工', code: `TRF_${randomUUID()}` });
    if (binding) {
      // 已绑定用户的可信夹具；账号绑定自身的业务验收在 AC-PRM-31/32。
      await withTenant(db, world.tenant.id, (tx) =>
        tx.insert(permissionUserPersonLinks).values({
          tenantId: world.tenant.id,
          userId: binding.user,
          employeeId: employee.id,
        }),
      );
    }
    if (options.entry) {
      const business = await withTenant(db, world.tenant.id, (tx) =>
        createEmploymentBusiness(
          tx,
          {
            tenantId: world.tenant.id,
            userId: world.asAdmin.user,
            timezone: world.tenant.timezone,
            now: clock(),
            commandId: randomUUID(),
            expectedRevision: employee.revision,
          },
          employee.id,
          {
            kind: 'hire',
            mode: 'direct',
            effectiveDate: options.effectiveDate ?? '2026-01-01',
            fields: {
              departmentId,
              ...(directManagerId ? { directManagerId } : {}),
              ...(options.employType ? { employType: options.employType as 'internal' } : {}),
            },
          },
          { entry: options.entry },
        ),
      );
      return { id: employee.id, revision: business.employeeRevision };
    }
    const hire = await create(
      `employment/employees/${employee.id}/businesses`,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: options.effectiveDate ?? '2026-01-01',
        fields: {
          departmentId,
          ...(directManagerId ? { directManagerId } : {}),
          ...(options.employType ? { employType: options.employType } : {}),
        },
        ...(binding ? {} : { loginEmail: loginEmailOf(employee.id) }),
      },
      employee.revision,
    );
    return { id: employee.id, revision: hire.employeeRevision };
  }

  async function actor(
    label: string,
    options: { empty?: boolean; role?: string; direct?: boolean; hidden?: string[] } = {},
  ) {
    const user = await addMember(world, label);
    const profile = await createProfile(world, `${label.slice(0, 26)}-${randomUUID()}`);
    const definition = MODULE_OBJECTS.employmentRecord;
    const buttons = definition.buttons
      .filter((button) => ![...INITIATOR_BUTTONS, ...DIRECT_BUTTONS].includes(button.code))
      .map((button) => ({ buttonCode: button.code, level: button.level }));
    buttons.push({ buttonCode: options.role ?? 'Transfer.Hr', level: 'detail' });
    if (options.direct !== false) buttons.push({ buttonCode: 'EmploymentRecord.LineOp.Transfer', level: 'list_row' });
    const permission = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: true, update: true, delete: false },
        fields: definition.fields.map((field) => ({
          fieldCode: field.code,
          view: !options.hidden?.includes(field.code),
          edit: !field.system && !options.hidden?.includes(field.code),
        })),
        buttons,
      },
      definition.code,
    );
    expect(permission.status, await permission.clone().text()).toBe(200);
    await makeGrantable(world, [profile.id]);
    expect((await grant(world, user.id, profile.id)).status).toBe(201);
    if (!options.empty) {
      const scope = await api.request('PUT', `/api/tenant/permission/scopes/${user.id}/TenantBase`, {
        ...world.asAdmin,
        ifMatch: 0,
        body: { kind: 'org_range', orgRanges: [{ orgId: inside.id, includeDescendants: false }] },
      });
      expect(scope.status).toBe(200);
    }
    return { user: user.id, tenant: world.tenant.id };
  }

  let settingsRevision = 0;
  async function settings(unrestrictTargetDepartment: boolean) {
    const response = await setup.request('PUT', `${BASE}/settings`, {
      ...world.asAdmin,
      ifMatch: settingsRevision,
      body: { unrestrictTargetDepartment, autoPopulate: true },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    settingsRevision = ((await response.json()) as { revision: number }).revision;
  }
  function transfer(as: Actor, employee: Person, extra: object = {}, preview = false) {
    return api.request('POST', `${BASE}/employees/${employee.id}${preview ? '/preview' : ''}`, {
      ...as,
      ifMatch: employee.revision,
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        formId:
          (extra as { initiator?: string }).initiator === 'employee'
            ? 'TenantBase.PersonalCrossDepartmentTransferMultiFormView'
            : STANDARD,
        effectiveDate: EFFECTIVE_DATE,
        mode: 'application',
        fields: { departmentId: outside.id },
        ...extra,
      },
    });
  }
  async function currentRevision(employee: Person) {
    const response = await setup.request('GET', `/api/tenant/employment/employees/${employee.id}`, world.asAdmin);
    expect(response.status).toBe(200);
    return ((await response.json()) as { revision: number }).revision;
  }
  return { ...world, setup, inside, outside, actor, person, settings, transfer, currentRevision };
}
