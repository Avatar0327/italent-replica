/**
 * 必需项表：组织调整申请（modules/org-adjustment/routes.ts，R2-T08 BE-10b1 头字段与调整范围）。对象操作经
 * module-route-access.objectContext（对象 TenantBase.OrganizationApproval）；按钮经 button；字段权经 writeFields。
 * 主体组织（OrganizationApproval 范围）与调整范围所选组织（组织对象范围）经 authorizeHead 在命令事务内判定（守卫
 * orgAdjustment.head；作废 / 校验不写字段，走 authorizeHeadAction；改头 / 作废 / 校验经 authorizeStored 对锁住的现值再判），范围外与不存在同为 404。
 * 组织明细（BE-10b2，路由 4～6、8～9）：路由层判主对象 update、入口 / 行按钮、`orgItems.*` 字段；命令守卫经 itemCommand →
 * authorizeItem 再判同一按钮、主体组织与行涉及的组织（守卫 orgAdjustment.item）。
 * 提交 / 撤回（BE-10c，路由 10 / 11）：命令守卫经 authorizeStored → authorizeOwnerAction（提交，含按钮）/ authorizeWithdraw
 * （撤回，没有按钮）判主对象 update、主体组织与调整范围（守卫 orgAdjustment.head）；提交另按新建口径判全部明细涉及的组织
 * （守卫 orgAdjustment.item）。
 * 读取（BE-10d，路由 12～15）：列表经 objectContext 判 view，主体组织范围在 SQL 里过滤；详情 / 明细 / 预览经
 * read-routes → disclosure.orgAdjustmentDisclosure（HR 读权 + 范围，或可打开最新审批实例），都不是 404。
 * 架构图导出（BE-10e，路由 28）与预览同一判定（DEC-650①）。
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
type Entry = 'authorizeHead' | 'authorizeHeadAction' | 'authorizeOwnerAction' | 'authorizeWithdraw';
/**
 * 命令事务内的入口：authorizeHead（带字段）、authorizeHeadAction（不带字段）、authorizeOwnerAction（提交）先判按钮、再判范围；
 * authorizeWithdraw（撤回）没有按钮，只判范围。
 */
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
/** 提交 / 撤回在命令事务内经 authorizeOwnerAction / authorizeWithdraw 判对象写操作权（首次与重放都经过）。 */
const ownerWrite = (fn: 'authorizeOwnerAction' | 'authorizeWithdraw'): Evidence[] => [
  entry(fn, "await requireObjectWrite(bound.authorize, ctx, { objectCode: OBJECT, operation: 'update', payload: {} })"),
  HEAD_WRITE[1]!,
];
function op(
  method: string,
  path: string,
  operation: 'create' | 'update',
  anchor?: string,
  writes: false | Evidence[] | true = false,
): Obligation {
  const writeAt = writes === true ? HEAD_WRITE : writes || [];
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
      ...writeAt,
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

/** 明细行涉及的组织逐个在组织对象范围（提交按新建口径）。 */
const ORG_ROWS: Evidence = {
  role: 'impl',
  unit: `${AUTH}#orgScopeAuthorizer`,
  anchor: 'for (const orgId of orgIds) await authorizeOrgResult(tx, scoped, orgScope, orgId, false)',
};

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
/** 新增 / 编辑明细在命令事务内经 authorizeFields → authorizeOrgFields 判组织对象写操作权（B1b，首次与重放都经过）。 */
const ITEM_ORG_WRITE = (method: string, path: string, anchor: string): Evidence[] => [
  call(method, path, anchor),
  { role: 'impl', unit: `${AUTH}#authorizeOrgFields`, anchor: 'await requireObjectWrite(bound.authorize, ctx, {' },
  HEAD_WRITE[1]!,
];
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

// ---- 读取（BE-10d，路由 12～15）---------------------------------------------------------------------------------
const READ = 'apps/api/src/modules/org-adjustment/read-routes.ts';
const DISC = 'apps/api/src/modules/org-adjustment/disclosure.ts';
const QUERIES = 'apps/api/src/modules/org-adjustment/queries.ts';
const readCall = (path: string, anchor: string): Evidence => ({
  role: 'call',
  unit: `${READ}#route:GET ${path}`,
  anchor,
});
const READ_OBJECT: Evidence[] = [{ role: 'const', unit: `${READ}#OBJECT`, anchor: 'ORG_ADJUSTMENT_OBJECT_CODE' }];
/** 路由 12：对象查看权（objectContext，无权 403）；主体组织按 OrganizationApproval 范围在 SQL 里先过滤再分页。 */
const LIST: Obligation[] = [
  {
    perm: `obj:${OBJ}:view`,
    facts: ['object:objectContext', `objectOp:${OBJ}:view`],
    need: { scope: 'list', predicate: 'orgAdjustment.subjectScope' },
    at: [
      readCall(BASE, "const ctx = await objectContext(c, deps, OBJECT, 'view')"),
      CONTEXT,
      ...READ_OBJECT,
      ...OBJECT_CONST.slice(1),
      {
        role: 'scope',
        unit: `${READ}#route:GET ${BASE}`,
        anchor: 'const scope = await resolveModuleScopeInTransaction(bound, ctx, tx, OBJECT)',
      },
      {
        role: 'scope',
        unit: `${QUERIES}#listAdjustments`,
        anchor: 'scopeSql(scope, { org: sql`a.approval_subject_org_id`, creator: sql`a.created_by` })',
      },
    ],
  },
];
const DISCLOSURE_ENTRY: Evidence = {
  role: 'impl',
  unit: `${DISC}#orgAdjustmentDisclosure`,
  anchor: 'const hr = await hrDisclosure(tx, bound, ctx, view)',
};
// F-476 P5：openDetail 提到审批共用的 frozen-read.ts（改名 openApprovalDetail），实现不变
const OPEN_DETAIL = 'apps/api/src/modules/approval/frozen-read.ts#openApprovalDetail';
const DISC_OBJECT: Evidence = { role: 'const', unit: `${DISC}#OBJECT`, anchor: 'ORG_ADJUSTMENT_OBJECT_CODE' };
const CAN_OPEN_CALL: Evidence = {
  role: 'impl',
  unit: `${DISC}#orgAdjustmentDisclosure`,
  anchor: 'const data = instance ? await openApprovalDetail(tx, bound, ctx, instance) : null;',
};
/**
 * 路由 13～15 共用 orgAdjustmentDisclosure：HR（对象查看权 + 主体组织在 OrganizationApproval 范围），或可打开最新审批实例
 * （发起人 / 参与人 / 范围内的实例管理员，同审批中心 assertCanOpen）；都不是 → 404，与不存在同文案。
 */
function reader(path: string, anchor: string): Obligation[] {
  const call = readCall(path, anchor);
  return [
    {
      perm: `obj:${OBJ}:view`,
      or: 'reader:hr',
      facts: ['object:object.* 动作', 'or:orgAdjustment.disclosure'],
      note: 'HR 路径：对象查看权为假时不拒绝，转去判审批实例；两条都不通过 404',
      at: [
        call,
        DISCLOSURE_ENTRY,
        {
          role: 'impl',
          unit: `${DISC}#hrDisclosure`,
          anchor: "const request = { ...ctx, action: 'object.view', resource: OBJECT, fields: [] }",
        },
        DISC_OBJECT,
        ...OBJECT_CONST.slice(1),
      ],
    },
    {
      perm: 'guard:orgAdjustment.disclosure',
      or: 'reader:hr',
      note: '主体组织在 OrganizationApproval 范围；范围外与不存在同为 404',
      at: [
        call,
        DISCLOSURE_ENTRY,
        {
          role: 'impl',
          unit: `${DISC}#hrDisclosure`,
          anchor:
            'if (!scopeAllows(main, { orgId: view.approvalSubjectOrgId, creatorId: view.createdBy })) return null',
        },
      ],
    },
    {
      perm: 'rel:orgAdjustment.approvalCanOpen',
      or: 'reader:approver',
      note: '审批人路径：字段 = 查看人所在节点 formFields ∩ 字段查看权（disclosedFieldNames）',
      at: [
        call,
        CAN_OPEN_CALL,
        {
          role: 'impl',
          unit: OPEN_DETAIL,
          anchor: 'return await readDetail(tx, command, instance.id, viewer, false)',
        },
        {
          role: 'impl',
          unit: 'apps/api/src/modules/approval/disclosure.ts#assertCanOpen',
          anchor: "throw new AppError('NOT_FOUND', '审批实例不存在')",
        },
      ],
    },
    ...(['adminTransfer', 'adminIntervene'] as const).map((code): Obligation => ({
      perm: `btn:TenantBase.ApprovalInstance#${code}@detail`,
      purpose: 'guard:orgAdjustment.approvalCanOpen',
      facts: ['button:buttonResource', 'button:object.button'],
      inner: { role: 'or', group: 'canOpen', alt: code },
      note: '范围内的实例管理员也能打开（assertCanOpen 的管理员分支），与审批中心详情同口径',
      at: [
        call,
        CAN_OPEN_CALL,
        {
          role: 'impl',
          unit: OPEN_DETAIL,
          anchor: "if (!(await bound.authorize({ ...ctx, action: 'object.button', resource }))) return null;",
        },
      ],
    })),
  ];
}
const READER_ANCHOR = 'await orgAdjustmentDisclosure(tx, deps, ctx, id)';

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
  [`POST ${BASE}/:id/submit`]: [
    op('POST', `${BASE}/:id/submit`, 'update', undefined, ownerWrite('authorizeOwnerAction')),
    btn('POST', `${BASE}/:id/submit`, 'EditAdjustOrgDetailBtn', 'detail', 'authorizeOwnerAction'),
    head('POST', `${BASE}/:id/submit`, 'authorizeOwnerAction(tx, deps, ctx, {', 'authorizeOwnerAction'),
    {
      perm: 'guard:orgAdjustment.item',
      facts: ['guard:orgAdjustment.item'],
      note: '全部明细（含暂存行）涉及的组织按新建口径逐个在组织对象范围（§6.3 路由 10，before = null）',
      at: [call('POST', `${BASE}/:id/submit`, 'await orgScopeAuthorizer(deps, ctx)(tx, rowOrgIds('), ORG_ROWS],
    },
  ],
  [`POST ${BASE}/:id/withdraw`]: [
    op('POST', `${BASE}/:id/withdraw`, 'update', undefined, ownerWrite('authorizeWithdraw')),
    {
      perm: 'guard:orgAdjustment.head',
      facts: ['guard:orgAdjustment.head'],
      note: '撤回没有按钮（§6.3 路由 11），authorizeWithdraw 只判主对象 update 与主体组织 + 调整范围',
      at: [
        call('POST', `${BASE}/:id/withdraw`, 'authorizeWithdraw(tx, deps, ctx, { subjectOrgId, rangeOrgIds })'),
        STORED,
        entry(
          'authorizeWithdraw',
          "await requireScopes(tx, bound, ctx, { ...owner, actor: 'applicant', operation: 'update' })",
        ),
        SCOPES,
      ],
    },
  ],
  [`POST ${ITEMS}`]: [
    op(
      'POST',
      ITEMS,
      'update',
      undefined,
      ITEM_ORG_WRITE(
        'POST',
        ITEMS,
        "authorizeOrgFields(tx, deps, ctx, input.adjustType === 1 ? 'create' : 'update', Object.keys(input)),",
      ),
    ),
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
    op(
      'PATCH',
      `${ITEMS}/:itemId`,
      'update',
      undefined,
      ITEM_ORG_WRITE(
        'PATCH',
        `${ITEMS}/:itemId`,
        "await authorizeOrgFields(tx, deps, ctx, row.adjustType === 1 ? 'create' : 'update', Object.keys(input));",
      ),
    ),
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
  [`GET ${BASE}`]: LIST,
  [`GET ${BASE}/:id`]: reader(`${BASE}/:id`, READER_ANCHOR),
  [`GET ${BASE}/:id/items/:section`]: reader(`${BASE}/:id/items/:section`, READER_ANCHOR),
  [`GET ${BASE}/:id/preview`]: reader(`${BASE}/:id/preview`, READER_ANCHOR),
  [`GET ${BASE}/:id/preview/export`]: reader(`${BASE}/:id/preview/export`, READER_ANCHOR),
};
