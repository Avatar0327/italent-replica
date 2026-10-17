/**
 * 必需项表：Offer 管理（modules/offer，R2 BE-14a C1，DEC-581）。子应用挂在 /api/tenant/offers。
 * 读：offerReadContext / objectContext → module-route-access.objectContext（object.view）；写：runOfferWrite →
 * objectContext（object.<op>），新建 / 编辑另经 offerFieldsCheck → writeFields，删除 / 复制经 offerOperationCheck。
 * 发起审批（BE-14a3）：runOfferWrite（object.update）+ offerOperationCheck('update')，范围逐份 Offer 复核。
 * 字典写入：runDictionaryWrite → tenant.employment.configuration.write（admin other_settings）+ 任职设置对象字段编辑权。
 */
import { bound, NONE, withNeeds } from './scopes.js';
import type { Evidence, Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/offers';
const O = 'apps/api/src/modules/offer';
const ROUTES = `${O}/routes.ts`;
const CTX = `${O}/context.ts`;
const MRA = 'apps/api/src/modules/permission/module-route-access.ts';
const OFFER = 'TenantBase.Offer';
const SETTINGS = 'TenantBase.EmploymentSettings';

const at = (method: string, path: string, anchor: string): Evidence => ({
  role: 'call',
  unit: `${ROUTES}#route:${method} ${path}`,
  anchor,
});
const OBJECT_CONTEXT: Evidence = {
  role: 'impl',
  unit: `${MRA}#objectContext`,
  anchor:
    'await requirePermission(deps.authorize, { ...ctx, action: `object.${operation}`, ' +
    'resource: objectCode, fields: [] })',
};
const OFFER_CONST: Evidence = {
  role: 'const',
  unit: 'packages/domain/src/offer/rules.ts#OFFER_OBJECT',
  anchor: "'TenantBase.Offer'",
};
const READ_CONTEXT: Evidence = {
  role: 'impl',
  unit: `${CTX}#offerReadContext`,
  anchor: "const base = await objectContext(c, deps, objectCode, 'view')",
};
const WRITE_CONTEXT: Evidence = {
  role: 'impl',
  unit: `${CTX}#runOfferWrite`,
  anchor: 'const base = await objectContext(c, deps, OFFER_OBJECT, operation, expectedRevision)',
};

const view = (anchor: string, path: string, viaReadContext: boolean): Obligation => ({
  perm: `obj:${OFFER}:view`,
  facts: viaReadContext ? ['object:objectContext'] : ['object:objectContext', `objectOp:${OFFER}:view`],
  at: [at('GET', path, anchor), ...(viaReadContext ? [READ_CONTEXT] : []), OBJECT_CONTEXT, OFFER_CONST],
});
const readView = (path: string) => [view('const ctx = await offerReadContext(c, deps)', path, true)];

const offerWrite = (
  method: string,
  path: string,
  operation: 'create' | 'update' | 'delete',
  writes?: Evidence,
): Obligation[] => [
  {
    perm: `obj:${OFFER}:${operation}`,
    facts: writes ? ['object:objectContext', `objectOp:${OFFER}:${operation}`] : ['object:objectContext'],
    at: [
      at(method, path, 'return runOfferWrite('),
      WRITE_CONTEXT,
      OBJECT_CONTEXT,
      OFFER_CONST,
      ...(writes ? [writes] : []),
    ],
  },
];
/** 新建 / 复制按展开继承之后实际写入的字段校验编辑权（审查 #394 P2-01，checks.ts）。 */
const writesCheck = (name: string, anchor: string): Evidence => ({
  role: 'impl',
  unit: `${O}/checks.ts#${name}`,
  anchor,
});

const dictionaryWrite = (method: string, path: string, operation: 'create' | 'update'): Obligation[] =>
  withNeeds(
    [
      {
        perm: 'admin:other_settings',
        facts: ['admin:tenant.employment.configuration'],
        at: [
          at(method, path, 'return runDictionaryWrite('),
          {
            role: 'impl',
            unit: `${CTX}#runDictionaryWrite`,
            anchor:
              'await requirePermission(authorize, { ...ctx, action: CONFIGURATION_WRITE, ' +
              'resource: OFFER_DICTIONARY_OBJECT })',
          },
          { role: 'const', unit: `${CTX}#CONFIGURATION_WRITE`, anchor: "'tenant.employment.configuration.write'" },
        ],
      },
      {
        perm: `obj:${SETTINGS}:${operation}`,
        facts: ['object:requireObjectWrite（对象写操作权）'],
        at: [
          at(method, path, 'return runDictionaryWrite('),
          {
            role: 'impl',
            unit: `${CTX}#runDictionaryWrite`,
            anchor:
              'await requireObjectWrite(authorize, ctx, { objectCode: OFFER_DICTIONARY_OBJECT, operation, ' +
              'payload: fields })',
          },
          { role: 'const', unit: `${CTX}#OFFER_DICTIONARY_OBJECT`, anchor: "'TenantBase.EmploymentSettings'" },
        ],
      },
    ],
    { 'admin:other_settings': bound(NONE), [`obj:${SETTINGS}:${operation}`]: bound(NONE) },
  );

export const OFFERS: RequiredTable = {
  [`GET ${BASE}/views`]: [view("await objectContext(c, deps, OFFER_OBJECT, 'view')", '/views', false)],
  [`GET ${BASE}/dictionaries/:kind`]: [
    view("const ctx = await objectContext(c, deps, OFFER_OBJECT, 'view')", '/dictionaries/:kind', false),
  ],
  [`POST ${BASE}/dictionaries/:kind`]: dictionaryWrite('POST', '/dictionaries/:kind', 'create'),
  [`PUT ${BASE}/dictionaries/:kind/:id`]: dictionaryWrite('PUT', '/dictionaries/:kind/:id', 'update'),
  [`GET ${BASE}`]: [
    ...readView('/'),
    {
      perm: 'guard:offer.filterFieldVisible',
      note: '带筛选而无该字段查看权 → 403 FILTER_FIELD_HIDDEN（字段级，只在带筛选时判定）',
      at: [
        at('GET', '/', "const { view, filters } = await listFilters(c, deps, ctx, c.req.query('view'))"),
        {
          role: 'impl',
          unit: `${ROUTES}#listFilters`,
          anchor:
            "throw new AppError('FORBIDDEN', '无权按该字段筛选', { reason: 'FILTER_FIELD_HIDDEN', fields: hidden })",
        },
      ],
    },
  ],
  [`GET ${BASE}/:id`]: readView('/:id'),
  [`POST ${BASE}`]: offerWrite(
    'POST',
    '/',
    'create',
    writesCheck(
      'offerCreateCheck',
      "writeFields({ authorize }, ctx, OFFER_OBJECT, 'create', tx ? await writes(tx, ctx) : input)",
    ),
  ),
  [`PUT ${BASE}/:id`]: offerWrite('PUT', '/:id', 'update'),
  [`DELETE ${BASE}/:id`]: offerWrite('DELETE', '/:id', 'delete'),
  // BE-14a3：单个 / 批量发起审批，与编辑同一判定（object.update + 范围），审批流转在同一事务内交审批中心
  [`POST ${BASE}/:id/approval`]: offerWrite('POST', '/:id/approval', 'update'),
  [`POST ${BASE}/batch-approvals`]: offerWrite('POST', '/batch-approvals', 'update'),
  [`POST ${BASE}/:id/copy`]: offerWrite(
    'POST',
    '/:id/copy',
    'create',
    writesCheck('offerCopyCheck', "writeFields({ authorize }, ctx, OFFER_OBJECT, 'create', tx ? offerCopyWrites"),
  ),
};
