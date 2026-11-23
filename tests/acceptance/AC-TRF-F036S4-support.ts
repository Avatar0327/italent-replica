/**
 * F-036-S4（AC-TRF-64～66）共用夹具：员工本人调动草稿 + HR 改当前任职的传播链路。
 * 全部从真实 HTTP 入口造数据（createApp + app.request），不直接插来源行；员工用真实授权器，HR 用放行授权器。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { MODULE_OBJECTS, effectiveOrigin } from '@italent/domain';
import { expect } from 'vitest';
import { loadFieldOrigins } from '../../apps/api/src/modules/employment/field-origin-store.js';
import { approvalWorld, permissionAdmin, type InstanceView, type Person } from './AC-APV-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';

export const BASE = '/api/tenant/employment';
export const DATE = '2026-10-19';
export const LATER = '2026-10-26';
/** 员工自助单据上有同值放行规则的四个字段（DEC-950）。 */
export const FOUR = ['positionId', 'postId', 'levelId', 'sequenceId'] as const;
export type Four = (typeof FOUR)[number];
export type Fields = Record<string, unknown>;

export interface Draft {
  readonly id: string;
  readonly revision: number;
}

export async function selfWorld(db: Db, label: string) {
  const w = await approvalWorld(db, label);
  const api = tenantApi(db, { authorize: undefined, clock: w.clock });
  const admin = await permissionAdmin(w);
  const source = await w.org('合成原部门');
  const reviewer = await w.person('合成审批人', source);
  // 指定审批人，可在节点上改职位与职务（来源 approval-edit），供甲夹具与不可信来源夹具使用。
  await w.publishedProcess({
    nodes: [
      {
        key: 'review',
        approver: { type: 'specified', value: reviewer.userId },
        formFields: ['departmentId', 'effectiveDate', 'positionId', 'postId', 'levelId', 'sequenceId'],
        editableFields: ['positionId', 'postId', 'levelId', 'sequenceId'],
        editMode: 'separate',
      },
    ],
  });
  const created = async <T>(path: string, body: object) =>
    w.json<T>(await w.request(w.hr.id, 'POST', `/api/tenant/job/${path}`, { ifMatch: 0, body }), 201);
  const stamp = () => randomUUID().replaceAll('-', '');
  const base = () => ({ name: `合成-${stamp()}`, code: `S4_${stamp()}`, startDate: '2020-01-01' });

  const jobs = {
    sequence: () => created<{ id: string }>('sequences', base()).then((row) => row.id),
    post: (sequenceId?: string) =>
      created<{ id: string }>('posts', { ...base(), ...(sequenceId ? { sequenceId } : {}) }).then((row) => row.id),
    level: async () => {
      const type = await created<{ id: string }>('level-types', base());
      await w.grantHrJobUnit();
      return created<{ id: string }>('levels', { ...base(), level: 1, levelTypeId: type.id }).then((row) => row.id);
    },
    position: (postId: string, orgId = source) =>
      created<{ id: string }>('positions', { ...base(), orgId, postId }).then((row) => row.id),
  };

  /** 原任职里职位、职务、职级、序列都有值的一组基础数据。 */
  async function catalog() {
    const sequence = await jobs.sequence();
    const post = await jobs.post(sequence);
    const level = await jobs.level();
    const position = await jobs.position(post);
    return { sequence, post, level, position };
  }

  /** 员工身份：可编辑除只读上限与（默认）职位之外的全部非系统字段，随 `positionEdit` 开关职位编辑权。 */
  async function employee(name: string, fields: Fields = {}) {
    const person = await w.person(name, source, fields);
    const profile = await createProfile(admin, `s4-${randomUUID()}`);
    const def = MODULE_OBJECTS.employmentRecord;
    const grantable = async (positionEdit: boolean) =>
      w.json(
        await setObjectPermission(
          admin,
          profile,
          {
            dataOperations: { create: true, update: true, delete: false },
            fields: def.fields.map((field) => ({
              fieldCode: field.code,
              view: true,
              edit: !field.system && (positionEdit || field.code !== 'positionId'),
            })),
            buttons: def.buttons
              .filter((button) => !button.code.startsWith('Transfer.') || button.code === 'Transfer.Self')
              .map((button) => ({ buttonCode: button.code, level: button.level })),
          },
          def.code,
        ),
      );
    await grantable(false);
    await makeGrantable(admin, [profile.id]);
    await w.json(await grant(admin, person.userId, profile.id), 201);
    await w.json(
      await admin.api.request('PUT', `/api/tenant/permission/scopes/${person.userId}/TenantBase`, {
        ...admin.asAdmin,
        ifMatch: 0,
        body: { kind: 'org_range', orgRanges: [{ orgId: source, includeDescendants: false }] },
      }),
    );
    const recordId = resultRows<{ id: string }>(
      await withTenant(db, w.tenant.id, (tx) =>
        tx.execute(sql`SELECT id FROM employment_records
          WHERE tenant_id = ${w.tenant.id} AND employee_id = ${person.employeeId}::uuid`),
      ),
    )[0]!.id;
    return { ...person, recordId, positionEdit: grantable };
  }
  type Employee = Awaited<ReturnType<typeof employee>>;

  const as = (person: Pick<Person, 'userId'>) => w.as(person.userId);
  const employeeRevision = async (person: Pick<Person, 'userId'>) =>
    (
      await w.json<{ employee: { revision: number } }>(
        await api.request('GET', '/api/tenant/self-service/profile', as(person)),
      )
    ).employee.revision;

  /** 员工建调动草稿（不提交）；`fields` 默认只带部门，职位等一律继承。 */
  async function draftOf(person: Pick<Person, 'userId' | 'employeeId'>, fields: Fields = {}, effectiveDate = DATE) {
    return w.json<Draft>(
      await api.request('POST', `${BASE}/transfers/employees/${person.employeeId}`, {
        ...as(person),
        ifMatch: await employeeRevision(person),
        body: {
          initiator: 'employee',
          transferTypeCode: 'in_department',
          formId: 'TenantBase.TransferMultiFormView',
          effectiveDate,
          mode: 'application',
          submit: false,
          fields: { departmentId: source, ...fields },
        },
      }),
      201,
    );
  }

  /** 员工 PATCH 草稿；`revision` 缺省时先读当前版本，`key` 缺省自动生成。 */
  async function patch(
    person: Pick<Person, 'userId'>,
    id: string,
    body: object,
    options: { revision?: number; key?: string } = {},
  ) {
    const revision = options.revision ?? (await show(id)).revision;
    return api.request('PATCH', `${BASE}/businesses/${id}`, {
      ...as(person),
      ifMatch: revision,
      ...(options.key ? { idempotencyKey: options.key } : {}),
      body,
    });
  }
  async function submit(person: Pick<Person, 'userId'>, id: string, options: { revision?: number; key?: string } = {}) {
    const revision = options.revision ?? (await show(id)).revision;
    return api.request('POST', `${BASE}/businesses/${id}/submit`, {
      ...as(person),
      ifMatch: revision,
      ...(options.key ? { idempotencyKey: options.key } : {}),
      body: {},
    });
  }
  async function show(id: string) {
    return w.json<{ id: string; revision: number; status: string; fields: Fields; effectiveDate: string }>(
      await w.request(w.hr.id, 'GET', `${BASE}/businesses/${id}`),
    );
  }

  /** HR 改员工当前任职（`PATCH /records/:id`），向后更新会传播进本人草稿。 */
  async function hrEditCurrent(person: Employee, fields: Fields) {
    const record = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `${BASE}/records/${person.recordId}`),
    );
    return w.request(w.hr.id, 'PATCH', `${BASE}/records/${person.recordId}`, {
      ifMatch: record.revision,
      body: { fields },
    });
  }

  /** 草稿上某字段的最后写入来源与值（从台账折叠，不直接读载荷）。 */
  async function origin(businessId: string, field: Four | 'effectiveDate') {
    return withTenant(db, w.tenant.id, async (tx) => {
      const state = (await loadFieldOrigins(tx, { tenantId: w.tenant.id }, businessId, [`preset:${field}`])).get(
        `preset:${field}`,
      );
      const { value, lastWriter } = effectiveOrigin(state);
      return { value, kind: lastWriter?.originKind ?? null };
    });
  }

  /** “零写入”的三处行数里阶段 ① 存在的两处：载荷版本数、来源行数（employment_propagation_commands 阶段 ② 才有）。 */
  async function counts(businessId: string) {
    return withTenant(db, w.tenant.id, async (tx) => {
      const [row] = resultRows<{ versions: number; origins: number }>(
        await tx.execute(sql`
        SELECT (SELECT count(*)::int FROM employment_payload_versions
                  WHERE tenant_id = ${w.tenant.id} AND business_id = ${businessId}::uuid) AS versions,
               (SELECT count(*)::int FROM employment_field_origins
                  WHERE tenant_id = ${w.tenant.id} AND business_id = ${businessId}::uuid) AS origins`),
      );
      return row!;
    });
  }

  /** 员工提交后，HR 在审批节点改字段（approval-edit）；`reject` 为真时接着驳回，单据回到 rejected。 */
  async function reviewEdit(person: Pick<Person, 'userId'>, id: string, fields: Fields, reject = false) {
    const instance = await w.instanceOf(id, person.userId);
    const edited = await w.json<InstanceView>(
      await w.taskAction(reviewer.userId, w.pending(instance)[0]!.id, 'edit', instance.revision, { fields }),
    );
    if (reject)
      await w.json(
        await w.taskAction(reviewer.userId, w.pending(edited)[0]!.id, 'reject', edited.revision, { comment: '退回' }),
      );
  }

  return {
    w,
    api,
    admin,
    source,
    reviewer,
    jobs,
    catalog,
    employee,
    draftOf,
    patch,
    submit,
    show,
    hrEditCurrent,
    reviewEdit,
    origin,
    counts,
  };
}
export type SelfWorld = Awaited<ReturnType<typeof selfWorld>>;

export async function ok(response: Response, status = 200) {
  expect(response.status, await response.clone().text()).toBe(status);
  return response;
}
