/**
 * 必需项表：Offer 管理（modules/offer，R2 BE-14a C1，DEC-581）。子应用挂在 /api/tenant/offers。
 * 读：offerReadContext / objectContext → module-route-access.objectContext（object.view）；写：runOfferWrite →
 * objectContext（object.<op>），新建 / 编辑另经 offerFieldsCheck → writeFields，删除 / 复制经 offerOperationCheck。
 * 字典写入：runDictionaryWrite → tenant.employment.configuration.write（admin other_settings）+ 任职设置对象字段编辑权。
 * C2（BE-14a2，transitions.ts）：转移两个入口各经 offerTransferCheck → button()（行级 / 列表级各一项）；失效经
 * offerOperationCheck(update)；转移表单与 OF-R3 发送判定只读，经 offerReadContext。
 * BE-14b1（send.ts）：发送 / 重发经 runOfferWrite + offerOperationCheck(update)。
 */
import { bound, NONE, withNeeds } from './scopes.js';
import type { Evidence, Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/offers';
const O = 'apps/api/src/modules/offer';
const ROUTES = `${O}/routes.ts`;
const TRANSITIONS = `${O}/transitions.ts`;
const SEND = `${O}/send.ts`;
const CTX = `${O}/context.ts`;
const MRA = 'apps/api/src/modules/permission/module-route-access.ts';
const OFFER = 'TenantBase.Offer';
const SETTINGS = 'TenantBase.EmploymentSettings';

const at = (method: string, path: string, anchor: string, file = ROUTES): Evidence => ({
  role: 'call',
  unit: `${file}#route:${method} ${path}`,
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

const view = (anchor: string, path: string, viaReadContext: boolean, file = ROUTES): Obligation => ({
  perm: `obj:${OFFER}:view`,
  facts: viaReadContext ? ['object:objectContext'] : ['object:objectContext', `objectOp:${OFFER}:view`],
  at: [at('GET', path, anchor, file), ...(viaReadContext ? [READ_CONTEXT] : []), OBJECT_CONTEXT, OFFER_CONST],
});
const readView = (path: string, file = ROUTES) => [
  view('const ctx = await offerReadContext(c, deps)', path, true, file),
];

const offerWrite = (
  method: string,
  path: string,
  operation: 'create' | 'update' | 'delete',
  writes?: Evidence,
  file = ROUTES,
): Obligation[] => [
  {
    perm: `obj:${OFFER}:${operation}`,
    facts: writes ? ['object:objectContext', `objectOp:${OFFER}:${operation}`] : ['object:objectContext'],
    at: [
      at(method, path, 'return runOfferWrite(', file),
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

/** 转移状态：对象编辑（runOfferWrite → objectContext）+ 入口对应的一项按钮（offerTransferCheck → button()）。 */
const transferWrite = (path: string, ref: { readonly code: string; readonly level: string }, key: string) => {
  const entry: Evidence[] = [
    at('POST', path, `transferCommand(c, deps, OFFER_BUTTONS.${key})`, TRANSITIONS),
    { role: 'impl', unit: `${TRANSITIONS}#transferCommand`, anchor: 'return runOfferWrite(' },
  ];
  return [
    {
      perm: `obj:${OFFER}:update`,
      facts: ['object:objectContext'],
      at: [...entry, WRITE_CONTEXT, OBJECT_CONTEXT, OFFER_CONST],
    },
    {
      perm: `btn:${OFFER}#${ref.code}@${ref.level}`,
      facts: ['button:button()'],
      at: [
        ...entry,
        {
          role: 'impl',
          unit: `${CTX}#offerTransferCheck`,
          anchor: 'return button(deps, ctx, OFFER_OBJECT, ref.code, ref.level)',
        },
        {
          role: 'impl',
          unit: `${MRA}#button`,
          anchor: "action: 'object.button', resource: buttonResource(objectCode, code, level)",
        },
      ],
    },
  ] satisfies Obligation[];
};

/** 列表 / 详情的行操作披露（offerActionAccess）：五项判定只决定 rowActions / toolbarActions，不参与准入。 */
const ACCESS = `${TRANSITIONS}#offerActionAccess`;
const BUTTONS_CONST: Evidence = {
  role: 'const',
  unit: 'packages/domain/src/offer/rules.ts#OFFER_BUTTONS',
  anchor: 'OfferLineOpStatusTransfer',
};
const actionDisclosure = (path: string, anchor: string): Obligation[] => {
  const route = at('GET', path, anchor);
  const button = (key: string, code: string, level: string, local: string): Obligation => ({
    perm: `btn:${OFFER}#${code}@${level}`,
    purpose: `disclosure:${key}`,
    need: NONE,
    facts: ['button:buttonResource', 'button:object.button'],
    note: `只决定 ${key === 'toolbarTransfer' ? 'toolbarActions' : '行操作 transfer'}，不拒绝请求`,
    at: [
      route,
      {
        role: 'impl',
        unit: ACCESS,
        anchor: `can('object.button', buttonResource(OFFER_OBJECT, ${local}.code, ${local}.level))`,
      },
      BUTTONS_CONST,
    ],
  });
  const operation = (key: string, op: string): Obligation => ({
    perm: `obj:${OFFER}:${op}`,
    purpose: `disclosure:${key}`,
    need: NONE,
    facts: ['object:object.* 动作'],
    note: '只决定行操作是否出现，不拒绝请求',
    at: [route, { role: 'impl', unit: ACCESS, anchor: `can('object.${op}', OFFER_OBJECT)` }, OFFER_CONST],
  });
  return [
    button('rowTransfer', 'OfferLineOpStatusTransfer', 'list_row', 'row'),
    button('toolbarTransfer', 'Offer.StatusTransfer', 'list', 'list'),
    operation('rowUpdate', 'update'),
    operation('rowDelete', 'delete'),
    operation('rowCopy', 'create'),
  ];
};

/** 新建响应的重聘提示（identity.ts）：按任职记录查看权裁剪后才附上，只决定响应是否带 rehireHint，不拒绝请求。 */
const rehireDisclosure = (): Obligation[] => [
  {
    perm: 'obj:TenantBase.EmploymentRecord:view',
    purpose: 'disclosure:rehireHint',
    need: NONE,
    facts: ['object:object.* 动作', 'objectOp:TenantBase.EmploymentRecord:view'],
    note: '只决定响应是否带 rehireHint，不拒绝请求（无权 / 范围外 / 字段不可见都当作没有命中）',
    at: [
      at('POST', '/', 'respond: (ctx, body) => withRehireHint(deps, ctx, body)'),
      {
        role: 'impl',
        unit: `${O}/identity.ts#visibleRehireHint`,
        anchor: "action: 'object.view', resource: EMPLOYMENT_OBJECT",
      },
      {
        role: 'const',
        unit: 'apps/api/src/modules/employment/context.ts#EMPLOYMENT_OBJECT',
        anchor: "'TenantBase.EmploymentRecord'",
      },
    ],
  },
];

export const OFFERS: RequiredTable = {
  [`GET ${BASE}/views`]: [view("await objectContext(c, deps, OFFER_OBJECT, 'view')", '/views', false)],
  [`GET ${BASE}/dictionaries/:kind`]: [
    view("const ctx = await objectContext(c, deps, OFFER_OBJECT, 'view')", '/dictionaries/:kind', false),
  ],
  [`POST ${BASE}/dictionaries/:kind`]: dictionaryWrite('POST', '/dictionaries/:kind', 'create'),
  [`PUT ${BASE}/dictionaries/:kind/:id`]: dictionaryWrite('PUT', '/dictionaries/:kind/:id', 'update'),
  [`GET ${BASE}`]: [
    ...readView('/'),
    ...actionDisclosure('/', 'const { allowed, toolbarActions } = await offerActionAccess(deps, ctx)'),
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
  [`GET ${BASE}/:id`]: [
    ...readView('/:id'),
    ...actionDisclosure('/:id', 'const { allowed } = await offerActionAccess(deps, ctx)'),
  ],
  [`POST ${BASE}`]: [
    ...offerWrite(
      'POST',
      '/',
      'create',
      writesCheck(
        'offerCreateCheck',
        "writeFields({ authorize }, ctx, OFFER_OBJECT, 'create', tx ? await writes(tx, ctx) : input)",
      ),
    ),
    ...rehireDisclosure(),
  ],
  [`PUT ${BASE}/:id`]: offerWrite('PUT', '/:id', 'update'),
  [`DELETE ${BASE}/:id`]: offerWrite('DELETE', '/:id', 'delete'),
  [`POST ${BASE}/:id/copy`]: offerWrite(
    'POST',
    '/:id/copy',
    'create',
    writesCheck('offerCopyCheck', "writeFields({ authorize }, ctx, OFFER_OBJECT, 'create', tx ? offerCopyWrites"),
  ),
  [`GET ${BASE}/:id/transfer-form`]: readView('/:id/transfer-form', TRANSITIONS),
  [`GET ${BASE}/:id/send-check`]: readView('/:id/send-check', TRANSITIONS),
  [`POST ${BASE}/:id/transfer`]: transferWrite(
    '/:id/transfer',
    { code: 'OfferLineOpStatusTransfer', level: 'list_row' },
    'lineStatusTransfer',
  ),
  [`POST ${BASE}/:id/toolbar-transfer`]: transferWrite(
    '/:id/toolbar-transfer',
    { code: 'Offer.StatusTransfer', level: 'list' },
    'statusTransfer',
  ),
  [`POST ${BASE}/:id/invalidate`]: offerWrite('POST', '/:id/invalidate', 'update', undefined, TRANSITIONS),
  [`POST ${BASE}/:id/send`]: offerWrite('POST', '/:id/send', 'update', undefined, SEND),
};
