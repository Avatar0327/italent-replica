/**
 * 原语目录（现状必测基准的来源 (a)，F-039 PR-A §4.2 限定版）：闭包文本里出现哪些现有授权 / 过滤 / 裁剪 / 前提原语，
 * 就记为该路由对哪些权限维度敏感。目录是**评审过的人工清单**（函数名来自 §3.2 对照表与现有代码），不读声明。
 * - 多态枢纽（contracts routeContext、employment readContext、personnel access、org context …）不展开，按调用点实参匹配；
 * - `unless`：闭包里出现该片段时不算（如配置对象没有数据范围）；`writeOnly`：只对写方法有意义；
 * - `near`：在近闭包（处理函数 + 3 层调用）匹配，用于命令内前提、字段提取、范围、复核等贴近处理函数的维度，
 *   避免把业务深处共用函数里的判定算到每条路由头上；`modules`：只对这些模块的路由生效（同名函数跨模块）。
 * `name` 是写进基准的名字：守卫 / 前提用声明里要出现的名字（守卫点分名、前提为真实函数名），其他维度只记原语本身。
 */
import { TALENT_OBJECTS } from '@italent/domain';

export type Dimension =
  | 'admin'
  | 'object'
  | 'button'
  | 'scope'
  | 'scopePoint'
  | 'fieldsOut'
  | 'fieldsIn'
  | 'relation'
  | 'self'
  | 'own'
  | 'command'
  | 'postcheck'
  | 'precondition'
  | 'guard'
  | 'failureAudit'
  /** 本路由处理函数绑定的分支域（名字 = domains.ts 的域键）。 */
  | 'domain';

export interface Primitive {
  readonly dimension: Dimension;
  readonly name: string;
  readonly pattern: RegExp;
  readonly unless?: RegExp;
  readonly writeOnly?: boolean;
  readonly getOnly?: boolean;
  readonly near?: boolean;
  readonly modules?: readonly string[];
  /** 只对最终路径匹配的路由生效（同一处理函数注册到多条路径、按路径参数有无走不同分支时）。 */
  readonly paths?: RegExp;
}

const call = (fn: string) => new RegExp(`\\b${fn}\\s*\\(`);
const calls = (...fns: string[]) => new RegExp(`\\b(${fns.join('|')})\\s*\\(`);
const quoted = (text: string) => new RegExp(`['"\`]${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
/** personnel `access(c, deps, object, operation, payload, button?, …)`：按第 4 / 5 / 6 个实参判定。 */
const personnelAccess = (operations: string, withButton = false) =>
  new RegExp(
    `\\baccess\\(\\s*c,\\s*deps,\\s*[^,]+,\\s*'(${operations})'` + (withButton ? `,\\s*[^,]+,\\s*'[a-z-]+'` : ''),
  );
const CONFIG_OBJECTS = /ContractSettings|ContractRenewalRule|EmploymentSettings|EmploymentCustomField/;
/** transfer/routes.ts configurationContext：GET 查 object.view，写查 tenant.employment.configuration.write 别名。 */
const CONFIGURATION_TERNARY = /write \? 'tenant\.employment\.configuration\.write' : 'object\.view'/;
/** approval requireProcessButton(…, 'simulate' | 'simulateByObject') = requireProcessView。 */
const SIMULATE_BUTTON = /requireProcessButton\([^)]*'simulate/;

type Entry = readonly [string, RegExp, Partial<Omit<Primitive, 'dimension' | 'name' | 'pattern'>>?];
function dimension(dim: Dimension, entries: readonly Entry[]): Primitive[] {
  return entries.map(([name, pattern, extra]) => ({ dimension: dim, name, pattern, ...extra }));
}

const NEAR = { near: true } as const;
const WRITE = { writeOnly: true } as const;

export const PRIMITIVES: readonly Primitive[] = [
  ...dimension('admin', [
    ['adminGuard', /\b(guard|adminGuard|scopeAdminGuard|mouViewGuard)\(\s*c,/],
    ['admin.*', /action:\s*[`'"]admin\./],
    ['admin.* (变量)', /[`'"]admin\.\$\{/],
    ['readContext(admin.*)', /readContext\(\s*c,\s*deps,\s*'admin\./],
    ['org context(configuration)', /\bcontext\(\s*c,\s*deps,\s*'configuration'/],
    ['tenant.settings.*', quoted('tenant.settings.')],
    ['tenant.employment.configuration', quoted('tenant.employment.configuration'), WRITE],
    ['isProcessAdmin', call('isProcessAdmin')],
    // 仿真按钮 = 流程查看（管理员 或 对象查看），见 DISJUNCTIONS
    ['requireProcessButton', call('requireProcessButton'), { unless: SIMULATE_BUTTON }],
    ['auditContext', call('auditContext')],
  ]),
  ...dimension('object', [
    ['objectContext', call('objectContext')],
    // routeContext(write = true) 不查 object.view（字段权由 checkFields 逐项判定）
    ['routeContext', /\brouteContext\(\s*c,\s*deps\s*(?:,\s*[^,()]+)?\)/],
    ['readContext(object.*)', /readContext\(\s*c,\s*deps,\s*(?:'object\.|action)/],
    ['readPageContext', call('readPageContext')],
    ['personnel access', /\baccess\(\s*c,\s*deps/, { modules: ['personnel'] }],
    // 360 read() / write()：路由层 objectContext(need)（context.ts routeNeed）
    ['survey360 read/write(need)', /\b(read|write)(<[^>]*>)?\(\s*c,/, { modules: ['survey360'] }],
    ['idp part write', /\bwrite\(\s*'(templateModule|commonGoal)'/, { modules: ['idp'] }],
    ['object.* 动作', /[`'"]object\.(view|create|update|delete)\b/, { unless: CONFIGURATION_TERNARY, near: true }],
    // 字段编辑权校验（requireObjectWrite）同时判定对象的新增 / 编辑开关
    ['requireObjectWrite（对象写操作权）', call('requireObjectWrite'), { near: true, writeOnly: true }],
    // 合同 checkFields(ctx, op, fields) 经 requireObjectWrite 同时判定对象的新增 / 编辑开关（contracts/context.ts）
    [
      'contracts checkFields（对象写操作权）',
      call('checkFields'),
      { near: true, writeOnly: true, modules: ['contracts'] },
    ],
    ['managerContext（readPageContext）', call('managerContext')],
    ['configurationContext(view)', CONFIGURATION_TERNARY, { getOnly: true }],
    ['org context(read|create|update|delete)', /\bcontext\(\s*c,\s*deps,\s*'(read|create|update|delete)'/],
  ]),
  ...dimension('button', [
    ['button()', /\bbutton\(\s*(c|deps|ctx|tx)\b/, NEAR],
    ['hasButton', call('hasButton')],
    ['object.button', quoted('object.button'), NEAR],
    ['buttonResource', call('buttonResource'), NEAR],
    ['requireTransferButton', calls('requireTransferButton', 'requireTransferSource'), NEAR],
    ['requireSelfServiceSubmit', call('requireSelfServiceSubmit')],
    ['personnel access(button)', personnelAccess('view|create|update|delete', true)],
    ['adminScope(buttons)', /adminScope\([^)]*\[/],
    ['commandButton', calls('commandButton', 'requireCommandButton')],
    // 任职写权枢纽带按钮实参：requireEmploymentWrite(ctx, op, payload, 'Employment.Edit' …)（employment/context.ts）
    [
      'requireEmploymentWrite(按钮)',
      /\brequireEmploymentWrite\(\s*\w+,\s*'(?:create|update|delete)',[^;]*?,\s*'(?!TenantBase\.)[A-Z]\w*\.[A-Z]\w*'\s*[,)]/,
      { near: true, modules: ['employment'] },
    ],
    // 360 need：显式按钮，或 create / update / delete 的同名按钮（buttonOf）；SYNC / EDIT 常量同理
    ['survey360 need button', /\bbutton:\s*\S|operation:\s*'(create|update|delete)'/, { modules: ['survey360'] }],
    ['idp part write', /\bwrite\(\s*'(templateModule|commonGoal)'/, { modules: ['idp'] }],
  ]),
  ...dimension('scope', [
    ['requestScope', call('requestScope'), NEAR],
    ['scopeSql', call('scopeSql'), NEAR],
    ['visible()', /\bvisible\(/, NEAR],
    ['visibleJob', call('visibleJob'), NEAR],
    ['visibleParents', call('visibleParents'), NEAR],
    [
      'establishment visible*/check*',
      calls('visibleCapacity', 'visibleScheme', 'visibleCopyJob', 'checkCapacity', 'checkScheme'),
    ],
    ['resolveModuleScope', call('resolveModuleScope'), NEAR],
    ['adminScope', call('adminScope')],
    ['instanceScopeSql', calls('instanceScopeSql', 'memberInstanceScope')],
    ['personScope', call('personScope'), { near: true, modules: ['personnel'] }],
    ['requirePerson / preflight', calls('requirePerson', 'preflight'), { near: true, modules: ['personnel'] }],
    ['personnel access', /\baccess\(\s*c,\s*deps/, { modules: ['personnel'] }],
    ['checkScope', calls('checkScope', 'checkOperationScope'), NEAR],
    ['requireMasterScope', call('requireMasterScope'), NEAR],
    [
      'employment scope',
      calls('requireEmploymentScope', 'requireScopedEmploymentObject', 'employmentRecordVisibleTo'),
      NEAR,
    ],
    ['employment visibility', calls('visibleEmploymentRecords', 'employmentVisibilitySql'), NEAR],
    ['auditViewer', call('auditViewer')],
    ['manager team', call('inTeam'), NEAR],
    ['readContext（非配置对象）', /readContext\(\s*c,\s*deps,\s*(?:'object\.|action)/, { unless: CONFIG_OBJECTS }],
    // 目录路由只用上下文、不按范围过滤（readTransferCatalog）
    ['readPageContext', call('readPageContext'), { unless: /readTransferCatalog/ }],
    ['scope.all', /scope\??\.all\b/, NEAR],
    // 360：活动可见、评价对象 / 人员可见，与 routePeople（need 对象为 person / relation / result 时取人员范围）
    [
      'survey360 visibility',
      /\b(requireActivity|activityVisibleSql|requireVisibleObject|visiblePerson|personFilter|filterOf)\(|object:\s*'(person|relation|result)'/,
      { modules: ['survey360'] },
    ],
    ['creator scope', calls('hasCreatorScope', 'creatorSql', 'scopeAllows'), NEAR],
  ]),
  // 点校验：按单个目标（路径参数 / 请求体 / 记录属性）判定范围，范围外拒绝（与列表谓词区分，审查第 1 轮 P2-1）
  ...dimension('scopePoint', [
    // 子集列表与按员工子集列表共用处理函数：只有带 :employeeId 的路径才做 preflight（subset-routes.ts）
    [
      'requirePerson / preflight',
      calls('requirePerson', 'preflight'),
      { near: true, modules: ['personnel'], paths: /^(?!\/api\/tenant\/personnel\/subsets\/)/ },
    ],
    // 候选列表里的 visibleJob 是 assignmentReferences 守卫内部对 query 引用的校验（守卫 job.assignmentReferences 已登记）
    ['visibleJob', call('visibleJob'), { near: true, unless: /\bassignmentReferences\(/ }],
    ['employment point', calls('requireEmploymentScope', 'requireScopedEmploymentObject'), NEAR],
    ['survey360 point', calls('requireActivity', 'requireVisibleObject'), { modules: ['survey360'] }],
  ]),
  ...dimension('fieldsOut', [
    ['trimModuleResponse', call('trimModuleResponse')],
    ['trim()', /\btrim\(\s*deps/],
    ['trimWithFields / trimSubset', calls('trimWithFields', 'trimSubset', 'trimCapacities')],
    ['trimEmploymentResponse', call('trimEmploymentResponse')],
    ['trimProcess', call('trimProcess')],
    ['disclose*', /\bdisclose[A-Z]\w*\(/],
    ['visibleFields', call('visibleFields')],
    ['fixedFields', call('fixedFields')],
    ['audit views', calls('visibleChanges', 'dataChangeView', 'operationView', 'visibleTask')],
    [
      'approval views',
      calls('respondDetail', 'respondHistory', 'detailViewable', 'ownViewable', 'respondOutcome', 'processResponse'),
    ],
    ['visibleTransferForm', call('visibleTransferForm')],
    // 写入口的出口裁剪在枢纽里：org / contracts write()、employment runWrite（trimEmploymentResponse）、personnel write()
    // write(…, trim = false) 的配置写入口不裁剪（org settings）
    ['org write()', /\bwrite\(\s*c,/, { modules: ['org', 'contracts', 'personnel'], unless: /\}\),\s*false,?\s*\)/ }],
    ['employment runWrite()', call('runWrite'), { modules: ['employment', 'self-service'] }],
  ]),
  ...dimension('fieldsIn', [
    ['writeFields', call('writeFields'), NEAR],
    ['requireEmploymentWrite', call('requireEmploymentWrite'), NEAR],
    ['checkFields', call('checkFields'), NEAR],
    ['requireObjectWrite', /\brequireObjectWrite\(\s*(?![^)]*payload:\s*\{\}\s*\})/, NEAR],
    ['fieldRights', call('fieldRights'), NEAR],
    ['assertSelfServiceFields', call('assertSelfServiceFields'), NEAR],
    ['linkage write', calls('authorizeLinkageWrite', 'preauthorizeLinkage'), NEAR],
    // 空载荷 `{}` 的 update（附件登记）不提取字段
    ['personnel access(create|update)', /\baccess\(\s*c,\s*deps,\s*[^,]+,\s*'(create|update)',(?!\s*\{\s*\})/, NEAR],
    // 360 write()：fields 为 'body' 或按载荷列出（函数）时校验字段编辑权（routeFields）；'none' 不校验
    ['survey360 write(fields)', /fields:\s*(?:'body'|\()/, { near: true, writeOnly: true, modules: ['survey360'] }],
    // IDP 模板组成部分 write(object, 'create' | 'update', …)：checkWriteFields；删除不校验
    [
      'idp part write',
      /\bwrite\(\s*'(templateModule|commonGoal)',\s*'(create|update)'/,
      { writeOnly: true, modules: ['idp'] },
    ],
    ['transfer write', calls('requireTransferWrite', 'requireEmployeeTransferFields'), NEAR],
  ]),
  ...dimension('relation', [
    ['assertCanOpen', calls('assertCanOpen', 'viewerOf'), { near: true, modules: ['approval', 'contracts'] }],
    ['instanceOfTask', call('instanceOfTask'), NEAR],
    ['currentAssignee（assertOpen / openTask）', calls('assertOpen', 'openTask'), NEAR],
    ['retrievable（retrievableTask）', call('retrievableTask'), NEAR],
    // IDP 执行人：当前阶段在办待办人 + 节点按钮（plan-access.ts requireExecutor）
    ['idp executor（requireExecutor）', call('requireExecutor'), { near: true, modules: ['idp'] }],
    [
      'initiator（withdraw / resubmit right）',
      calls('requireWithdrawRight', 'requireResubmitRight', 'mayResubmit'),
      NEAR,
    ],
  ]),
  ...dimension('self', [
    ['requireSelf', call('requireSelf'), NEAR],
    ['selfAccess', call('selfAccess')],
    ['requireSelfServiceSubmit', call('requireSelfServiceSubmit')],
    ['transferFieldAccess', call('transferFieldAccess')],
  ]),
  ...dimension('own', [
    ['ownRecords / ownApplications', calls('ownRecords', 'ownApplications?', 'applicationStatus')],
    ['listTodos / listNotifications / listInstances', calls('listTodos', 'listNotifications', 'listInstances')],
    ['recipientUserId = 本人', /recipientUserId[^;]{0,60}ctx\.userId/, { getOnly: true }],
  ]),
  ...dimension('command', [
    ['runCommand / runWrite', calls('runCommand', 'runWrite', 'runPlatformCommand')],
    ['write() / command()', /\b(write|command)\(\s*c,/],
    ['adminCommand', calls('adminCommand', 'scopeAdminCommand', 'platformCommandId')],
    ['revision(c)', /\brevision\(c\)/],
    ['ifMatch / meta', calls('ifMatch', 'meta')],
    ['assertRevision', call('assertRevision')],
  ]),
  ...dimension('postcheck', [
    ['employment result', calls('authorizeEmploymentResult', 'importWithTransferAuthorization'), NEAR],
    ['establishment replay', call('authorizeEstablishmentReplay'), NEAR],
    ['job result', calls('authorizeJobResult', 'importRows'), NEAR],
    ['org result', calls('authorizeOrgResult', 'authorizeOrgImportRows'), NEAR],
    ['contracts result', calls('checkResult', 'requireMasterScope'), NEAR],
    ['discloseHandover', call('discloseHandover'), NEAR],
    ['establishment check*', calls('checkCapacity', 'checkScheme'), NEAR],
  ]),
  ...dimension('precondition', [
    ...[
      'assertOpen',
      'openTask',
      'openRun',
      'blindReview',
      'assertNotRecused',
      'assertBusinessUnchanged',
      'assertExit',
      'assertRejectEnabled',
      'assertReviewer',
      'assertNotNodeAssignee',
      'assertTargetInScope',
      'assertApprovalEdit',
      'assertNotBlindAfterEdit',
      'addSignAllowed',
      'assertAddSignType',
      'assertAddSigners',
      'retrievableTask',
      'transferBusinessContext',
      'lockEmployee',
      'ownTransferInput',
      'requireSelf',
      // 业务内的联动范围（DEC-178）、直接调动开关（transfer.direct）：留在命令内，按名字登记
    ].map((fn): Entry => [fn, call(fn), NEAR]),
  ]),
  ...dimension('guard', [
    ['employment.businessWrite', call('authorizeBusinessWrite'), NEAR],
    // DEC-178 联动范围（LINKED_RECORD_OUT_OF_SCOPE）与直接调动开关：业务深处调用，按深闭包观测
    ['employment.linkage', call('requireLinkedEmploymentRecord')],
    ['transfer.direct', calls('requireDirectTransfer', 'transferDirectActions')],
    ['linkage.preauthorize', call('preauthorizeLinkage'), NEAR],
    [
      'employment.importTransferAccess',
      call('importWithTransferAuthorization'),
      { near: true, modules: ['employment'] },
    ],
    ['transfer.source', calls('requireTransferSource', 'requireManagerBusinessSource'), NEAR],
    ['transfer.managerIdentity', call('managerContext')],
    ['linkage.source', call('requireLinkageSource'), NEAR],
    ['linkage.retry', call('authorizeRetry'), NEAR],
    ['approval.withdrawRight', call('requireWithdrawRight'), NEAR],
    // 管理员转交 / 改派目标须在操作人对业务对象的管理范围内（F-067；routes.ts 解析范围，actions.ts assertTargetInScope 判断）
    ['approval.adminTargetScope', call('adminTargetScope'), NEAR],
    ['approval.resubmitRight', calls('requireResubmitRight', 'mayResubmit'), NEAR],
    ['personnel.selfServiceFields', call('assertSelfServiceFields'), { near: true, modules: ['personnel'] }],
    ['personnel.viewableFilters', call('listOptions'), { near: true, modules: ['personnel'] }],
    ['contracts.importScope', calls('authorizeImport', 'checkImportScope'), { near: true, modules: ['contracts'] }],
    [
      'contracts.importInitializeDelete',
      /initialize[\s\S]{0,300}object\.delete|object\.delete[\s\S]{0,300}initialize/,
      { modules: ['contracts'] },
    ],
    ['permission.grantScopesRequireOtherSettings', /scopes[\s\S]{0,160}other_settings/, { modules: ['permission'] }],
    ['permission.personLinksReadOnly', /\bUSER_BINDING_BY_PROFILE\b/],
    ['survey360.unrestricted', call('requireUnrestricted'), { modules: ['survey360'] }],
    // 导入评价者选“同步”（body.sync === true）时才要员工信息查看权与范围（relations.ts preflight）
    ['survey360.syncEmployees', /if \(body\?\.sync === true\) await routeEmployeeScope\(/, { modules: ['survey360'] }],
    // IDP 模板引用流程：流程查看权 + 流程范围（routes.ts processScopeFor）；新建计划所选模板须可见（plan-routes.ts templateCheck）
    ['idp.processReference', call('processScopeFor'), { modules: ['idp'] }],
    ['idp.templateVisible', call('templateCheck'), { modules: ['idp'] }],
    // IDP 转交目标须是已绑定员工且在操作人 IDP 范围内（intervention-service.ts requireTargetInScope，F-066）
    ['idp.transferTarget', call('requireTargetInScope'), { modules: ['idp'] }],
    // 人才盘点准备度：按 enabled 筛选须有该字段查看权；名称实际变化要求看全部（R3-T04 路由声明）
    ['talentReview.filterFieldVisible', call('requireFilterVisible'), { modules: ['talent-review'] }],
    ['talentReview.renameRequiresSeeAll', /\bREADINESS_NAME_REQUIRES_SEE_ALL\b/, { modules: ['talent-review'] }],
    // 人才评定配置字典：按 enabled 筛选须有该字段查看权；只有创建人范围的人改名被拒（R3-T02 B1a 路由声明）
    ['ev.filterFieldVisible', call('requireFilterVisible'), { modules: ['evaluation'] }],
    ['ev.nameRequiresSeeAll', /\bACTIVITY_TYPE_NAME_REQUIRES_SEE_ALL\b/, { modules: ['evaluation'] }],
    ['selfService.transferInput', call('ownTransferInput'), { modules: ['self-service'] }],
    ['selfService.referenceChoices', call('referenceChoices'), { modules: ['self-service'] }],
    ['selfService.ownApplication', call('ownApplication'), { modules: ['self-service'] }],
    ['org.visibleParents', call('visibleParents'), { near: true, modules: ['org'] }],
    ['job.assignmentReferences', call('assignmentReferences'), { near: true, modules: ['job'] }],
    ['job.employmentScope', call('authorizeSequenceTargets'), { modules: ['job'] }],
  ]),
  ...dimension('failureAudit', [['withFailedImportLog', call('withFailedImportLog'), NEAR]]),
  // 分支域绑定：处理函数按哪个有限域分派（声明的选择器键必须等于本路由绑定的域，不能借别的模块同形的域）
  ...dimension('domain', [
    ['job.kind', /\bJOB_KINDS\b|\bJOB_OBJECT_CODES\b|\bobjectKind\(/, { modules: ['job'] }],
    ['import.rowOperation', /'update'\s*:\s*'create'/, { modules: ['org', 'job'] }],
    ['personnel.subset', /\bsubsetKind\(|\bSUBSETS\[/, { modules: ['personnel'] }],
    ['approval.taskObject', call('fieldRights'), { modules: ['approval'] }],
    ['transfer.initiator', /\binitiator\b/, { modules: ['employment'] }],
    ['employment.importRowOperation', /operation === 'edit'/, { modules: ['employment'] }],
    ['contracts.operation', /\bcontractAction\(|\bCONTRACT_FLOW\b/, { modules: ['contracts'] }],
    ['contracts.commandButton', /\bcontractAction\(|\bCONTRACT_FLOW\b/, { modules: ['contracts'] }],
    ['contracts.importMode', /'initialize'/, { modules: ['contracts'] }],
    ['contracts.todoAction', /'decline'/, { modules: ['contracts'] }],
    ['talent.object', /\bforms\[object/, { modules: ['talent'] }],
    ['talent.formOperation', /operation !== 'create' && operation !== 'update'/, { modules: ['talent'] }],
    ['talent.ownerUnitObject', call('ownerObject'), { modules: ['talent'] }],
    ['qualification.ownerUnitObject', call('ownerObject'), { modules: ['qualification'] }],
  ]),
];

/**
 * “或”关系原语：现状代码里的准入是几条路径之一成立即可。基准记为 `or` 维度（名字），比较器要求声明的每个备选
 * 至少满足其中一支；`absorbs` 里的维度只经这类原语观测到（如 HR 分支里解析查看权与范围但不拒绝），不再作必备维度。
 * 分支义务可以是维度名，也可以是对象 × 数据操作 `obj:<编码 | *>:<操作>`（* = 任一对象）；`absorbs` 里的 `obj:` 项
 * 是原语内部的对象判定事实（objects.ts），同样不再作必备事实。原语按调用点登记。
 */
export type Obligation = Dimension | `obj:${string}`;
export interface Disjunction {
  readonly name: string;
  readonly pattern: RegExp;
  readonly modules: readonly string[];
  readonly branches: readonly (readonly Obligation[])[];
  readonly absorbs: readonly Obligation[];
}

/** 人才标准对象编码（talent/access.ts codeOf）。 */
const CRITERION = TALENT_OBJECTS.criterion.code;

export const DISJUNCTIONS: readonly Disjunction[] = [
  {
    // approval/access.ts requireProcessView：isProcessAdmin 或 object.view 流程对象；仿真按钮同此
    name: 'approval.requireProcessView',
    pattern: new RegExp(`\\brequireProcessView\\(|${SIMULATE_BUTTON.source}`),
    modules: ['approval'],
    branches: [['admin'], ['object']],
    absorbs: ['admin', 'object'],
  },
  {
    // idp/plan-access.ts requireViewer：HR（计划查看权且员工在范围内）或 参与人（本人 / 指导人 / 当前待办人），都不是 404
    name: 'idp.requireViewer',
    pattern: call('requireViewer'),
    modules: ['idp'],
    branches: [['object', 'scope'], ['relation']],
    absorbs: ['object', 'scope'],
  },
  {
    // idp/plan-access.ts requireExecutor：（参与人 或 HR 看得到）且 当前阶段在办待办人 且 节点按钮——关系必备，
    // HR 范围的解析只用于“看得到”判断，不单独拒绝
    name: 'idp.requireExecutor',
    pattern: call('requireExecutor'),
    modules: ['idp'],
    branches: [['relation']],
    absorbs: ['object', 'scope'],
  },
  {
    // talent/candidates.ts candidateContext：所选对象的新建权；人才标准另接受 编辑数据操作权 + 编辑按钮（DEC-316③）
    name: 'talent.candidateContext',
    pattern: call('candidateContext'),
    modules: ['talent'],
    branches: [['obj:*:create'], [`obj:${CRITERION}:update`, 'button']],
    absorbs: ['button', `obj:${CRITERION}:update`],
  },
];

/** 目录里能观测到的守卫名（声明里出现这些名字时按双向比较）。 */
export const KNOWN_GUARDS: ReadonlySet<string> = new Set(
  PRIMITIVES.filter((p) => p.dimension === 'guard').map((p) => p.name),
);

/** 写方法才有意义的维度（GET 处理函数不提字段、不跑命令）；基准生成时按方法过滤。 */
export const WRITE_ONLY_DIMENSIONS: ReadonlySet<Dimension> = new Set([
  'fieldsIn',
  'command',
  'postcheck',
  'precondition',
]);

export interface Closures {
  /** 处理函数 + 6 层调用展开。 */
  readonly deep: string;
  /** 处理函数 + 3 层调用展开。 */
  readonly near: string;
}

/** 对闭包文本匹配目录，得到 维度 → 命中的名字（排序去重）。 */
export function scanPrimitives(
  closures: Closures,
  method: string,
  module: string,
  routePath = '',
): Record<string, string[]> {
  const deep = closures.deep.replace(/\s+/g, ' '); // 跨行调用（`write(\n  c,`）也按单行匹配
  const near = closures.near.replace(/\s+/g, ' ');
  const found: Record<string, Set<string>> = {};
  for (const primitive of PRIMITIVES) {
    if (method === 'GET' && (WRITE_ONLY_DIMENSIONS.has(primitive.dimension) || primitive.writeOnly)) continue;
    if (method !== 'GET' && primitive.getOnly) continue;
    if (primitive.modules && !primitive.modules.includes(module)) continue;
    if (primitive.paths && !primitive.paths.test(routePath)) continue;
    const text = primitive.near ? near : deep;
    if (!primitive.pattern.test(text)) continue;
    if (primitive.unless?.test(text)) continue;
    (found[primitive.dimension] ??= new Set()).add(primitive.name);
  }
  for (const or of DISJUNCTIONS) {
    if (or.modules.includes(module) && or.pattern.test(deep)) (found['or'] ??= new Set()).add(or.name);
  }
  return Object.fromEntries(
    Object.entries(found)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dim, names]) => [dim, [...names].sort()]),
  );
}
