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
/** F-465a 报表路由（report-routes.ts）与花名册路由同形：入口直接调 rosterAccess，导出另调 requireExportButton。 */
const REPORTS = `${M}/hr-analysis/report-routes.ts`;
const call = (route: string, anchor: string): Evidence => ({
  role: 'call',
  unit: `${route.startsWith(REPORT_CATALOG) ? REPORTS : `${M}/hr-analysis/roster-routes.ts`}#route:${route}`,
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

const REPORT_CATALOG = 'GET /api/tenant/hr-analysis/reports';
const REPORT_PREFIX = `${REPORT_CATALOG}/`;
const GET = 'GET /api/tenant/hr-analysis/roster';
const EXPORT = 'GET /api/tenant/hr-analysis/roster/export';
const REPORT = `${REPORT_PREFIX}:code`;
const REPORT_EXPORT = `${REPORT_PREFIX}:code/export`;

const rosterCall = (route: string) =>
  route.startsWith(REPORT_PREFIX)
    ? 'const rights = await rosterAccess(c, deps, DEDICATED_COLUMNS[report.code])'
    : 'const rights = await rosterAccess(c, deps)';

/** 与 personnel.ts 的 op() 同一证据形状：入口调用 rosterAccess → access → authorize。 */
const person = (route: string): Obligation => ({
  perm: `obj:${PERSON}:view`,
  facts: [`objectOp:${PERSON}:view`],
  at: [
    call(route, rosterCall(route)),
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
const rosterView = (route: string): Obligation => ({
  perm: `obj:${ROSTER}:view`,
  facts: ['object:object.* 动作', `objectOp:${ROSTER}:view`],
  at: [
    call(route, rosterCall(route)),
    impl("await requirePermission(deps.authorize, { ...ctx, action: 'object.view', resource: ROSTER_OBJECT })"),
    ROSTER_CONST,
  ],
});
const exportButton = (route: string): Obligation => ({
  perm: `btn:${ROSTER}#export@list`,
  facts: ['button:buttonResource', 'button:object.button'],
  at: [
    call(route, 'await requireExportButton(deps, rights.ctx)'),
    {
      role: 'impl',
      unit: `${ACCESS}#requireExportButton`,
      anchor:
        "await requirePermission(deps.authorize, { ...ctx, action: 'object.button', " +
        "resource: buttonResource(ROSTER_OBJECT, 'export', 'list'), })",
    },
    ROSTER_CONST,
  ],
});
/** 披露分支：任职记录 / 合同对象的查看权（key = rosterAccess 里 viewable 的键）。 */
const BRANCHES = {
  recordColumns: { object: RECORD, key: 'record', constant: 'RECORD_OBJECT', domain: 'employmentRecord' },
  contractColumns: { object: CONTRACT, key: 'contract', constant: 'CONTRACT_OBJECT', domain: 'contract' },
} as const;
const columns = (route: string, branch: keyof typeof BRANCHES): Obligation => {
  const { object, key, constant, domain } = BRANCHES[branch];
  return {
    perm: `obj:${object}:view`,
    purpose: `disclosure:${branch}`,
    at: [
      call(route, rosterCall(route)),
      impl(`${key}: await deps.authorize({ ...ctx, action: 'object.view', resource: ${constant} })`),
      { role: 'const', unit: `${ACCESS}#${constant}`, anchor: `MODULE_OBJECTS.${domain}.code` },
      SCOPE,
    ],
  };
};

/**
 * 具名守卫 hrAnalysis.reportObjects（F-465a 第 2 轮 P2-2）：1.06 须合同对象、1.07 / 1.1.01 / 1.1.02 须任职记录对象的查看权，
 * 缺失 403。按路径参数 :code 取值，表结构表达不了“某些值才要”，故登记为：守卫调用点 + 拒绝实现（throw FORBIDDEN）
 * + 两个 when 条件准入对象；与披露分支（只裁列）分属不同用途，删守卫或把拒绝改成只裁列都会让证据 / 比对失败。
 */
const GUARD = 'hrAnalysis.reportObjects';
const objectGuard = (route: string): Obligation => ({
  perm: `guard:${GUARD}`,
  facts: [`guard:${GUARD}`],
  note: '条件守卫：按报表编码核对合同 / 任职记录对象查看权，缺失 403（不是裁列）',
  at: [
    call(route, 'requireReportObjects(rights, report);'),
    {
      role: 'impl',
      unit: `${REPORTS}#requireReportObjects`,
      anchor: "if (!rights.viewable[source]) throw new AppError('FORBIDDEN',",
    },
  ],
});
const required = (route: string, object: string, key: 'record' | 'contract', constant: string): Obligation => ({
  perm: `obj:${object}:view`,
  purpose: `when:${GUARD}`,
  facts: ['object:object.* 动作'],
  at: [
    call(route, 'requireReportObjects(rights, report);'),
    {
      role: 'impl',
      unit: `${ACCESS}#rosterAccess`,
      anchor: `${key}: await deps.authorize({ ...ctx, action: 'object.view', resource: ${constant} })`,
    },
    {
      role: 'const',
      unit: `${ACCESS}#${constant}`,
      anchor: `MODULE_OBJECTS.${key === 'record' ? 'employmentRecord' : 'contract'}.code`,
    },
  ],
});

function entry(route: string, exporting: boolean): Obligation[] {
  const reports = route.startsWith(REPORT_PREFIX);
  return withNeeds(
    [
      person(route),
      rosterView(route),
      ...(exporting ? [exportButton(route)] : []),
      columns(route, 'recordColumns'),
      columns(route, 'contractColumns'),
      ...(reports
        ? [
            objectGuard(route),
            required(route, RECORD, 'record', 'RECORD_OBJECT'),
            required(route, CONTRACT, 'contract', 'CONTRACT_OBJECT'),
          ]
        : []),
    ],
    {
      [`obj:${PERSON}:view`]: bound(list('personnel.personScope'), [SCOPE]),
      [`obj:${ROSTER}:view`]: bound(NONE),
      [`obj:${RECORD}:view|disclosure:recordColumns`]: bound(list('personnel.personScope')),
      [`obj:${CONTRACT}:view|disclosure:contractColumns`]: bound(list('personnel.personScope')),
    },
  );
}

/**
 * 目录可用性：availability() 逐对象问查看权并标注，不拒绝请求（披露，不是准入）；每个对象一个同名 optional 分支。
 * 与各入口共用 domain 的 requires 元数据，对象集合变化时探测器的轨迹与此表一并失败。
 */
const CATALOG = 'GET /api/tenant/hr-analysis/reports';
const AVAILABILITY: readonly (readonly [string, string])[] = [
  ['availPerson', PERSON],
  ['availRoster', ROSTER],
  ['availRecord', RECORD],
  ['availContract', CONTRACT],
  ['availMovement', 'TenantBase.HrMovementReport'],
  ['availStructure', 'TenantBase.HrStructureReport'],
];
const availability = ([branch, object]: readonly [string, string]): Obligation => ({
  perm: `obj:${object}:view`,
  purpose: `disclosure:${branch}`,
  need: NONE,
  facts: ['object:object.* 动作'],
  note: '目录只把该对象的查看权结果标进可用性，不拒绝请求、不含业务数据',
  at: [
    call(CATALOG, 'items.push({ code, name, group, endpoint, ...(await availability(c, deps, report)) });'),
    {
      role: 'impl',
      unit: `${REPORTS}#availability`,
      anchor: "if (!(await deps.authorize({ ...tenant, action: 'object.view', resource: need.resource })))",
    },
  ],
});

export const HR_ANALYSIS: RequiredTable = {
  'GET /api/tenant/hr-analysis/roster': entry(GET, false),
  'GET /api/tenant/hr-analysis/roster/export': entry(EXPORT, true),
  // F-465a：目录只返回元数据与按各对象查看权算出的可用性（披露，非准入）
  [CATALOG]: AVAILABILITY.map(availability),
  [REPORT]: entry(REPORT, false),
  [REPORT_EXPORT]: entry(REPORT_EXPORT, true),
};
