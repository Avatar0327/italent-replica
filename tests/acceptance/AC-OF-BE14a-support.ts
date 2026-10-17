/**
 * BE-14a Offer 验收夹具：租户 + 管理员，录用部门、员工（直线上级 / HRBP）、职级、合同主体用现有接口或可信 SQL 造数。
 * authorize 可替换，用于按钮 / 范围拒绝用例；造数始终走“全部允许”的另一个应用实例。
 */
import { randomUUID } from 'node:crypto';
import { bootstrapTenantAdmin, type Authorizer } from '@italent/api';
import { MODULE_OBJECTS, type ObjectDefinition } from '@italent/domain';
import { sql, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { installMissingSeeds } from '../../apps/api/src/seeds/index.js';
import { addMember, createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { cmd, seedTenantWithMember, tenantApi, type RequestOptions } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

export const OF_NOW = new Date('2026-10-17T01:00:00.000Z');

export interface OfferBody {
  readonly id: string;
  readonly status: string;
  readonly approvalStatus: string;
  readonly offerType: string | null;
  readonly revision: number;
  readonly [key: string]: unknown;
}

const rows = <T>(result: unknown) => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];

export async function offerWorld(db: Db, label: string, authorize?: Authorizer) {
  const member = await seedTenantWithMember(db, `of-${label}`);
  const as = { user: member.user.id, tenant: member.tenant.id };
  const seeder = tenantApi(db, { clock: () => OF_NOW });
  const api = authorize ? tenantApi(db, { clock: () => OF_NOW, authorize }) : seeder;
  await withTenant(db, member.tenant.id, (tx) =>
    installMissingSeeds(
      tx,
      { tenantId: member.tenant.id, actorUserId: null, now: OF_NOW, commandId: `of-seed-${randomUUID()}` },
      { modules: ['offer'] },
    ),
  );
  const created = async (path: string, body: unknown) => {
    const response = await seeder.request('POST', path, { ...as, ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string };
  };
  const department = await created('/api/tenant/org/organizations', {
    name: `录用部门${uniqueSuffix()}`,
    parents: { admin: { parentId: member.tenant.id } },
    establishedOn: '2026-01-01',
  });
  const employee = () =>
    created('/api/tenant/employment/employees', { name: '合成员工', code: `OF_${uniqueSuffix()}` });
  const manager = await employee();
  const hrbp = await employee();
  const [level] = rows<{ id: string }>(
    await withTenant(db, member.tenant.id, (tx) =>
      tx.execute(sql`INSERT INTO job_level_objects(tenant_id) VALUES (${member.tenant.id}) RETURNING id`),
    ),
  );
  const [company] = rows<{ id: string }>(
    await withTenant(db, member.tenant.id, (tx) =>
      tx.execute(sql`INSERT INTO contract_companies(tenant_id, code, name)
        VALUES (${member.tenant.id}, ${`C${uniqueSuffix()}`}, '合成法人') RETURNING id`),
    ),
  );
  const request = (method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, `/api/tenant/offers${path}`, { ...as, ...options });

  /** 社招必填 10 项（OF-R1）。 */
  const socialFields = () => ({
    channelName: '内推',
    name: '合成候选人',
    personalEmail: `of-${uniqueSuffix()}@example.com`,
    departmentId: department.id,
    plannedEntryDate: '2026-11-01',
    levelId: level!.id,
    directManagerId: manager.id,
    hrbpId: hrbp.id,
    costCenter: 'CC-001',
    contractCompanyId: company!.id,
  });
  const internFields = () => ({
    name: '合成实习生',
    personalEmail: `of-${uniqueSuffix()}@example.com`,
    departmentId: department.id,
    plannedEntryDate: '2026-11-01',
  });
  async function create(body: Record<string, unknown>): Promise<OfferBody> {
    const response = await request('POST', '', { ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as OfferBody;
  }
  const social = (extra: Record<string, unknown> = {}) => create({ entry: 'offer', ...socialFields(), ...extra });
  const intern = (extra: Record<string, unknown> = {}) => create({ entry: 'intern', ...internFields(), ...extra });
  async function get(id: string): Promise<OfferBody> {
    const response = await request('GET', `/${id}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as OfferBody;
  }
  /** 可信造数：直接改状态（已发、失效等 C2 / BE-14b 才有入口的状态）。 */
  const force = (id: string, column: string, value: string) =>
    withTenant(db, member.tenant.id, (tx) =>
      tx.execute(sql`UPDATE offers SET ${sql.identifier(column)} = ${value} WHERE id = ${id}`),
    );
  const invalidated = (id: string) =>
    withTenant(db, member.tenant.id, (tx) =>
      tx.execute(sql`UPDATE offers SET status = 'invalid', invalid_reason_code = 'candidate_gave_up',
        invalid_at = now() WHERE id = ${id}`),
    );
  /** 转移状态（BE-14a2）：默认走行主按钮入口，via='toolbar' 走顶部工具栏入口。 */
  const transfer = (
    offer: Pick<OfferBody, 'id' | 'revision'>,
    body: Record<string, unknown>,
    via: 'row' | 'toolbar' = 'row',
  ) =>
    request('POST', `/${offer.id}/${via === 'row' ? 'transfer' : 'toolbar-transfer'}`, {
      ifMatch: offer.revision,
      body,
    });
  async function moved(offer: Pick<OfferBody, 'id' | 'revision'>, body: Record<string, unknown>): Promise<OfferBody> {
    const response = await transfer(offer, body);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as OfferBody;
  }
  const invalidate = (offer: Pick<OfferBody, 'id' | 'revision'>, body: Record<string, unknown>) =>
    request('POST', `/${offer.id}/invalidate`, { ifMatch: offer.revision, body });
  async function list(query: string) {
    const response = await request('GET', `?${query}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as { total: number; items: OfferBody[] };
  }
  return {
    db,
    ...member,
    department,
    manager,
    hrbp,
    level: level!,
    company: company!,
    request,
    seeder,
    socialFields,
    internFields,
    create,
    social,
    intern,
    get,
    force,
    invalidated,
    transfer,
    moved,
    invalidate,
    list,
  };
}

export type OfferWorld = Awaited<ReturnType<typeof offerWorld>>;

export const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; details?: Record<string, unknown> } }).error;

/**
 * 第 2 轮（审查 P2-01 / P2-02）：真实权限授权器下的普通成员。Offer 对象有增删改，字段全可看，deniedEdit 里的字段不可编辑；
 * 职位对象可看；数据范围只有录用部门（部门 A）。另建部门 B 及其下的职位（范围外），供引用校验用例使用。
 */
export async function offerRealWorld(
  db: Db,
  label: string,
  deniedEdit: readonly string[] = [],
  deniedButtons: readonly string[] = [],
) {
  const w = await offerWorld(db, label);
  const api = tenantApi(db, { clock: () => OF_NOW, authorize: undefined });
  const adminRecord = await bootstrapTenantAdmin(db, { tenantId: w.tenant.id, userId: w.user.id }, cmd());
  const seed = {
    db,
    tenant: w.tenant,
    admin: w.user,
    adminRecord,
    api,
    asAdmin: { tenant: w.tenant.id, user: w.user.id },
  };
  const member = await addMember(seed, 'OfferHR');
  const profile = await createProfile(seed, `offer-${uniqueSuffix()}`);
  const permit = async (
    definition: ObjectDefinition,
    deniedEdit: readonly string[],
    deniedButtons: readonly string[] = [],
    ops: Partial<Record<'create' | 'update' | 'delete', boolean>> = {},
  ) => {
    const response = await setObjectPermission(
      seed,
      profile,
      {
        dataOperations: { create: true, update: true, delete: true, ...ops },
        fields: definition.fields.map((f) => ({
          fieldCode: f.code,
          view: true,
          edit: !f.system && !deniedEdit.includes(f.code),
        })),
        buttons: definition.buttons
          .filter((b) => !deniedButtons.includes(b.code))
          .map((b) => ({ buttonCode: b.code, level: b.level })),
      },
      definition.code,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  };
  await permit(MODULE_OBJECTS.offer, deniedEdit, deniedButtons);
  await permit(MODULE_OBJECTS.jobPosition, deniedEdit);
  await makeGrantable(seed, [profile.id]);
  expect((await grant(seed, member.id, profile.id)).status).toBe(201);
  const seeAllRevisions = new Map<string, number>();
  const scope = await api.request('PUT', `/api/tenant/permission/scopes/${member.id}/TenantBase`, {
    ...seed.asAdmin,
    ifMatch: 0,
    body: { kind: 'org_range', orgRanges: [{ orgId: w.department.id, includeDescendants: false }] },
  });
  expect(scope.status, await scope.clone().text()).toBe(200);
  const as = { user: w.user.id, tenant: w.tenant.id, ifMatch: 0 };
  const outside = await w.seeder.request('POST', '/api/tenant/org/organizations', {
    ...as,
    body: {
      name: `范围外部门${uniqueSuffix()}`,
      parents: { admin: { parentId: w.tenant.id } },
      establishedOn: '2026-01-01',
    },
  });
  expect(outside.status, await outside.clone().text()).toBe(201);
  const post = await w.seeder.request('POST', '/api/tenant/job/posts', {
    ...as,
    body: { name: '范围外职务', code: `POST-${uniqueSuffix()}`, startDate: '2026-01-01' },
  });
  expect(post.status, await post.clone().text()).toBe(201);
  const position = await w.seeder.request('POST', '/api/tenant/job/positions', {
    ...as,
    body: {
      name: '范围外职位',
      code: `POS-${uniqueSuffix()}`,
      orgId: ((await outside.json()) as { id: string }).id,
      postId: ((await post.json()) as { id: string }).id,
      startDate: '2026-01-01',
    },
  });
  expect(position.status, await position.clone().text()).toBe(201);
  /** 普通成员走真实授权器。 */
  const real = (method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, `/api/tenant/offers${path}`, { ...options, user: member.id, tenant: w.tenant.id });
  const count = async () =>
    rows<{ n: number }>(
      await withTenant(db, w.tenant.id, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM offers`)),
    )[0]!.n;
  /** 成功审计与成功台账（失败台账另表，不在此列）。 */
  const traces = async (commandId: string) =>
    rows<{ n: number }>(
      await withTenant(db, w.tenant.id, (tx) =>
        tx.execute(sql`SELECT ((SELECT count(*) FROM audit_events WHERE command_id = ${commandId})
          + (SELECT count(*) FROM command_ledger WHERE command_id = ${commandId}))::int AS n`),
      ),
    )[0]!.n;
  return {
    ...w,
    member,
    real,
    count,
    traces,
    /** 改身份上 Offer 字段的编辑权（撤权后同键重放用）。 */
    denyEdit: (fields: readonly string[]) => permit(MODULE_OBJECTS.offer, fields),
    /** 改身份上 Offer 的按钮权限（BE-14a2：转移状态两项按钮各自独立）。 */
    denyButtons: (buttons: readonly string[]) => permit(MODULE_OBJECTS.offer, deniedEdit, buttons),
    /** 去掉 Offer 对象的编辑开关（按钮依赖编辑开关，一并失效）。 */
    dropUpdate: () => permit(MODULE_OBJECTS.offer, deniedEdit, deniedButtons, { update: false }),
    /** 改 Offer 对象的数据操作开关（第 2 轮：行操作按真实授权器裁剪的正反例）。 */
    setOps: (ops: Partial<Record<'create' | 'update' | 'delete', boolean>>) =>
      permit(MODULE_OBJECTS.offer, deniedEdit, deniedButtons, ops),
    /** 租户管理员（system_admin）走真实授权器：不越过业务对象权限（DEC-503）。 */
    adminRequest: (method: string, path: string, options: RequestOptions = {}) =>
      api.request(method, `/api/tenant/offers${path}`, { ...options, ...seed.asAdmin }),
    /**
     * 身份上给某对象单独授“看全部”（第 3 轮：Offer 看全部而 Employee 只有部门 A，人员引用须按 Employee 自己的范围）。
     */
    seeAll: async (objectCode: string) => {
      const response = await api.request(
        'PUT',
        `/api/tenant/permission/profiles/${profile.id}/data-scopes/TenantBase`,
        {
          ...seed.asAdmin,
          ifMatch: seeAllRevisions.get(objectCode) ?? 0,
          body: { targetKind: 'entity', targetCode: objectCode, seeAll: true },
        },
      );
      expect(response.status, await response.clone().text()).toBe(200);
      seeAllRevisions.set(objectCode, ((await response.json()) as { revision: number }).revision);
    },
    outsidePosition: ((await position.json()) as { id: string }).id,
  };
}
