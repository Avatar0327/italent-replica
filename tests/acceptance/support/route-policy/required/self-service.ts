/**
 * 必需项表：员工自助（modules/employee-self-service/，子应用挂在 /api/tenant/self-service）。
 * 七条都先经 selfAccess：boundEmployee 未绑定员工 → 403；事务内 self.check 复核绑定。调动两条另经
 * ownTransferInput（selfService.transferInput：调动日期可见可编辑、requireTransferWrite 按叠加授权器逐字段判 create）、
 * requireTransferSource（Transfer.Self 按钮 + 绑定本人 + 源范围）。Transfer.Self 按“员工”身份里的按钮配置放行（C1-2b，DEC-402②，
 * 管理员可关闭）；三个本人调动按钮另由前提 requireSelfServiceButtons 统一校验（预览事务第一步 / 提交的 CommandGuard.before），
 * Employment.Create / Employment.Submit 没有单独的 button(...) 观测，按前提原语登记。
 * transfer.direct 守卫只在 mode = direct（requireDirectTransfer）或
 * initiator = hr（预览 allowedActions）时求值，本人入口固定 application / employee，恒不触发——按代码路径上的具名守卫登记。
 */
import type { Evidence, Obligation, RequiredTable } from './types.js';

const ROUTES = 'apps/api/src/modules/employee-self-service/routes.ts';
const ACCESS = 'apps/api/src/modules/employee-self-service/access.ts';
const TRANSFER = 'apps/api/src/modules/employee-self-service/transfer.ts';
const SERVICE = 'apps/api/src/modules/transfer/service.ts';
const TRANSFER_ACCESS = 'apps/api/src/modules/transfer/access.ts';
const route = (method: string, path: string, anchor: string) =>
  ({ role: 'call', unit: `${ROUTES}#route:${method} ${path}`, anchor }) as const;
const BOUND = [
  { role: 'impl', unit: `${ACCESS}#selfAccess`, anchor: 'boundEmployee(tx, tenant)' },
  {
    role: 'impl',
    unit: `${ACCESS}#boundEmployee`,
    anchor: "if (!employee) throw new AppError('FORBIDDEN', '当前用户未绑定员工')",
  },
] as const;
const self = (
  method: string,
  path: string,
  facts: readonly string[],
  anchor = 'const self = await selfAccess(c, deps)',
): Obligation => ({
  perm: 'self',
  facts,
  at: [route(method, path, anchor), ...BOUND],
});
const TRANSFER_INPUT_IMPL = {
  role: 'impl',
  unit: `${TRANSFER}#ownTransferInput`,
  anchor: "throw new AppError('SELF_TRANSFER_DATE_UNAVAILABLE'",
} as const;
const SOURCE_IMPL = [
  {
    role: 'impl',
    unit: `${TRANSFER_ACCESS}#requireTransferSource`,
    anchor: "throw new AppError('FORBIDDEN', '只能为绑定的本人发起调动')",
  },
  {
    role: 'impl',
    unit: `${TRANSFER_ACCESS}#requireTransferButton`,
    anchor: "buttonResource(EMPLOYMENT_OBJECT, ROLE_BUTTONS[initiator], 'detail')",
  },
  { role: 'const', unit: `${TRANSFER_ACCESS}#ROLE_BUTTONS`, anchor: "employee: 'Transfer.Self'" },
  {
    role: 'const',
    unit: 'apps/api/src/modules/employment/context.ts#EMPLOYMENT_OBJECT',
    anchor: "'TenantBase.EmploymentRecord'",
  },
] as const;
const DIRECT_IMPL = [
  {
    role: 'impl',
    unit: `${SERVICE}#requireDirectTransfer`,
    anchor: "throw new AppError('FORBIDDEN', '无权发起直接调动')",
  },
  { role: 'impl', unit: `${TRANSFER_ACCESS}#transferDirectActions`, anchor: "action: 'object.button'" },
] as const;
const CREATE_WRITE = [
  {
    role: 'impl',
    unit: `${SERVICE}#requireTransferWrite`,
    anchor: "await requireEmploymentWrite(ctx, 'create', input.writable)",
  },
  {
    role: 'impl',
    unit: 'apps/api/src/modules/employment/context.ts#requireEmploymentWrite',
    anchor: 'await requireObjectWrite(ctx.authorize, ctx, { objectCode, operation, payload: actual })',
  },
] as const;
const SELF_FACTS = ['self:selfAccess', 'self:transferFieldAccess'];
const DEV_CHANNEL = 'apps/api/src/modules/employee-self-service/development-channel.ts';
const PAGE_PERMISSION = 'apps/api/src/modules/employee-self-service/page-permission.ts';
/** 员工发展通道页面权限（C1-6）：缺权 403 PAGE_PERMISSION_REQUIRED；判定为员工身份 ∪ 用户自己的身份（F-087 经理自动身份）。 */
const developmentChannelPage = (entry: Evidence): Obligation[] => [
  {
    perm: 'btn:self#EmployeeDevelopmentChannel@app_page',
    // 判定里用请求的授权器问 Qualification.Pages 的页面按钮（buttonResource + object.button）
    facts: ['button:buttonResource', 'button:object.button'],
    at: [
      entry,
      {
        role: 'impl',
        unit: `${PAGE_PERMISSION}#employeePageGranted`,
        anchor: "resource: buttonResource(QUALIFICATION_PAGES.code, page, 'app_page')",
      },
      {
        role: 'const',
        unit: 'packages/domain/src/qualification/catalog.ts#QUALIFICATION_PAGES',
        anchor: 'code: `${QUALIFICATION_APP}.Pages`',
      },
    ],
  },
  {
    perm: 'guard:selfService.developmentChannelPage',
    facts: ['guard:selfService.developmentChannelPage'],
    at: [
      entry,
      {
        role: 'impl',
        unit: `${DEV_CHANNEL}#ownDevelopmentChannel`,
        anchor: "reason: 'PAGE_PERMISSION_REQUIRED'",
      },
      {
        role: 'impl',
        unit: `${PAGE_PERMISSION}#employeePageGranted`,
        anchor: 'if (!carrier || has(carrier.buttons)) return true',
      },
    ],
  },
];
/** 三个本人调动按钮的检查实现（C1-2b，契约 §2.3.2）：预览与提交各有一个调用点，同一个检查函数。 */
const BUTTONS_IMPL = {
  role: 'impl',
  unit: `${ACCESS}#requireSelfServiceButtons`,
  anchor: "reason: 'SELF_TRANSFER_BUTTON_DENIED'",
} as const;
const PREVIEW_BUTTONS_CALL = {
  role: 'impl',
  unit: `${TRANSFER}#ownTransferPreview`,
  anchor: 'await requireSelfServiceButtons(tx, ctx)',
} as const;
const SUBMIT_BUTTONS_GUARD = [
  { role: 'call', unit: `${ROUTES}#route:POST /transfer`, anchor: '{ guard: selfTransferGuard(self) }' },
  {
    role: 'impl',
    unit: `${ROUTES}#selfTransferGuard`,
    anchor: 'before: (tx) => requireSelfServiceButtons(tx, self.ctx)',
  },
] as const;

export const SELF_SERVICE: RequiredTable = {
  'GET /api/tenant/self-service/profile': [self('GET', '/profile', ['self:selfAccess'])],
  'GET /api/tenant/self-service/employees/:id/records': [
    {
      ...self('GET', '/employees/:id/records', ['self:selfAccess', 'own:ownRecords / ownApplications']),
      note: '另有 :id 必须是绑定本人（否则 403「只能查看本人任职记录」）',
      at: [
        route(
          'GET',
          '/employees/:id/records',
          "if (uuidParam(c) !== self.employee.id) throw new AppError('FORBIDDEN', '只能查看本人任职记录')",
        ),
        ...BOUND,
      ],
    },
  ],
  'POST /api/tenant/self-service/transfer/preview': [
    self('POST', '/transfer/preview', SELF_FACTS),
    {
      perm: 'btn:self#Transfer.Self@detail',
      facts: ['button:requireTransferButton'],
      at: [
        route('POST', '/transfer/preview', 'ownTransferPreview(tx, self.ctx, self.employee.id, raw, deps)'),
        PREVIEW_BUTTONS_CALL,
        BUTTONS_IMPL,
        ...SOURCE_IMPL,
      ],
    },
    {
      perm: 'guard:transfer.source',
      facts: ['guard:transfer.source'],
      at: [
        route('POST', '/transfer/preview', 'ownTransferPreview(tx, self.ctx, self.employee.id, raw, deps)'),
        {
          role: 'impl',
          unit: 'apps/api/src/modules/transfer/preview.ts#previewTransfer',
          anchor: 'await requireTransferSource(tx, ctx, employeeId, input.initiator)',
        },
        ...SOURCE_IMPL,
      ],
    },
    {
      perm: 'guard:transfer.direct',
      facts: ['guard:transfer.direct'],
      note: '预览只把 transferDirectActions 的结果放进 allowedActions，且仅 initiator = hr 求值；本人入口恒不触发',
      at: [
        route('POST', '/transfer/preview', 'ownTransferPreview(tx, self.ctx, self.employee.id, raw, deps)'),
        {
          role: 'impl',
          unit: 'apps/api/src/modules/transfer/preview.ts#previewTransfer',
          anchor: "transferDirectActions(accessContext, input.initiator === 'hr' && settings.allowDirectTransfer)",
        },
        DIRECT_IMPL[1],
      ],
    },
    {
      perm: 'guard:selfService.transferInput',
      facts: ['guard:selfService.transferInput'],
      at: [
        route('POST', '/transfer/preview', 'ownTransferPreview(tx, self.ctx, self.employee.id, raw, deps)'),
        {
          role: 'impl',
          unit: `${TRANSFER}#ownTransferPreview`,
          anchor: 'const input = await ownTransferInput(tx, ctx, raw, originalDeps)',
        },
        TRANSFER_INPUT_IMPL,
      ],
    },
    {
      perm: 'obj:TenantBase.EmploymentRecord:create',
      purpose: 'guard:selfService.transferInput',
      inner: { role: 'required' },
      facts: ['object:object.* 动作'],
      at: [
        route('POST', '/transfer/preview', 'ownTransferPreview(tx, self.ctx, self.employee.id, raw, deps)'),
        {
          role: 'impl',
          unit: `${TRANSFER}#ownTransferInput`,
          anchor: "action: 'object.create', resource: EMPLOYMENT_OBJECT, fields: ['effectiveDate']",
        },
        { role: 'impl', unit: `${TRANSFER}#ownTransferInput`, anchor: 'await requireTransferWrite(' },
        ...CREATE_WRITE,
      ],
    },
  ],
  'GET /api/tenant/self-service/transfer/references/:code': [
    self('GET', '/transfer/references/:code', SELF_FACTS),
    {
      perm: 'guard:selfService.referenceChoices',
      facts: ['guard:selfService.referenceChoices'],
      at: [
        route('GET', '/transfer/references/:code', 'return referenceChoices('),
        {
          role: 'impl',
          unit: 'apps/api/src/modules/employee-self-service/references.ts#referenceChoices',
          anchor:
            "if (!(await transferFieldAccess(tx, deps, ctx)).has(code)) throw new AppError('FORBIDDEN', '无权查看此字段')",
        },
      ],
    },
  ],
  'POST /api/tenant/self-service/transfer': [
    self('POST', '/transfer', SELF_FACTS, 'const self = await selfAccess(c, deps, revision(c))'),
    {
      perm: 'btn:self#Transfer.Self@detail',
      facts: ['button:requireTransferButton', 'button:buttonResource', 'button:object.button'],
      at: [
        route('POST', '/transfer', 'createTransfer(tx, ctx, self.employee.id, input)'),
        ...SUBMIT_BUTTONS_GUARD,
        BUTTONS_IMPL,
        {
          role: 'impl',
          unit: `${SERVICE}#transferTargetContext`,
          anchor: 'await requireTransferSource(tx, ctx, employeeId, input.initiator)',
        },
        ...SOURCE_IMPL,
      ],
    },
    {
      perm: 'guard:transfer.source',
      facts: ['guard:transfer.source'],
      at: [
        route('POST', '/transfer', 'createTransfer(tx, ctx, self.employee.id, input)'),
        {
          role: 'impl',
          unit: `${SERVICE}#createTransfer`,
          anchor:
            'ctx = await transferTargetContext(tx, sourceContext, employeeId, input, prepared.fields.departmentId)',
        },
        {
          role: 'impl',
          unit: `${SERVICE}#transferTargetContext`,
          anchor: 'await requireTransferSource(tx, ctx, employeeId, input.initiator)',
        },
        ...SOURCE_IMPL,
      ],
    },
    {
      perm: 'guard:transfer.direct',
      facts: ['guard:transfer.direct'],
      note: '只在 mode = direct 时 requireDirectTransfer；本人入口固定 application，恒不触发',
      at: [
        route('POST', '/transfer', 'createTransfer(tx, ctx, self.employee.id, input)'),
        {
          role: 'impl',
          unit: `${SERVICE}#createTransfer`,
          anchor: "if (input.employment.mode === 'direct') await requireDirectTransfer(tx, ctx)",
        },
        ...DIRECT_IMPL,
      ],
    },
    {
      perm: 'guard:employment.linkage',
      facts: ['guard:employment.linkage'],
      note: 'DEC-178 联动改写后续记录前（createEmploymentBusiness 之后的向后更新等）调用',
      at: [
        route('POST', '/transfer', 'createTransfer(tx, ctx, self.employee.id, input)'),
        {
          role: 'impl',
          unit: 'apps/api/src/modules/employment/context.ts#requireLinkedEmploymentRecord',
          anchor: "throw new AppError('LINKED_RECORD_OUT_OF_SCOPE'",
        },
      ],
    },
    {
      perm: 'guard:selfService.transferInput',
      facts: ['guard:selfService.transferInput'],
      at: [route('POST', '/transfer', 'const input = await ownTransferInput(tx, ctx, raw, deps)'), TRANSFER_INPUT_IMPL],
    },
    {
      perm: 'obj:TenantBase.EmploymentRecord:create',
      purpose: 'guard:selfService.transferInput',
      inner: { role: 'required' },
      facts: ['object:object.* 动作', 'object:requireObjectWrite（对象写操作权）'],
      at: [
        route('POST', '/transfer', 'const input = await ownTransferInput(tx, ctx, raw, deps)'),
        { role: 'impl', unit: `${TRANSFER}#ownTransferInput`, anchor: 'await requireTransferWrite(' },
        { role: 'impl', unit: `${SERVICE}#createTransfer`, anchor: 'await requireTransferWrite(ctx, input)' },
        ...CREATE_WRITE,
      ],
    },
  ],
  // 员工通道卡片（C1-6）：本人 + 员工发展通道页面权限；页面判定 employeePageGranted 在 ownDevelopmentChannel 内
  'GET /api/tenant/self-service/development-channel': [
    self('GET', '/development-channel', ['self:selfAccess']),
    ...developmentChannelPage(route('GET', '/development-channel', 'return c.json(await card(self))')),
  ],
  'GET /api/tenant/self-service/employees/:id/development-channel': [
    {
      ...self('GET', '/employees/:id/development-channel', ['self:selfAccess']),
      note: '另有 :id 必须是绑定本人（否则 403「只能查看本人发展通道」）',
      at: [
        route(
          'GET',
          '/employees/:id/development-channel',
          "if (uuidParam(c) !== self.employee.id) throw new AppError('FORBIDDEN', '只能查看本人发展通道')",
        ),
        ...BOUND,
      ],
    },
    ...developmentChannelPage(route('GET', '/employees/:id/development-channel', 'return c.json(await card(self))')),
  ],
  'GET /api/tenant/self-service/applications': [
    self('GET', '/applications', ['self:selfAccess', 'self:transferFieldAccess', 'own:ownRecords / ownApplications']),
  ],
  'GET /api/tenant/self-service/applications/:id': [
    self('GET', '/applications/:id', ['self:selfAccess', 'own:ownRecords / ownApplications']),
    {
      perm: 'guard:selfService.ownApplication',
      facts: ['guard:selfService.ownApplication'],
      at: [
        route('GET', '/applications/:id', 'const item = await ownApplication(tx, self.ctx, self.employee.id, id)'),
        {
          role: 'impl',
          unit: 'apps/api/src/modules/employee-self-service/queries.ts#ownApplication',
          anchor: "if (!row) throw new AppError('NOT_FOUND', '申请不存在')",
        },
        {
          role: 'impl',
          unit: 'apps/api/src/modules/employee-self-service/queries.ts#ownApplications',
          anchor: 'AND i.initiator_user_id=',
        },
      ],
    },
  ],
};
