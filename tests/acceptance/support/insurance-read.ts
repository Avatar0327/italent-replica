/**
 * F-474-8c-2b：社保读接口的真实授权夹具（AC-INS-02/03/04/09/10）。业务单（调动申请）由真实的提交流程产生，
 * 操作先后（event_seq）因此是真实的；档案版本由夹具直接写（本任务不写档案事件），其余走真实授权器 + 真实 HTTP。
 */
import { randomUUID } from 'node:crypto';
import { bootstrapTenantAdmin } from '@italent/api';
import { sql, withTenant, type Db } from '@italent/db';
import { MODULE_OBJECTS, type ObjectDefinition } from '@italent/domain';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  setObjectPermission,
  type PermissionWorld,
} from '../AC-PRM-support.js';
import { activationWorld } from '../AC-TRF-activation-support.js';
import { asOwner, rowsOf } from './insurance-tables.js';
import { cmd, tenantApi } from './tenant-api.js';
import { uniqueSuffix } from './unique.js';

export const DAY = '2026-10-05';
const PROFILE = MODULE_OBJECTS.socialSecurityProfile;
const PLAN = MODULE_OBJECTS.socialInsurancePlan;
const NOW = new Date('2026-10-01T01:00:00.000Z');

export interface CallerSpec {
  /** 社保档案对象的字段可见集合：缺省全部；false = 不授该对象；数组 = 只可见这些字段。 */
  profile?: false | readonly string[];
  /** 缴交方案对象的字段可见集合：缺省全部；false = 不授该对象。 */
  plan?: false | readonly string[];
  company?: false;
  employment?: false;
  seeAll?: boolean;
}

export async function insuranceReadWorld(db: Db, label: string) {
  const w = await activationWorld(db, label);
  const tenantId = w.session.tenant.id;
  const adminRecord = await bootstrapTenantAdmin(db, { tenantId, userId: w.session.user.id }, cmd());
  const api = tenantApi(db, { authorize: undefined, clock: () => NOW });
  const world: PermissionWorld = {
    db,
    tenant: w.session.tenant,
    admin: w.session.user,
    adminRecord,
    api,
    asAdmin: { user: w.session.user.id, tenant: tenantId },
  };

  async function define(
    profile: Awaited<ReturnType<typeof createProfile>>,
    def: ObjectDefinition,
    view: readonly string[],
  ) {
    const fields = def.fields.map((f) => ({ fieldCode: f.code, view: view.includes(f.code), edit: false }));
    const res = await setObjectPermission(
      world,
      profile,
      { dataOperations: { create: false, update: false, delete: false }, fields, buttons: [] },
      def.code,
    );
    if (res.status !== 200) throw new Error(`授权失败 ${def.code}：${await res.text()}`);
  }

  /** 新建一个只带 spec 里那些权限的成员；返回请求入口（每次请求都经真实授权器）。 */
  async function caller(spec: CallerSpec = {}) {
    const profile = await createProfile(world, `ins-${uniqueSuffix()}`);
    const all = (def: ObjectDefinition) => def.fields.map((f) => f.code);
    if (spec.profile !== false) await define(profile, PROFILE, spec.profile ?? all(PROFILE));
    if (spec.plan !== false) await define(profile, PLAN, spec.plan ?? all(PLAN));
    if (spec.company !== false)
      await define(profile, MODULE_OBJECTS.contractCompany, all(MODULE_OBJECTS.contractCompany));
    if (spec.employment !== false)
      await define(profile, MODULE_OBJECTS.employmentRecord, all(MODULE_OBJECTS.employmentRecord));
    if (spec.seeAll !== false) {
      const scope = await api.request('PUT', `/api/tenant/permission/profiles/${profile.id}/data-scopes/TenantBase`, {
        ...world.asAdmin,
        ifMatch: 0,
        body: { targetKind: 'app', targetCode: '', seeAll: true },
      });
      if (scope.status !== 200) throw new Error(`数据范围失败：${await scope.text()}`);
    }
    await makeGrantable(world, [profile.id]);
    const user = await addMember(world, '社保读取者');
    if ((await grant(world, user.id, profile.id)).status !== 201) throw new Error('授予身份失败');
    const as = { user: user.id, tenant: tenantId };
    return { as, get: (path: string) => api.request('GET', path, as) };
  }

  /** 同一员工名下再登记一个业务对象（只作为档案版本的来源，不走提交流程；FK 要求它存在）。 */
  const extraBusiness = async (employeeId: string): Promise<string> => {
    const id = randomUUID();
    await asOwner(db, tenantId, (tx) =>
      tx.execute(sql`INSERT INTO employment_business_objects (id, tenant_id, employee_id)
        VALUES (${id}, ${tenantId}, ${employeeId})`),
    );
    return id;
  };

  /** 业务的操作先后：与产品读路径同一口径（最近一次提交的状态事件序号）。 */
  const seqOf = (businessId: string): Promise<number> =>
    withTenant(db, tenantId, async (tx) => {
      const [row] = rowsOf<{ s: string }>(
        await tx.execute(sql`SELECT max(event_seq) FILTER (WHERE state = 'in_review')::text AS s
          FROM employment_state_events WHERE tenant_id = ${tenantId} AND business_id = ${businessId}::uuid`),
      );
      return Number(row!.s);
    });

  interface Version {
    employeeId: string;
    versionNo: number;
    businessId: string;
    effectiveDate: string;
    plannedDate?: string;
    seq: number;
    regionCode?: string | null;
    planId?: string | null;
    companyId?: string | null;
  }
  /** 档案版本一行：生效日、计划日、操作先后都显式给，version_no 由用例按“追加顺序”给。 */
  const archive = (row: Version) =>
    asOwner(db, tenantId, (tx) =>
      tx.execute(sql`INSERT INTO social_insurance_archive_versions
        (tenant_id, employee_id, version_no, effective_date, planned_effective_date, operation_seq,
         region_code, plan_id, company_id, source, source_business_id, command_id)
        VALUES (${tenantId}, ${row.employeeId}, ${row.versionNo}, ${row.effectiveDate},
          ${row.plannedDate ?? row.effectiveDate}, ${row.seq}, ${row.regionCode ?? null}, ${row.planId ?? null},
          ${row.companyId ?? null}, 'transfer', ${row.businessId}, ${`cmd-${uniqueSuffix()}`})`),
    );

  const company = async (code: string, enabled = true): Promise<string> => {
    const id = randomUUID();
    await asOwner(db, tenantId, (tx) =>
      tx.execute(sql`INSERT INTO contract_companies (id, tenant_id, code, name, enabled)
        VALUES (${id}, ${tenantId}, ${`${code}-${uniqueSuffix()}`}, ${`公司${code}`}, ${enabled})`),
    );
    return id;
  };

  /** 方案头 + 一条版本；month 为生效月（1 号），stop 为停用月。 */
  const plan = async (
    code: string,
    region: string,
    month: string,
    options: { stop?: string; enabled?: boolean } = {},
  ): Promise<string> => {
    const id = randomUUID();
    await asOwner(db, tenantId, async (tx) => {
      await tx.execute(sql`INSERT INTO social_insurance_plans (tenant_id, id, code)
        VALUES (${tenantId}, ${id}, ${`${code}-${uniqueSuffix()}`})`);
      await tx.execute(sql`INSERT INTO social_insurance_plan_versions
        (tenant_id, plan_id, name, region_code, effective_month, stop_month, enabled)
        VALUES (${tenantId}, ${id}, ${`方案${code}`}, ${region}, ${month}, ${options.stop ?? null},
          ${options.enabled ?? true})`);
    });
    return id;
  };

  return { w, world, tenantId, caller, extraBusiness, seqOf, archive, company, plan };
}

export type InsuranceReadWorld = Awaited<ReturnType<typeof insuranceReadWorld>>;

export const originUrl = (employeeId: string, effectiveDate: string, businessId?: string) =>
  `/api/tenant/transfer/insurance-origin?employeeId=${employeeId}&effectiveDate=${effectiveDate}` +
  (businessId ? `&businessId=${businessId}` : '');
