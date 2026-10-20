/**
 * 必需项表：人事分析（modules/hr-analysis，BE-12a 时点员工花名册）。
 * 列表与导出共用 roster-access.ts#rosterAccess：员工档案对象查看权 + 页面 list 范围（access → 数据范围先于分页，
 * personScope 进 roster-query.ts#population）与人事分析对象查看权两个准入节点；导出另须列表级“导出”按钮。
 * 任职记录 / 合同对象的查看权不拒绝请求，只让对应的列整类缺席（披露分支 recordColumns / contractColumns，
 * 行范围同为员工档案的 personScope）；筛选字段无查看权 403、逐列字段权由 getModuleViewableFields 的可见字段集合承担。
 */
import { bound, list, NONE, withNeeds } from './scopes.js';
import type { Evidence, Obligation, RequiredTable } from './types.js';

const M = 'apps/api/src/modules';
const ACCESS = `${M}/hr-analysis/roster-access.ts`;
const PERSONNEL_ACCESS = `${M}/personnel/access.ts`;
const PERSON = 'TenantBase.EmployeeInformation';
const ROSTER = 'TenantBase.HrRoster';
const RECORD = 'TenantBase.EmploymentRecord';
const CONTRACT = 'TenantBase.EmploymentContract';

const impl = (anchor: string): Evidence => ({ role: 'impl', unit: `${ACCESS}#rosterAccess`, anchor });
const call = (route: string, anchor: string): Evidence => ({
  role: 'call',
  unit: `${M}/hr-analysis/roster-routes.ts#route:${route}`,
  anchor,
});
const ROSTER_CONST: Evidence = {
  role: 'const',
  unit: `${ACCESS}#ROSTER_OBJECT`,
  anchor: 'MODULE_OBJECTS.hrRoster.code',
};
const SCOPE: Evidence = {
  role: 'scope',
  unit: `${M}/hr-analysis/roster-query.ts#population`,
  anchor: 'personScope(ctx),',
};
const ACCESS_IMPL: Evidence = {
  role: 'impl',
  unit: `${PERSONNEL_ACCESS}#access`,
  anchor: 'await authorize(deps.authorize, ctx, operation, payload, button)',
};

const GET = 'GET /api/tenant/hr-analysis/roster';
const EXPORT = 'GET /api/tenant/hr-analysis/roster/export';

/** 与 personnel.ts 的 op() 同一证据形状：入口调用 rosterAccess → access → authorize。 */
const person = (route: string, exporting: boolean): Obligation => ({
  perm: `obj:${PERSON}:view`,
  facts: ['object:personnel access', `objectOp:${PERSON}:view`],
  at: [
    call(route, `const rights = await rosterAccess(c, deps, ${exporting})`),
    impl("const ctx = await access(c, deps, PERSONNEL_OBJECT, 'view', {}, undefined, 0, 'list')"),
    ACCESS_IMPL,
    {
      role: 'impl',
      unit: `${PERSONNEL_ACCESS}#authorize`,
      anchor:
        'else await requirePermission(authorizer, { ...ctx, action: `object.${operation}`, resource: ctx.objectCode })',
    },
    {
      role: 'const',
      unit: 'packages/domain/src/personnel/catalog.ts#PERSONNEL_OBJECT',
      anchor: "'TenantBase.EmployeeInformation'",
    },
  ],
});
const rosterView = (route: string, exporting: boolean): Obligation => ({
  perm: `obj:${ROSTER}:view`,
  facts: [`objectOp:${ROSTER}:view`],
  at: [
    call(route, `const rights = await rosterAccess(c, deps, ${exporting})`),
    impl("await requirePermission(deps.authorize, { ...ctx, action: 'object.view', resource: ROSTER_OBJECT })"),
    ROSTER_CONST,
  ],
});
const exportButton = (route: string): Obligation => ({
  perm: `btn:${ROSTER}#export@list`,
  facts: ['button:buttonResource'],
  at: [
    call(route, 'const rights = await rosterAccess(c, deps, true)'),
    impl(
      "await requirePermission(deps.authorize, { ...ctx, action: 'object.button', " +
        "resource: buttonResource(ROSTER_OBJECT, 'export', 'list') })",
    ),
    ROSTER_CONST,
  ],
});
const columns = (route: string, exporting: boolean, object: string, constant: string, purpose: string): Obligation => ({
  perm: `obj:${object}:view`,
  purpose: `disclosure:${purpose}`,
  facts: [`objectOp:${object}:view`],
  at: [
    call(route, `const rights = await rosterAccess(c, deps, ${exporting})`),
    impl(
      `${purpose === 'recordColumns' ? 'record' : 'contract'}: await deps.authorize({ ...ctx, action: 'object.view', resource: ${constant} })`,
    ),
    {
      role: 'const',
      unit: `${ACCESS}#${constant}`,
      anchor: `MODULE_OBJECTS.${purpose === 'recordColumns' ? 'employmentRecord' : 'contract'}.code`,
    },
    SCOPE,
  ],
});

function entry(route: string, exporting: boolean): Obligation[] {
  return withNeeds(
    [
      person(route, exporting),
      rosterView(route, exporting),
      ...(exporting ? [exportButton(route)] : []),
      columns(route, exporting, RECORD, 'RECORD_OBJECT', 'recordColumns'),
      columns(route, exporting, CONTRACT, 'CONTRACT_OBJECT', 'contractColumns'),
    ],
    {
      [`obj:${PERSON}:view`]: bound(list('personnel.personScope'), [SCOPE]),
      [`obj:${ROSTER}:view`]: bound(NONE),
      [`obj:${RECORD}:view|disclosure:recordColumns`]: bound(list('personnel.personScope')),
      [`obj:${CONTRACT}:view|disclosure:contractColumns`]: bound(list('personnel.personScope')),
    },
  );
}

export const HR_ANALYSIS: RequiredTable = {
  'GET /api/tenant/hr-analysis/roster': entry(GET, false),
  'GET /api/tenant/hr-analysis/roster/export': entry(EXPORT, true),
};
