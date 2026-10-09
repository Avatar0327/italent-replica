/**
 * 原语目录（现状必测基准的来源 (a)，F-039 PR-A §4.2 限定版）：闭包文本里出现哪些现有授权 / 过滤 / 裁剪 / 前提原语，
 * 就记为该路由对哪些权限维度敏感。目录是**评审过的人工清单**（函数名来自 §3.2 对照表与现有代码），不读声明。
 * - 多态枢纽（contracts routeContext、employment readContext、personnel access、org context …）不展开，按调用点实参匹配；
 * - `unless`：闭包里出现该片段时不算（如配置对象没有数据范围）；`writeOnly`：只对写方法有意义；
 * - `near`：在近闭包（处理函数 + 3 层调用）匹配，用于命令内前提、字段提取、范围、复核等贴近处理函数的维度，
 *   避免把业务深处共用函数里的判定算到每条路由头上；`modules`：只对这些模块的路由生效（同名函数跨模块）。
 * `name` 是写进基准的名字：守卫 / 前提用声明里要出现的名字（守卫点分名、前提为真实函数名），其他维度只记原语本身。
 */
export type Dimension =
  | 'admin'
  | 'object'
  | 'button'
  | 'scope'
  | 'fieldsOut'
  | 'fieldsIn'
  | 'relation'
  | 'self'
  | 'own'
  | 'command'
  | 'postcheck'
  | 'precondition'
  | 'guard'
  | 'failureAudit';

export interface Primitive {
  readonly dimension: Dimension;
  readonly name: string;
  readonly pattern: RegExp;
  readonly unless?: RegExp;
  readonly writeOnly?: boolean;
  readonly getOnly?: boolean;
  readonly near?: boolean;
  readonly modules?: readonly string[];
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
    ['requireProcessView', call('requireProcessView')],
    ['requireProcessButton', call('requireProcessButton')],
    ['auditContext', call('auditContext')],
  ]),
  ...dimension('object', [
    ['objectContext', call('objectContext')],
    // routeContext(write = true) 不查 object.view（字段权由 checkFields 逐项判定）
    ['routeContext', /\brouteContext\(\s*c,\s*deps\s*(?:,\s*[^,()]+)?\)/],
    ['readContext(object.*)', /readContext\(\s*c,\s*deps,\s*(?:'object\.|action)/],
    ['readPageContext', call('readPageContext')],
    ['personnel access', /\baccess\(\s*c,\s*deps/, { modules: ['personnel'] }],
    ['requireProcessView', call('requireProcessView')],
    // 360 read() / write()：路由层 objectContext(need)（context.ts routeNeed）
    ['survey360 read/write(need)', /\b(read|write)(<[^>]*>)?\(\s*c,/, { modules: ['survey360'] }],
    ['idp part write', /\bwrite\(\s*'(templateModule|commonGoal)'/, { modules: ['idp'] }],
    ['object.* 动作', /[`'"]object\.(view|create|update|delete)\b/, { unless: CONFIGURATION_TERNARY, near: true }],
    // 字段编辑权校验（requireObjectWrite）同时判定对象的新增 / 编辑开关
    ['requireObjectWrite（对象写操作权）', call('requireObjectWrite'), { near: true, writeOnly: true }],
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
      'assertNotSelf',
      'assertBusinessUnchanged',
      'assertExit',
      'assertRejectEnabled',
      'assertReviewer',
      'assertNotNodeAssignee',
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
    ['selfService.transferInput', call('ownTransferInput'), { modules: ['self-service'] }],
    ['selfService.referenceChoices', call('referenceChoices'), { modules: ['self-service'] }],
    ['selfService.ownApplication', call('ownApplication'), { modules: ['self-service'] }],
    ['org.visibleParents', call('visibleParents'), { near: true, modules: ['org'] }],
    ['job.assignmentReferences', call('assignmentReferences'), { near: true, modules: ['job'] }],
    ['job.employmentScope', call('authorizeSequenceTargets'), { modules: ['job'] }],
  ]),
  ...dimension('failureAudit', [['withFailedImportLog', call('withFailedImportLog'), NEAR]]),
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
export function scanPrimitives(closures: Closures, method: string, module: string): Record<string, string[]> {
  const deep = closures.deep.replace(/\s+/g, ' '); // 跨行调用（`write(\n  c,`）也按单行匹配
  const near = closures.near.replace(/\s+/g, ' ');
  const found: Record<string, Set<string>> = {};
  for (const primitive of PRIMITIVES) {
    if (method === 'GET' && (WRITE_ONLY_DIMENSIONS.has(primitive.dimension) || primitive.writeOnly)) continue;
    if (method !== 'GET' && primitive.getOnly) continue;
    if (primitive.modules && !primitive.modules.includes(module)) continue;
    const text = primitive.near ? near : deep;
    if (!primitive.pattern.test(text)) continue;
    if (primitive.unless?.test(text)) continue;
    (found[primitive.dimension] ??= new Set()).add(primitive.name);
  }
  return Object.fromEntries(
    Object.entries(found)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dim, names]) => [dim, [...names].sort()]),
  );
}
