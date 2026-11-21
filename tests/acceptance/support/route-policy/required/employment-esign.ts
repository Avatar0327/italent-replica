/** F-505 S5：入职来源授权、签署记录双范围及写命令复核。 */
import { guardScope, list, point } from './scopes.js';
import type { Evidence, Obligation, RequiredTable } from './types.js';

const EMP = 'apps/api/src/modules/employment';
const ESIGN = 'apps/api/src/modules/esign';
const ENTRY = '/pending-entries/:id/esign-';
const ENDPOINT = '/api/tenant/employment' + ENTRY;
const RECORD = 'TenantBase.EmploymentRecord';
const SIGN_RECORD = 'TenantBase.ESignRecord';
const WRITE_SCOPE = 'employment.businessWrite';

const evidence = (unit: string, anchor: string, role: Evidence['role'] = 'impl'): Evidence => ({ unit, anchor, role });
const route = (method: string, suffix: string, anchor: string) =>
  evidence(`${EMP}/entry-esign-routes.ts#route:${method} ${ENTRY}${suffix}`, anchor, 'call');
const source = evidence(
  `${ESIGN}/source-command-result.ts#requireEntrySignSource`,
  "requireEmploymentWrite(context, 'update', {}, 'Employment.Edit', undefined, { commandOnly: true })",
);
const scope = evidence(
  `${EMP}/replay-guard.ts#requireBusinessWriteScope`,
  "ctx.transferTarget ? undefined : ctx.scope, 'write'",
  'scope',
);
const resolved = evidence(
  `${ESIGN}/source-command-result.ts#requireEntrySignSource`,
  'await requireBusinessWriteScope(tx, authorize, { ...context, scope, trustedScopeBypass }, sourceId)',
);
const sourceBoundary = evidence(
  `${EMP}/entry-esign-source.ts#authorizeEntrySignSource`,
  'await requireEntrySignSource(tx, deps, ctx, id)',
);
const writeAccess = (entry: Evidence, ...extra: Evidence[]): Obligation[] => [
  {
    perm: `obj:${RECORD}:update`,
    need: guardScope(WRITE_SCOPE),
    facts: ['object:object.* 动作'],
    at: [entry, ...extra, sourceBoundary, source, resolved, scope],
  },
  {
    perm: `btn:${RECORD}#Employment.Edit@detail`,
    at: [
      entry,
      source,
      evidence(
        `${EMP}/context.ts#requireEmploymentWrite`,
        'resource: buttonResource(objectCode, button, definition.level)',
      ),
    ],
  },
  { perm: `guard:${WRITE_SCOPE}`, facts: [`guard:${WRITE_SCOPE}`], at: [entry, sourceBoundary, resolved, scope] },
];

const history = `${EMP}/entry-esign-history.ts#entrySignHistory`;
const variables = 'esign.sourceVariables';
const variableRead = evidence(
  `${ESIGN}/source-result-access.ts#authorizeSignVariables`,
  "action: 'object.view', resource: EMPLOYEE_OBJECT",
);
const checkVariables = evidence(
  `${ESIGN}/source-initiation.ts#runSourceSignCommand`,
  'await authorizeSignVariables(tx, deps, ctx, owner.employeeId, fields)',
  'call',
);

export const EMPLOYMENT_ESIGN: RequiredTable = {
  [`GET ${ENDPOINT}context`]: writeAccess(
    route('GET', 'context', 'entrySignContext(tx, deps, ctx, id)'),
    evidence(`${EMP}/entry-esign-source.ts#entrySignContext`, 'await authorizeEntrySignSource(tx, deps, ctx, id)'),
  ),
  [`POST ${ENDPOINT}tasks`]: [
    ...writeAccess(
      route('POST', 'tasks', 'authorizeSource: (tx) => authorizeEntrySignSource(tx, deps, ctx, id)'),
      evidence(`${ESIGN}/source-initiation.ts#runSourceSignCommand`, 'await input.authorizeSource(tx)'),
    ),
    {
      perm: `guard:${variables}`,
      at: [checkVariables, variableRead],
    },
    {
      perm: 'obj:TenantBase.Employee:view',
      purpose: `when:${variables}`,
      need: guardScope(variables),
      note: '仅所选模板实际使用人员变量时复核；重放按已落库字段复核。',
      at: [
        checkVariables,
        variableRead,
        evidence(
          `${ESIGN}/source-result-access.ts#authorizeSignVariables`,
          'await requireEmployeeInScope(tx, { ...ctx, scope }, employeeId)',
          'scope',
        ),
      ],
    },
  ],
  [`GET ${ENDPOINT}records`]: [
    {
      perm: `obj:${RECORD}:view`,
      need: point('employment.record'),
      facts: ['object:object.* 动作'],
      at: [
        route('GET', 'records', 'entrySignHistory(tx, deps, ctx, id, page)'),
        evidence(
          history,
          "requirePermission(authorize, { ...ctx, action: 'object.view', resource: EMPLOYMENT_OBJECT })",
        ),
        evidence(history, 'await loadEmploymentRecord(tx, ctx.tenantId, id, asOf, sourceScope)', 'scope'),
      ],
    },
    {
      perm: `obj:${SIGN_RECORD}:view`,
      need: list('esign.recordOwner'),
      facts: ['object:object.* 动作'],
      at: [
        route('GET', 'records', 'entrySignHistory(tx, deps, ctx, id, page)'),
        evidence(history, "requirePermission(authorize, { ...ctx, action: 'object.view', resource: RECORD_OBJECT })"),
        evidence(history, 'eq(esignTasks.businessId, source.id), recordScope(scope)', 'scope'),
        evidence(history, 'getModuleViewableFieldsInTransaction(deps, ctx, RECORD_OBJECT, tx)'),
        evidence(history, 'await presentRecord(tx, ctx, task, fields)'),
      ],
    },
  ],
};
