/**
 * 必需项表：社保读取（modules/insurance/routes.ts，F-474-8c-2b；DEC-896④，设计 F-474-8b §4.1）。全部只读：
 * - 原值读取：社保档案对象查看权（requireView）+ 任职记录查看权与员工范围（readPageContext，范围外与不存在同为 404，
 *   守卫 insurance.employeeScope）；三个原值字段缺一不可见则整体 403 在处理函数内（ORIGIN_FIELDS），不是准入义务；
 * - 缴交地：全局公开字典，登录成员即可，无权限义务；
 * - 方案候选 / 公司候选：对象查看权（requireView）；公司候选再按看全部过滤（scope.all，无看全部 → 200 空列表）。
 */
import type { Evidence, Obligation, RequiredTable } from './types.js';

const ROUTES = 'apps/api/src/modules/insurance/routes.ts';
const CTX = 'apps/api/src/modules/employment/context.ts';
const DOMAIN = 'packages/domain/src/permission/module-actions.ts';
const ORIGIN = '/api/tenant/transfer/insurance-origin';
const BASE = '/api/tenant/insurance';
const PROFILE = 'TenantBase.SocialSecurityProfile';
const PLAN = 'TenantBase.SocialInsurancePlan';
const COMPANY = 'TenantBase.ContractCompany';

const call = (path: string, anchor: string): Evidence => ({
  role: 'call',
  unit: `${ROUTES}#route:GET ${path}`,
  anchor,
});
const REQUIRE_VIEW: Evidence = {
  role: 'impl',
  unit: `${ROUTES}#requireView`,
  anchor: "requirePermission(deps.authorize, { ...tenant, action: 'object.view', resource, fields: [] })",
};
const objectConst = (name: string, key: string, code: string): Evidence[] => [
  { role: 'const', unit: `${ROUTES}#${name}`, anchor: `MODULE_OBJECTS.${key}.code` },
  { role: 'const', unit: `${DOMAIN}#MODULE_OBJECTS>${key}`, anchor: `object( '${code}'` },
];
const objectView = (path: string, object: string, name: string, key: string, code: string): Obligation => ({
  perm: `obj:${object}:view`,
  facts: ['object:object.* 动作'],
  at: [call(path, `await requireView(deps, tenant, ${name})`), REQUIRE_VIEW, ...objectConst(name, key, code)],
});

// 员工范围与任职记录查看权在 readPageContext → contextOf（与任职详情同一判定）
const PAGE: Evidence = {
  role: 'impl',
  unit: `${CTX}#readPageContext`,
  anchor: "return readContext(c, deps, 'tenant.employment.read', 0, resource, objectCode, `${objectCode}.${page}`)",
};
const READ: Evidence = {
  role: 'impl',
  unit: `${CTX}#contextOf`,
  anchor: 'await requirePermission(deps.authorize, { ...tenant, action: operation, resource: objectCode,',
};
const RECORD_CONST: Evidence = {
  role: 'const',
  unit: `${CTX}#EMPLOYMENT_OBJECT`,
  anchor: "'TenantBase.EmploymentRecord'",
};
const PAGE_CALL = call(ORIGIN, "const ctx = await readPageContext(c, deps, 'detail', input.employeeId)");

export const INSURANCE: RequiredTable = {
  [`GET ${ORIGIN}`]: [
    objectView(ORIGIN, PROFILE, 'PROFILE', 'socialSecurityProfile', 'SocialSecurityProfile'),
    {
      perm: 'guard:insurance.employeeScope',
      facts: ['guard:insurance.employeeScope', 'object:readPageContext'],
      note: '员工须在任职数据范围内；范围外与不存在同一个 404（readPageContext 绑定员工后判定）',
      at: [PAGE_CALL, PAGE, READ, RECORD_CONST],
    },
  ],
  [`GET ${BASE}/regions`]: [],
  [`GET ${BASE}/plans`]: [objectView(`${BASE}/plans`, PLAN, 'PLAN', 'socialInsurancePlan', 'SocialInsurancePlan')],
  [`GET ${BASE}/companies`]: [
    objectView(`${BASE}/companies`, COMPANY, 'COMPANY', 'contractCompany', 'ContractCompany'),
  ],
};
