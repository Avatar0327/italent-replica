/**
 * 社保读取路由（F-474-8c-2b；设计 F-474-8b §4.1，AC-INS-02/03/04/09/10 读侧）：全部只读，没有写路由、没有维护页面。
 * - GET /api/tenant/transfer/insurance-origin：调动表单“原值”= 业务位置之前的档案折叠（archive-fold.ts）；
 *   准入 = 社保档案对象查看权 + 三个字段全部可见（不给半截原值）+ 员工在任职数据范围内（范围外与不存在同一个 404）；
 * - GET /api/tenant/insurance/regions：缴交地逐级下钻，全局公开字典，登录即可；
 * - GET /api/tenant/insurance/plans：缴交方案候选，社保方案对象查看权（planId 随 id 字段查看权）；只出当月有效且启用、缴交地 = 所选地区或其上级的版本；
 * - GET /api/tenant/insurance/companies：合同公司主数据，沿用合同公司对象的可见性（DEC-121：只认看全部，无归属对象）。
 * 方案与档案表对运行时角色只读（迁移 0218），写入只经 scripts/seed-insurance-plans.mjs（U4-A）。
 */
import { contractCompanies, sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS, tenantLocalDate } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { requirePermission } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { readPageContext } from '../employment/context.js';
import { rowsOf } from '../employment/record-store.js';
import { businessDate } from '../job/fields.js';
import { getModuleViewableFields, resolveModuleScope } from '../permission/module-access.js';
import { foldInsuranceOrigin, insurancePosition, NOT_FOUND_MESSAGE } from './archive-fold.js';
import { insuranceReferenceNames } from './reference-names.js';

export const INSURANCE_ORIGIN_PATH = '/api/tenant/transfer/insurance-origin';
export const INSURANCE_BASE = '/api/tenant/insurance';
const PROFILE = MODULE_OBJECTS.socialSecurityProfile.code;
const PLAN = MODULE_OBJECTS.socialInsurancePlan.code;
const COMPANY = MODULE_OBJECTS.contractCompany.code;
/** 原值三个字段：缺任何一个的查看权都整体拒绝，避免调动表单拿到半截原值（AC-INS-09）。 */
const ORIGIN_FIELDS = ['insuranceRegionCode', 'insurancePlanId', 'insuranceCompanyId'] as const;
/** 候选列表的条数上限（AGENTS §10 有界）：区县数 / 方案数 / 合同公司数都远小于它。 */
const LIST_LIMIT = 500;

const regionCode = z.string().regex(/^\d{6}$/, '缴交地编码必须是 6 位数字');
const originQuery = z.strictObject({
  employeeId: z.uuid(),
  effectiveDate: businessDate,
  businessId: z.uuid().optional(),
});
const regionQuery = z.strictObject({
  parent: regionCode.optional(),
  limit: z.coerce.number().int().min(1).max(LIST_LIMIT).default(LIST_LIMIT),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const planQuery = z.strictObject({ regionCode, asOf: businessDate.optional() });

function query<T>(c: Context<TenantEnv>, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '查询参数不合法', parsed.error.issues);
  return parsed.data;
}

/** 对象查看权（不带字段）：没有该对象的功能权直接 403。 */
const requireView = (deps: TenantRouteDeps, tenant: ReturnType<typeof tenantOf>, resource: string) =>
  requirePermission(deps.authorize, { ...tenant, action: 'object.view', resource, fields: [] });

function registerOrigin(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(INSURANCE_ORIGIN_PATH, async (c) => {
    const tenant = tenantOf(c);
    await requireView(deps, tenant, PROFILE);
    const input = query(c, originQuery);
    const visible = await getModuleViewableFields(deps, tenant, PROFILE);
    if (visible && !ORIGIN_FIELDS.every((field) => visible.has(field)))
      throw new AppError('FORBIDDEN', '没有社保档案字段的查看权限');
    // 员工须在任职数据范围内；范围外与不存在同一个 404（readPageContext 绑定员工后判定）
    const ctx = await readPageContext(c, deps, 'detail', input.employeeId);
    const origin = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      // 数据范围是“看全部”时 readPageContext 不查员工是否存在；不存在的员工与范围外同样 404
      const [employee] = rowsOf(
        await tx.execute(sql`SELECT 1 FROM employment_employees
          WHERE tenant_id = ${ctx.tenantId} AND id = ${input.employeeId}::uuid`),
      );
      if (!employee) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
      const position = await insurancePosition(
        tx,
        ctx.tenantId,
        input.employeeId,
        input.effectiveDate,
        input.businessId,
      );
      const values = await foldInsuranceOrigin(tx, ctx.tenantId, input.employeeId, position);
      const names = await insuranceReferenceNames(
        tx,
        ctx.tenantId,
        input.effectiveDate,
        new Set(values.planId ? [values.planId] : []),
        new Set(values.companyId ? [values.companyId] : []),
      );
      return {
        ...values,
        planName: values.planId ? (names.plans.get(values.planId) ?? null) : null,
        companyName: values.companyId ? (names.companies.get(values.companyId) ?? null) : null,
      };
    });
    return c.json(origin);
  });
}

function registerRegions(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(`${INSURANCE_BASE}/regions`, async (c) => {
    const tenant = tenantOf(c);
    const input = query(c, regionQuery);
    // 直辖市与省直管县的区县直接挂在省级编码下，所以“下一级”只按 parent_code 取，不假设层级逐级递增
    const parent = input.parent ? sql`parent_code = ${input.parent}` : sql`parent_code IS NULL`;
    const items = await withTenant(deps.db, tenant.tenantId, async (tx) =>
      rowsOf(
        await tx.execute(sql`SELECT code, parent_code AS "parentCode", level::int AS level, name
          FROM admin_regions WHERE ${parent} ORDER BY code LIMIT ${input.limit} OFFSET ${input.offset}`),
      ),
    );
    return c.json({ items });
  });
}

function registerPlans(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(`${INSURANCE_BASE}/plans`, async (c) => {
    const tenant = tenantOf(c);
    await requireView(deps, tenant, PLAN);
    const input = query(c, planQuery);
    const month = `${(input.asOf ?? tenantLocalDate(deps.clock(), tenant.timezone)).slice(0, 7)}-01`;
    const visible = await getModuleViewableFields(deps, tenant, PLAN);
    const rows = await withTenant(deps.db, tenant.tenantId, async (tx) => {
      const [known] = rowsOf(await tx.execute(sql`SELECT 1 FROM admin_regions WHERE code = ${input.regionCode}`));
      if (!known) throw new AppError('VALIDATION_FAILED', '缴交地不存在');
      // 方案缴交地 = 所选地区或它的任一上级（省 / 市级方案适用于其下区县；直辖市区县的上级直接是省级）
      return rowsOf<Record<string, unknown>>(
        await tx.execute(sql`
          WITH RECURSIVE chain(code, parent_code) AS (
            SELECT code, parent_code FROM admin_regions WHERE code = ${input.regionCode}
            UNION ALL
            SELECT r.code, r.parent_code FROM admin_regions r JOIN chain ON r.code = chain.parent_code)
          SELECT p.id AS "planId", p.code, v.name, v.region_code AS "regionCode",
            v.effective_month::text AS "effectiveMonth", v.stop_month::text AS "stopMonth", v.enabled
          FROM social_insurance_plan_versions v
          JOIN social_insurance_plans p ON p.tenant_id = v.tenant_id AND p.id = v.plan_id
          WHERE v.tenant_id = ${tenant.tenantId} AND v.enabled
            AND v.effective_month <= ${month}::date AND (v.stop_month IS NULL OR v.stop_month > ${month}::date)
            AND v.region_code IN (SELECT code FROM chain)
          ORDER BY p.code, v.effective_month LIMIT ${LIST_LIMIT}`),
      );
    });
    // 字段级可见：不可见的字段整列去掉；planId 对应对象目录的系统字段 id，同样受 id 查看权约束（不豁免标识）
    const catalogField = (key: string) => (key === 'planId' ? 'id' : key);
    const items = rows.map((row) =>
      Object.fromEntries(Object.entries(row).filter(([key]) => !visible || visible.has(catalogField(key)))),
    );
    return c.json({ items });
  });
}

function registerCompanies(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(`${INSURANCE_BASE}/companies`, async (c) => {
    const tenant = tenantOf(c);
    await requireView(deps, tenant, COMPANY);
    const scope = await resolveModuleScope(deps, tenant, undefined, COMPANY, `${COMPANY}.list`);
    const visible = await getModuleViewableFields(deps, tenant, COMPANY);
    // 与合同公司主数据同一规则：只认看全部，没有则空列表（200）；只给启用的公司作候选
    const rows = await withTenant(deps.db, tenant.tenantId, async (tx) =>
      rowsOf<{ id: string; code: string; name: string }>(
        await tx.execute(sql`SELECT id, code, name FROM ${contractCompanies}
          WHERE tenant_id = ${tenant.tenantId} AND enabled AND ${scope.all} ORDER BY code, id LIMIT ${LIST_LIMIT}`),
      ),
    );
    const items = rows.map((row) =>
      Object.fromEntries(Object.entries(row).filter(([key]) => !visible || visible.has(key))),
    );
    return c.json({ items });
  });
}

export function registerInsuranceRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  registerOrigin(router, deps);
  registerRegions(router, deps);
  registerPlans(router, deps);
  registerCompanies(router, deps);
}
