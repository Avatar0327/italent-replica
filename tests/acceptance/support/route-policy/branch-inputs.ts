/**
 * 动态选择器的输入来源表（F-039 PR-B2，设计 B-07）：`端点 → [{ 位置, 域, from, path, at }]`，只放字面量。
 * 比较器（compare.ts compareSelectors）要求声明里每个 `map` 型选择器都有一条登记，并核对五元组：
 * 端点 + 位置（节点路径 + 字段）+ 输入来源（from / path）+ 域 + 映射值（domains.ts BRANCH_VALUES）。
 * 同一个域在不同端点可以有不同来源（职务 `:kind` 是路径参数，导入是 `body.kind`），所以按端点登记。
 * 每条登记的 `at` 指向处理函数里实际取值处：call = 路由处理函数（或它调用的校验函数）里读到该值的那一句，
 * impl = 取值 / 校验的实现（如 `c.req.param('kind')`、zod 枚举）。输入来源的真实性（取值位置换了资源是否随之变）
 * 由 PR-B4b 的 P4 动态核对；这里的锚点只证明“源码里确有这一句”，语义由逐条审定（见 PR 评论的审定台账）。
 * `variant` 选择分支值表里同一（域, 字段）的多个条目之一（任职导入预览与导入的逐行操作值不同）。
 */
import type { Evidence } from './required/types.js';

export interface BranchInput {
  /** 选择器位置：节点路径 + 字段，如 `of[0].object`、`rows.operation`、`failureAudit.objectType`。 */
  readonly position: string;
  /** 域名（domains.ts 的域键）。 */
  readonly domain: string;
  readonly from: 'param' | 'body' | 'query';
  readonly path: string;
  /** 分支值表里的条目变体（缺省 = 该域该字段的唯一条目）。 */
  readonly variant?: string;
  readonly at: readonly Evidence[];
}

const SRC = 'apps/api/src/modules';
const call = (unit: string, anchor: string): Evidence => ({ role: 'call', unit, anchor });
const impl = (unit: string, anchor: string): Evidence => ({ role: 'impl', unit, anchor });
const input = (
  position: string,
  domain: string,
  from: BranchInput['from'],
  path: string,
  at: readonly Evidence[],
  variant?: string,
): BranchInput => {
  return { position, domain, from, path, ...(variant ? { variant } : {}), at };
};

// ---- 职务（job/routes.ts）：`:kind` 经 objectKind 取路径参数并校验；导入取 body.kind ---------------------------------
const JOB = `${SRC}/job/routes.ts`;
const jobKind = (method: string, path: string): BranchInput[] => [
  input('object', 'job.kind', 'param', 'kind', [
    call(`${JOB}#route:${method} /api/tenant/job${path}`, 'const kind = objectKind(c)'),
    impl(`${JOB}#objectKind`, "c.req.param('kind')"),
  ]),
];
const JOB_IMPORT = `${JOB}#route:POST /api/tenant/job/import`;

// ---- 人员子集（personnel/subset-routes.ts）：subsetKind(c.req.param('kind')) -----------------------------------------
const SUBSET_FILE = `${SRC}/personnel/subset-routes.ts`;
const PERSONNEL = '/api/tenant/personnel';
const subsetKind = (method: string, path: string, position = 'object'): BranchInput[] => [
  input(position, 'personnel.subset', 'param', 'kind', [
    call(`${SUBSET_FILE}#route:${method} ${PERSONNEL}${path}`, "const kind = subsetKind(c.req.param('kind') ?? '')"),
    impl(`${SRC}/personnel/validation.ts#subsetKind`, 'Object.hasOwn(SUBSETS, value)'),
  ]),
];
const SUBSET = '/employees/:employeeId/subsets/:kind';

// ---- 任职导入（employment/routes.ts + forward-import.ts）：items[*].operation ∈ create / edit -------------------------
const EMPLOYMENT = `${SRC}/employment/routes.ts`;
const IMPORT_SCHEMA = impl(`${SRC}/employment/forward-import.ts#schema`, "z.discriminatedUnion('operation', [");

// ---- 合同（contracts/routes.ts、todos.ts、input.ts、imports.ts） ----------------------------------------------------
const CONTRACTS = `${SRC}/contracts/routes.ts`;
const COMMAND_SCHEMA = impl(
  `${SRC}/contracts/input.ts#commandSchema`,
  "operation: z.enum(['create', 'renew', 'change', 'terminate'])",
);
const IMPORT_MODE = impl(
  `${SRC}/contracts/imports.ts#importSchema`,
  "mode: z.enum(['add', 'edit', 'change', 'initialize'])",
);
const importMode = (path: string, anchor: string): BranchInput[] => [
  input('rows.operation', 'contracts.importMode', 'body', 'mode', [
    call(`${CONTRACTS}#route:POST ${path}`, anchor),
    call(`${CONTRACTS}#authorizeImport`, "['edit', 'change'].includes(input.mode) ? 'update' : 'create'"),
    IMPORT_MODE,
  ]),
];
const TODOS = `${SRC}/contracts/todos.ts#registerMergedTodos`;
const TODO_ACTION = impl(TODOS, "action: z.enum(['approve', 'decline', 'reject', 'resubmit'])");
const TODO_BRANCH = call(TODOS, "if (input.action === 'resubmit') await requireResubmitRight(deps, ctx, instanceId)");

// ---- 人才标准（talent/routes.ts、form-access.ts、candidates.ts） -----------------------------------------------------
const TALENT_ROUTES = `${SRC}/talent/routes.ts#registerTalentRoutes`;
const FORM_OBJECT = [
  call(TALENT_ROUTES, "const object = c.req.param('object')"),
  impl(TALENT_ROUTES, "if (!Object.hasOwn(forms, object)) throw new AppError('VALIDATION_FAILED', '表单对象不合法')"),
];
const FORM_OPERATION = [
  call(`${SRC}/talent/form-access.ts#talentFormHandler`, "const operation = c.req.query('operation')"),
  impl(`${SRC}/talent/form-access.ts#talentFormHandler`, "if (operation !== 'create' && operation !== 'update')"),
];

export const BRANCH_INPUTS: Readonly<Record<string, readonly BranchInput[]>> = {
  'POST /api/tenant/job/import': [
    input('object', 'job.kind', 'body', 'kind', [
      call(`${JOB}#importJobRows`, 'const objectCode = JOB_OBJECT_CODES[input.kind]'),
      impl(`${JOB}#importJobRows`, 'kind: z.enum(JOB_KINDS)'),
    ]),
    input('failureAudit.objectType', 'job.kind', 'body', 'kind', [
      call(JOB_IMPORT, "objectType: known ?? 'job'"),
      impl(JOB_IMPORT, 'const kind = (raw as { kind?: unknown } | undefined)?.kind'),
    ]),
  ],
  'GET /api/tenant/job/:kind': jobKind('GET', '/:kind'),
  'GET /api/tenant/job/:kind/:id': jobKind('GET', '/:kind/:id'),
  'POST /api/tenant/job/:kind': jobKind('POST', '/:kind'),
  'PATCH /api/tenant/job/:kind/:id': jobKind('PATCH', '/:kind/:id'),

  'POST /api/tenant/employment/employees/:id/import/forward-update-preview': [
    input(
      'rows.operation',
      'employment.importRowOperation',
      'body',
      'items[*].operation',
      [
        call(
          `${EMPLOYMENT}#route:POST /employees/:id/import/forward-update-preview`,
          'const input = normalizeEmploymentImport(await jsonBody(c))',
        ),
        call(
          `${EMPLOYMENT}#authorizeImport`,
          "if (!preview) await requireEmploymentWrite(ctx, 'create', item.business as object",
        ),
        IMPORT_SCHEMA,
      ],
      'preview',
    ),
  ],
  'POST /api/tenant/employment/employees/:id/import': [
    input(
      'rows.operation',
      'employment.importRowOperation',
      'body',
      'items[*].operation',
      [
        call(`${EMPLOYMENT}#importEmployment`, 'const input = normalizeEmploymentImport(raw)'),
        call(
          `${EMPLOYMENT}#authorizeImport`,
          "if (!preview) await requireEmploymentWrite(ctx, 'update', patch, 'Employment.Edit')",
        ),
        IMPORT_SCHEMA,
      ],
      'import',
    ),
    input('rows.button', 'employment.importRowOperation', 'body', 'items[*].operation', [
      call(
        `${EMPLOYMENT}#authorizeImport`,
        "requireEmploymentWrite(ctx, 'create', item.business as object, 'Employment.Create')",
      ),
      call(`${EMPLOYMENT}#authorizeImport`, "requireEmploymentWrite(ctx, 'update', patch, 'Employment.Edit')"),
      IMPORT_SCHEMA,
    ]),
  ],

  [`GET ${PERSONNEL}${SUBSET}`]: [
    ...subsetKind('GET', SUBSET, 'of[0].object'),
    ...subsetKind('GET', SUBSET, 'of[1].object'),
  ],
  [`GET ${PERSONNEL}/subsets/:kind`]: subsetKind('GET', '/subsets/:kind'),
  [`GET ${PERSONNEL}${SUBSET}/:id`]: subsetKind('GET', `${SUBSET}/:id`),
  [`GET ${PERSONNEL}${SUBSET}/:id/history`]: subsetKind('GET', `${SUBSET}/:id/history`),
  [`POST ${PERSONNEL}${SUBSET}`]: subsetKind('POST', SUBSET),
  [`PATCH ${PERSONNEL}${SUBSET}/:id`]: subsetKind('PATCH', `${SUBSET}/:id`),
  [`DELETE ${PERSONNEL}${SUBSET}/:id`]: subsetKind('DELETE', `${SUBSET}/:id`),

  'POST /api/tenant/contracts/commands': [
    input('operation', 'contracts.operation', 'body', 'operation', [
      call(`${CONTRACTS}#route:POST /commands`, 'const input = parse(commandSchema, await jsonBody(c))'),
      COMMAND_SCHEMA,
    ]),
  ],
  'POST /api/tenant/contracts/batch': [
    input('operation', 'contracts.operation', 'body', 'items[*].command.operation', [
      call(`${CONTRACTS}#route:POST /batch`, 'command: commandSchema'),
      COMMAND_SCHEMA,
    ]),
    input('rows.operation', 'contracts.operation', 'body', 'items[*].command.operation', [
      call(`${CONTRACTS}#route:POST /batch`, "row.command.operation === 'create' ? 'create' : 'update'"),
      COMMAND_SCHEMA,
    ]),
  ],
  'POST /api/tenant/contracts/imports': importMode('/imports', 'const input = await authorizeImport(deps, ctx, raw)'),
  'POST /api/tenant/contracts/imports/preview': importMode(
    '/imports/preview',
    'if (suffix) return importPreview(c, deps, ctx, raw, suffix)',
  ),
  'POST /api/tenant/contracts/imports/errors': importMode(
    '/imports/errors',
    'if (suffix) return importPreview(c, deps, ctx, raw, suffix)',
  ),
  'POST /api/tenant/contracts/todos/batch': [
    input('relation', 'contracts.todoAction', 'body', 'action', [TODO_BRANCH, TODO_ACTION]),
    input('rows.relation', 'contracts.todoAction', 'body', 'action', [TODO_BRANCH, TODO_ACTION]),
  ],

  'GET /api/tenant/talent/candidates/owner-orgs': [
    input('of[0].object', 'talent.ownerUnitObject', 'query', 'object', [
      call(`${SRC}/talent/candidates.ts#registerCandidates`, 'const object = ownerObject(c)'),
      impl(`${SRC}/talent/candidates.ts#ownerObject`, "c.req.query('object')"),
    ]),
  ],
  'GET /api/tenant/qualification/candidates/owner-orgs': [
    input('object', 'qualification.ownerUnitObject', 'query', 'object', [
      call(`${SRC}/qualification/candidates.ts#registerQualificationCandidates`, 'const object = ownerObject(c)'),
      impl(`${SRC}/qualification/candidates.ts#ownerObject`, "c.req.query('object')"),
    ]),
  ],
  'GET /api/tenant/talent/forms/:object': [
    input('of[0].object', 'talent.object', 'param', 'object', FORM_OBJECT),
    input('of[0].operation', 'talent.formOperation', 'query', 'operation', FORM_OPERATION),
    input('of[0].button', 'talent.formOperation', 'query', 'operation', FORM_OPERATION),
    input('of[1].object', 'talent.object', 'param', 'object', FORM_OBJECT),
  ],
};
