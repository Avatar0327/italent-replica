/**
 * 必需项表：组织调整申请（modules/org-adjustment/routes.ts，R2-T08 BE-10b1 头字段与调整范围）。对象操作经
 * module-route-access.objectContext（对象 TenantBase.OrganizationApproval）；按钮经 button；字段权经 writeFields。
 * 主体组织（OrganizationApproval 范围）与调整范围所选组织（组织对象范围）经 authorizeHead 在命令事务内判定（守卫
 * orgAdjustment.head；作废 / 校验不写字段，走 authorizeHeadAction；改头 / 作废 / 校验经 authorizeStored 对锁住的现值再判），范围外与不存在同为 404。
 * 组织明细（BE-10b2，路由 4～6、8～9）：路由层判主对象 update、入口 / 行按钮、`orgItems.*` 字段；命令守卫经 itemCommand →
 * authorizeItem 再判同一按钮、主体组织与行涉及的组织（守卫 orgAdjustment.item）。
 */
import type { Evidence, Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/org-adjustment/adjustments';
const ROUTES = 'apps/api/src/modules/org-adjustment/routes.ts';
const ACCESS = 'apps/api/src/modules/permission/module-route-access.ts';
const OBJ = 'TenantBase.OrganizationApproval';
const OBJECT_CONST: Evidence[] = [
  { role: 'const', unit: `${ROUTES}#OBJECT`, anchor: 'ORG_ADJUSTMENT_OBJECT_CODE' },
  {
    role: 'const',
    unit: 'packages/domain/src/org-adjustment/fields.ts#ORG_ADJUSTMENT_OBJECT_CODE',
    anchor: "'TenantBase.OrganizationApproval'",
  },
];
const CONTEXT: Evidence = {
  role: 'impl',
  unit: `${ACCESS}#objectContext`,
  anchor:
    'await requirePermission(deps.authorize, { ...ctx, action: ' +
    '`object.${operation}`, resource: objectCode, fields: [] })',
};
const BUTTON: Evidence = {
  role: 'impl',
  unit: `${ACCESS}#button`,
  anchor: "action: 'object.button', resource: buttonResource(objectCode, code, level)",
};
const AUTH = 'apps/api/src/modules/org-adjustment/access.ts';
type Entry = 'authorizeHead' | 'authorizeHeadAction';
/** 命令事务内的入口：带字段的 authorizeHead 与不带字段的 authorizeHeadAction 都先判按钮、再判范围。 */
const entry = (fn: Entry, anchor: string): Evidence => ({ role: 'impl', unit: `${AUTH}#${fn}`, anchor });
const SCOPES: Evidence = {
  role: 'impl',
  unit: `${AUTH}#requireScopes`,
  anchor:
    "if (!scopeAllows(main, { orgId: input.subjectOrgId })) throw new AppError('NOT_FOUND', '组织调整申请不存在')",
};
/** 命令事务内按同一按钮再判一次（首次与重放都经过）。 */
const HEAD_BUTTON: Evidence[] = [
  { role: 'impl', unit: `${AUTH}#requireButtons`, anchor: 'resource: buttonResource(OBJECT, buttonCode, buttonLevel)' },
  { role: 'const', unit: `${AUTH}#OBJECT`, anchor: 'ORG_ADJUSTMENT_OBJECT_CODE' },
];
const STORED: Evidence = {
  role: 'impl',
  unit: `${ROUTES}#authorizeStored`,
  anchor: 'await judge(stored.approvalSubjectOrgId, stored.adjustmentRange)',
};
const call = (method: string, path: string, anchor: string): Evidence => ({
  role: 'call',
  unit: `${ROUTES}#route:${method} ${path}`,
  anchor,
});

/** 写头字段的入口另在命令事务内经 authorizeHead 判对象写操作权与字段编辑权（首次与重放都经过）。 */
const HEAD_WRITE: Evidence[] = [
  {
    role: 'impl',
    unit: `${AUTH}#authorizeHead`,
    anchor: 'await requireObjectWrite(bound.authorize, ctx, {',
  },
  {
    role: 'impl',
    unit: 'apps/api/src/modules/permission/object-write.ts#requireObjectWrite',
    anchor: 'action: `object.${write.operation}`',
  },
];
function op(method: string, path: string, operation: 'create' | 'update', anchor?: string, writes = false): Obligation {
  return {
    perm: `obj:${OBJ}:${operation}`,
    facts: [
      'object:objectContext',
      `objectOp:${OBJ}:${operation}`,
      ...(writes ? ['object:requireObjectWrite（对象写操作权）'] : []),
    ],
    at: [
      call(method, path, anchor ?? `const ctx = await objectContext(c, deps, OBJECT, '${operation}', revision(c))`),
      CONTEXT,
      ...OBJECT_CONST,
      ...(writes ? HEAD_WRITE : []),
    ],
  };
}
function btn(
  method: string,
  path: string,
  code: string,
  level: 'list' | 'list_row' | 'detail',
  fn: Entry = 'authorizeHead',
): Obligation {
  return {
    perm: `btn:${OBJ}#${code}@${level}`,
    facts: ['button:button()', 'button:buttonResource', 'button:object.button'],
    at: [
      call(method, path, `await button(deps, ctx, OBJECT, '${code}', '${level}')`),
      BUTTON,
      ...OBJECT_CONST,
      entry(fn, 'await requireButtons(bound, ctx, input)'),
      ...HEAD_BUTTON,
    ],
  };
}
const head = (
  method: string,
  path: string,
  anchor: string,
  fn: Entry = 'authorizeHead',
  stored = true,
): Obligation => ({
  perm: 'guard:orgAdjustment.head',
  facts: ['guard:orgAdjustment.head'],
  at: [
    call(method, path, anchor),
    ...(stored ? [STORED] : []),
    entry(fn, 'await requireScopes(tx, bound, ctx, input)'),
    SCOPES,
  ],
});

// ---- 组织明细（BE-10b2）----------------------------------------------------------------------------------------
const DETAIL_OBJ = 'TenantBase.OrganizationApprovalDetail';
const ITEMS = `${BASE}/:id/org-items`;
const ENTRY_FILE = 'packages/domain/src/org-adjustment/entry-buttons.ts#ORG_ITEM_ENTRY_BUTTONS';
const ITEM_GUARD: Evidence[] = [
  {
    role: 'impl',
    unit: `${ROUTES}#itemCommand`,
    anchor: 'await authorizeItem(tx, deps, ctx, input)',
  },
];
/** authorizeItem 先按命令登记的同一按钮再判一次（首次与重放都经过）。 */
const ITEM_BUTTON: Evidence = {
  role: 'impl',
  unit: `${AUTH}#authorizeItem`,
  anchor: "action: 'object.button',",
};
const ITEM_OP = (method: string, path: string) => op(method, path, 'update');
function itemBtn(
  method: string,
  path: string,
  object: string,
  code: string,
  level: 'list' | 'list_row' | 'detail' | 'app_page',
  anchor: string,
  extra: Partial<Obligation> = {},
): Obligation {
  return {
    perm: `btn:${object}#${code}@${level}`,
    facts: ['button:button()', 'button:buttonResource', 'button:object.button'],
    at: [call(method, path, anchor), BUTTON, ...ITEM_GUARD, ITEM_BUTTON],
    ...extra,
  };
}
const itemScope = (method: string, path: string, anchor = 'return itemCommand('): Obligation => ({
  perm: 'guard:orgAdjustment.item',
  facts: ['guard:orgAdjustment.item'],
  at: [
    call(method, path, anchor),
    ...ITEM_GUARD,
    { role: 'impl', unit: `${AUTH}#authorizeItem`, anchor: 'await requireScopes(tx, bound, ctx, {' },
    SCOPES,
  ],
});
const ROW = (code: string) => (method: string, path: string, anchor: string) =>
  itemBtn(method, path, DETAIL_OBJ, code, 'list_row', anchor);
const ENTRIES = [
  ['editor.sub', OBJ, 'AddSubOrgApprovalDetails', 'app_page'],
  ['editor.peer', OBJ, 'AddPeerOrgApprovalDetail', 'app_page'],
  ['editor.create', OBJ, 'AddOrgBtn', 'app_page'],
  ['editor.change', OBJ, 'ChangeOrgBtn', 'app_page'],
  ['editor.drag', OBJ, 'DragToGenerateOrgApprovalDetails', 'app_page'],
  ['editor.stop', OBJ, 'StopOrgBtn', 'app_page'],
  ['detail.create', DETAIL_OBJ, 'OrgAjustDetailCreate', 'list'],
  ['detail.change', DETAIL_OBJ, 'OrgAdjustDetailChange', 'list'],
  ['detail.stop', DETAIL_OBJ, 'orgAdjustDetailStop', 'list'],
] as const;

export const ORG_ADJUSTMENT: RequiredTable = {
  [`POST ${BASE}`]: [
    op('POST', BASE, 'create', undefined, true),
    btn('POST', BASE, 'AddAdjustOrgApprovalBtn', 'list'),
    head('POST', BASE, 'before: (tx) => authorizeHead(tx, deps, ctx, head)', 'authorizeHead', false),
  ],
  [`PATCH ${BASE}/:id`]: [
    op('PATCH', `${BASE}/:id`, 'update', undefined, true),
    btn('PATCH', `${BASE}/:id`, 'EditAdjustOrgDetailBtn', 'detail'),
    head('PATCH', `${BASE}/:id`, 'authorizeHead(tx, deps, ctx, {'),
  ],
  [`POST ${BASE}/:id/void`]: [
    op('POST', `${BASE}/:id/void`, 'update'),
    btn('POST', `${BASE}/:id/void`, 'OrganizationApprovalDelete', 'list_row', 'authorizeHeadAction'),
    head('POST', `${BASE}/:id/void`, 'authorizeHeadAction(tx, deps, ctx, {', 'authorizeHeadAction'),
  ],
  [`POST ${BASE}/:id/check`]: [
    op('POST', `${BASE}/:id/check`, 'update', "const ctx = await objectContext(c, deps, OBJECT, 'update')"),
    btn('POST', `${BASE}/:id/check`, 'EditAdjustOrgDetailBtn', 'detail', 'authorizeHeadAction'),
    head('POST', `${BASE}/:id/check`, 'authorizeHeadAction(tx, deps, ctx, {', 'authorizeHeadAction'),
  ],
  [`POST ${ITEMS}`]: [
    ITEM_OP('POST', ITEMS),
    ...ENTRIES.map(([entry, object, code, level]) =>
      itemBtn(
        'POST',
        ITEMS,
        object,
        code,
        level,
        'await button(deps, ctx, entry.objectCode, entry.code, entry.level)',
        {
          or: `entry:${entry}`,
          at: [
            call('POST', ITEMS, 'await button(deps, ctx, entry.objectCode, entry.code, entry.level)'),
            { role: 'const', unit: ENTRY_FILE, anchor: `'${entry}': { objectCode:` },
            BUTTON,
            ...ITEM_GUARD,
            ITEM_BUTTON,
          ],
        },
      ),
    ),
    itemScope('POST', ITEMS),
  ],
  [`PATCH ${ITEMS}/:itemId`]: [
    ITEM_OP('PATCH', `${ITEMS}/:itemId`),
    ROW('EditOrgApprovalDetail')('PATCH', `${ITEMS}/:itemId`, 'await button(deps, ctx, ...ROW_EDIT)'),
    itemScope('PATCH', `${ITEMS}/:itemId`),
  ],
  [`DELETE ${ITEMS}/:itemId`]: [
    ITEM_OP('DELETE', `${ITEMS}/:itemId`),
    ROW('DelteOrgApprovalDetail')('DELETE', `${ITEMS}/:itemId`, 'await button(deps, ctx, ...rowDelete)'),
    itemScope('DELETE', `${ITEMS}/:itemId`, 'return itemCommand('),
  ],
  [`POST ${BASE}/:id/items/:section/:itemId/rebase`]: [
    ITEM_OP('POST', `${BASE}/:id/items/:section/:itemId/rebase`),
    ROW('EditOrgApprovalDetail')(
      'POST',
      `${BASE}/:id/items/:section/:itemId/rebase`,
      'await button(deps, ctx, ...ROW_EDIT)',
    ),
    itemScope('POST', `${BASE}/:id/items/:section/:itemId/rebase`),
  ],
  [`POST ${BASE}/:id/rebase`]: [
    ITEM_OP('POST', `${BASE}/:id/rebase`),
    itemBtn(
      'POST',
      `${BASE}/:id/rebase`,
      OBJ,
      'EditAdjustOrgDetailBtn',
      'detail',
      'await button(deps, ctx, OBJECT, code, level)',
    ),
    itemScope('POST', `${BASE}/:id/rebase`),
  ],
};
