// F-361② 人员子集附件验收夹具。作用对象：复刻系统（合成数据）；全部走真实授权器（world.api），不注入放行授权器。
// HR 身份按 PersonnelObject + 教育经历对象配置字段权限：附件字段（educationCertificate 等）的查看 / 编辑可单独收放。
import { randomUUID } from 'node:crypto';
import { attachmentFiles, and, eq, withTenant, type Db } from '@italent/db';
import { PERSONNEL_OBJECT, PERSONNEL_OBJECTS, SUBSETS } from '@italent/domain';
import { expect } from 'vitest';
import { png, sha256, type Receipt } from './AC-ATT-support.js';
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
import { uniqueSuffix } from './support/unique.js';

export const KIND = 'education';
export const PURPOSE = 'personnel.subset_attachment';
export const FIELD = 'educationCertificate';
export const OTHER_FIELD = 'degreeCertificate';
const OBJECT = SUBSETS.education.objectCode;
const ATTACHMENT_FIELDS = ['educationCertificate', 'degreeCertificate', 'attachmentId'];

export type As = { tenant: string; user: string };
export type World = Awaited<ReturnType<typeof seedPermissionWorld>>;

export interface ActorOptions {
  /** 附件字段（三个）的查看 / 编辑权；默认都有 */
  attachmentView?: boolean;
  attachmentEdit?: boolean;
  /** 教育经历对象的数据操作；默认新增、修改、删除都有 */
  operations?: { create: boolean; update: boolean; delete: boolean };
  /** 人员主对象 update；默认有 */
  personnelUpdate?: boolean;
  /** 数据范围：默认只含 inside 部门 */
  orgs?: 'inside' | 'both';
}

export async function personnelWorld(db: Db) {
  const world = await seedPermissionWorld(db);
  const setup = tenantApi(world.db);
  const create = async (path: string, body: object, ifMatch = 0) => {
    const res = await setup.request('POST', `/api/tenant/${path}`, { ...world.asAdmin, body, ifMatch });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as { id: string };
  };
  const org = (name: string) =>
    create('org/organizations', {
      name,
      establishedOn: '2020-01-01',
      parents: { admin: { parentId: world.tenant.id } },
    });
  const inside = await org('合成范围内部门');
  const outside = await org('合成范围外部门');
  const hire = async (name: string, department: { id: string }) => {
    const employee = await create('employment/employees', { code: `F361-${uniqueSuffix()}`, name });
    await create(
      `employment/employees/${employee.id}/businesses`,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2020-01-01',
        fields: { departmentId: department.id },
        loginEmail: loginEmailOf(employee.id),
      },
      1,
    );
    return employee;
  };
  const target = await hire('合成员工甲', inside);
  const stranger = await hire('合成员工乙', outside);

  async function configure(profile: Awaited<ReturnType<typeof createProfile>>, o: ActorOptions) {
    const view = o.attachmentView ?? true;
    const edit = o.attachmentEdit ?? true;
    const subset = PERSONNEL_OBJECTS.find((x) => x.code === OBJECT)!;
    const employee = PERSONNEL_OBJECTS.find((x) => x.code === PERSONNEL_OBJECT)!;
    const put = async (code: string, body: object) => {
      const res = await setObjectPermission(world, profile, body as never, code);
      expect(res.status, await res.clone().text()).toBe(200);
    };
    await put(PERSONNEL_OBJECT, {
      dataOperations: { create: false, update: o.personnelUpdate ?? true, delete: false },
      fields: employee.fields.map((f) => ({ fieldCode: f.code, view: true, edit: !f.system })),
      buttons: employee.buttons.map((b) => ({ buttonCode: b.code, level: b.level })),
    });
    await put(OBJECT, {
      dataOperations: o.operations ?? { create: true, update: true, delete: true },
      fields: subset.fields.map((f) => {
        const attachment = ATTACHMENT_FIELDS.includes(f.code);
        return { fieldCode: f.code, view: attachment ? view : true, edit: attachment ? edit : !f.system };
      }),
      buttons: subset.buttons.map((b) => ({ buttonCode: b.code, level: b.level })),
    });
  }

  /** HR：同一身份可重新配置（撤权用例）；数据范围按 org_range 授予。 */
  async function actor(label: string, options: ActorOptions = {}) {
    const user = await addMember(world, label);
    const profile = await createProfile(world, `${label}-${uniqueSuffix()}`);
    await configure(profile, options);
    await makeGrantable(world, [profile.id]);
    expect((await grant(world, user.id, profile.id)).status).toBe(201);
    const ranges = [inside, ...(options.orgs === 'both' ? [outside] : [])];
    const scope = await world.api.request('PUT', `/api/tenant/permission/scopes/${user.id}/TenantBase`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { kind: 'org_range', orgRanges: ranges.map((r) => ({ orgId: r.id, includeDescendants: false })) },
    });
    expect(scope.status, await scope.clone().text()).toBe(200);
    return {
      as: { tenant: world.tenant.id, user: user.id } as As,
      reconfigure: (o: ActorOptions) => configure(profile, o),
    };
  }

  const base = (employeeId: string) => `/api/tenant/personnel/employees/${employeeId}/subsets/${KIND}`;
  const json = async <T>(res: Response, status: number): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as T;
  };

  const register = (
    as: As,
    employeeId: string,
    bytes: Buffer,
    o: Partial<Record<string, unknown>> = {},
    key?: string,
  ) =>
    world.api.request('POST', `${base(employeeId)}/attachments`, {
      ...as,
      idempotencyKey: key,
      body: {
        field: FIELD,
        filename: 'cert.png',
        contentType: 'image/png',
        byteSize: bytes.length,
        sha256: sha256(bytes),
        ...o,
      },
    });
  const upload = (as: As, employeeId: string, id: string, bytes: Buffer, revision: number, key?: string) =>
    world.api.request('POST', `${base(employeeId)}/attachments/${id}/upload`, {
      ...as,
      idempotencyKey: key,
      ifMatch: revision,
      body: { base64: bytes.toString('base64') },
    });
  const remove = (as: As, employeeId: string, id: string, revision: number) =>
    world.api.request('DELETE', `${base(employeeId)}/attachments/${id}`, { ...as, ifMatch: revision });
  const download = (as: As, employeeId: string, recordId: string, fileId: string) =>
    world.api.request('GET', `${base(employeeId)}/${recordId}/attachments/${fileId}/content`, as);

  /** 登记并上传一张，返回上传后的回执。 */
  async function stored(as: As, employeeId: string, bytes: Buffer = png(), field: string = FIELD) {
    const registered = await json<Receipt>(await register(as, employeeId, bytes, { field }), 201);
    return json<Receipt>(await upload(as, employeeId, registered.id, bytes, registered.revision), 200);
  }

  const createSubset = (as: As, employeeId: string, body: object) =>
    world.api.request('POST', base(employeeId), { ...as, ifMatch: 0, body });
  const patchSubset = (as: As, employeeId: string, id: string, revision: number, body: object) =>
    world.api.request('PATCH', `${base(employeeId)}/${id}`, { ...as, ifMatch: revision, body });
  const deleteSubset = (as: As, employeeId: string, id: string, revision: number) =>
    world.api.request('DELETE', `${base(employeeId)}/${id}`, { ...as, ifMatch: revision });
  const detail = (as: As, employeeId: string, id: string) => world.api.request('GET', `${base(employeeId)}/${id}`, as);

  const row = (id: string) =>
    withTenant(world.db, world.tenant.id, async (tx) => {
      const [found] = await tx
        .select()
        .from(attachmentFiles)
        .where(and(eq(attachmentFiles.tenantId, world.tenant.id), eq(attachmentFiles.id, id)));
      return found;
    });

  return {
    ...world,
    target,
    stranger,
    inside,
    actor,
    json,
    register,
    upload,
    remove,
    download,
    stored,
    createSubset,
    patchSubset,
    deleteSubset,
    detail,
    row,
    base,
  };
}

export type F361World = Awaited<ReturnType<typeof personnelWorld>>;
export const newKey = () => randomUUID();
