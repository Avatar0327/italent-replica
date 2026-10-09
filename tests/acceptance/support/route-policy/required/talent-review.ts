/**
 * 必需项表：人才盘点准备度字典（modules/talent-review/routes.ts，R3-T04 PR-A）。对象操作经 access.reviewContext →
 * module-route-access.objectContext（对象 TALENT_REVIEW_OBJECTS.readiness）；写入口 reviewWriteContext 叠加 WRITE_BUTTONS
 * 按钮。路径由 TALENT_REVIEW_BASE 拼出（跨文件常量），证据绑注册函数 registerTalentReviewRoutes。
 */
import type { Evidence, Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/talent-review/readiness-levels';
const T = 'apps/api/src/modules/talent-review';
const ROUTES = `${T}/routes.ts#registerTalentReviewRoutes`;
const ACCESS = `${T}/access.ts`;
const MRA = 'apps/api/src/modules/permission/module-route-access.ts';
const RDY = 'TalentReview.Readiness';
type Operation = 'view' | 'create' | 'update' | 'delete';

const OBJECT_CONST: Evidence = {
  role: 'const',
  unit: 'packages/domain/src/talent-review/catalog.ts#TALENT_REVIEW_OBJECTS>readiness',
  anchor: "object('Readiness'",
};
const CONTEXT: Evidence[] = [
  {
    role: 'impl',
    unit: `${ACCESS}#reviewContext`,
    anchor: 'return objectContext(c, deps, codeOf(object), operation, expectedRevision)',
  },
  {
    role: 'impl',
    unit: `${MRA}#objectContext`,
    anchor:
      'await requirePermission(deps.authorize, { ...ctx, action: `object.${operation}`, ' +
      'resource: objectCode, fields: [] })',
  },
];
const BUTTON: Evidence[] = [
  {
    role: 'impl',
    unit: `${ACCESS}#reviewWriteContext`,
    anchor: 'await button(deps, ctx, codeOf(object), code, level)',
  },
  {
    role: 'impl',
    unit: `${MRA}#button`,
    anchor: "action: 'object.button', resource: buttonResource(objectCode, code, level)",
  },
];
const call = (anchor: string): Evidence => ({ role: 'call', unit: ROUTES, anchor });
const VIEW = "const ctx = await reviewContext(c, deps, 'readiness')";
const write = (operation: Exclude<Operation, 'view'>) =>
  `const ctx = await reviewWriteContext(c, deps, 'readiness', '${operation}', revision(c))`;
const LEVEL = { create: 'list', update: 'detail', delete: 'detail' } as const;

function view(anchor: string): Obligation {
  return { perm: `obj:${RDY}:view`, facts: ['object:objectContext'], at: [call(anchor), ...CONTEXT, OBJECT_CONST] };
}
function change(operation: Exclude<Operation, 'view'>): Obligation[] {
  const entry = call(write(operation));
  return [
    { perm: `obj:${RDY}:${operation}`, facts: ['object:objectContext'], at: [entry, ...CONTEXT, OBJECT_CONST] },
    {
      perm: `btn:${RDY}#${operation}@${LEVEL[operation]}`,
      facts: ['button:button()'],
      at: [
        entry,
        ...BUTTON,
        {
          role: 'const',
          unit: `${ACCESS}#WRITE_BUTTONS`,
          anchor: `${operation}: ['${operation}', '${LEVEL[operation]}']`,
        },
      ],
    },
  ];
}

export const TALENT_REVIEW: RequiredTable = {
  [`GET ${BASE}`]: [
    view(`router.get(PATH, async (c) => { ${VIEW}`),
    {
      perm: 'guard:talentReview.filterFieldVisible',
      facts: ['guard:talentReview.filterFieldVisible'],
      note: '带 enabled 筛选而无 enabled 字段查看权 → 403 FILTER_FIELD_HIDDEN（字段级，只在带筛选时判定）',
      at: [
        call("if (enabled !== undefined) await requireFilterVisible(deps, ctx, 'readiness', 'enabled')"),
        {
          role: 'impl',
          unit: `${ACCESS}#requireFilterVisible`,
          anchor: "throw new AppError('FORBIDDEN', '无权按该字段筛选', { reason: 'FILTER_FIELD_HIDDEN', field })",
        },
      ],
    },
  ],
  [`GET ${BASE}/:id`]: [view(`router.get(\`\${PATH}/:id\`, async (c) => { ${VIEW}`)],
  [`POST ${BASE}`]: change('create'),
  [`PATCH ${BASE}/:id`]: [
    ...change('update'),
    {
      perm: 'guard:talentReview.renameRequiresSeeAll',
      facts: ['guard:talentReview.renameRequiresSeeAll'],
      note: '名称实际变化且不是看全部 → 403 READINESS_NAME_REQUIRES_SEE_ALL（在查重之前判定，不暴露隐藏记录）',
      at: [
        {
          role: 'call',
          unit: `${T}/readiness-service.ts#updateReadiness`,
          anchor: 'if (patch.name !== undefined && patch.name !== before.name && !ctx.scope.all) {',
        },
      ],
    },
  ],
  [`DELETE ${BASE}/:id`]: change('delete'),
};
