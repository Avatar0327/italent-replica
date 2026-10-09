/**
 * 360 度评估路由的现状声明（F-039 PR-A；R3-T03 / #107 已合并代码，处理函数不变）。两个子应用：
 * - 管理端 /api/tenant/survey360（40 条）：每条路由经 context.ts 的 read() / write()，声明的对象 / 操作 / 按钮
 *   与代码里的 `need` 一一对应（按钮缺省 = 对象目录里与数据操作同名的按钮，查看不要按钮，buttonOf）；
 *   命令前与命令事务内各判一次（authorizeInTransaction），返回前按请求人当时的字段权限裁剪（trimAs）。
 * - 链接作答 / 确认 /api/survey360/link（8 条）：不经租户成员中间件，外部评价者凭 x-tenant-id + x-survey360-token
 *   访问（DEC-280、DEC-291 Q2：kind public + 令牌守卫）；令牌不对 / 链接失效 / 租户停用一律 404。
 * 数据范围：活动按 activityVisibleSql（全部活动按钮 ∪ 本人创建 ∪ 被授权，不可见 = 404）；人员 / 评价关系 / 结果
 * 另按（用户 × Survey360）人员范围（routePeople，精细化权限开启时生效，DEC-280⑤、DEC-289①）。
 */
import { PERSONNEL_OBJECT, survey360 } from '@italent/domain';
import { defineTable, type RoutePolicy, type WritePolicy } from '../../route-policy/index.js';
import {
  all,
  BAD_REQUEST,
  button,
  fixed,
  listScope,
  noButton,
  noFields,
  none,
  noScope,
  NOT_FOUND,
  object,
  own,
  pointScope,
  publicRoute,
  shape,
  write,
} from '../../route-policy/presets.js';

type Key = keyof typeof survey360.SURVEY360_OBJECTS;
type Operation = 'view' | 'create' | 'update' | 'delete';
const OBJECTS = survey360.SURVEY360_OBJECTS;
const BUTTONS = survey360.SURVEY360_BUTTONS;

/** 与 context.ts buttonOf 同一规则：显式按钮，或对象目录里与数据操作同名的按钮；查看不要按钮。 */
function buttonFor(key: Key, operation: Operation, explicit?: string) {
  const buttons = OBJECTS[key].buttons as readonly { code: string; level: 'list' | 'detail' }[];
  const code = explicit ?? (operation === 'view' ? undefined : operation);
  const found = code === undefined ? undefined : buttons.find((b) => b.code === code);
  return found ? button(found.code, found.level) : noButton(`${key} 的 ${operation} 不要按钮（buttonOf）`);
}

/** `survey360 uuidParam`：路径标识非 UUID → 400 VALIDATION_FAILED。 */
const byId = { invalidId: BAD_REQUEST };
const ACTIVITY = pointScope({ param: 'id' }, 'survey360.activity.byId', NOT_FOUND);
const ACTIVITY_OBJECT = pointScope({ param: 'objectId' }, 'survey360.object.byId', NOT_FOUND);
const PEOPLE = listScope('survey360.personScope');
const PERSON = pointScope({ param: 'id' }, 'survey360.person.byId', NOT_FOUND);

interface Route {
  readonly key: Key;
  readonly operation?: Operation;
  readonly button?: string;
  readonly scope?: ReturnType<typeof listScope>;
  readonly out?: 'asIs';
  /** 回执只有人数与原站提示（协议字段，asIs），不含对象字段（PR-B）。 */
  readonly receipt?: string;
  readonly write?: {
    readonly fields: 'body' | 'none' | 'derived';
    readonly guards?: readonly string[];
    readonly results?: boolean;
  };
  readonly guards?: readonly string[];
  readonly byId?: boolean;
  /** 另要员工信息查看权与其范围（sync.ts routeEmployeeScope：objectContext(PERSONNEL_OBJECT, 'view')）。 */
  readonly employees?: boolean;
}

/** 同步 / 自动带出 / 导入评价者按员工信息范围取人：员工信息查看权（无 → 403）+ 当前员工信息范围。 */
const EMPLOYEE_VIEW = object({
  object: PERSONNEL_OBJECT,
  operation: 'view',
  button: noButton('routeEmployeeScope 只查员工信息的查看权'),
  scope: listScope('survey360.employeeScope'),
  fields: noFields('只取范围，出口在 360 对象分支登记'),
});

function route(r: Route): RoutePolicy {
  if (r.employees) {
    const { employees: _employees, ...rest } = r;
    const main = route(rest);
    const { write: writePolicy, invalidId, ...admission } = main;
    return all([admission as RoutePolicy, EMPLOYEE_VIEW], 'fields' in main ? main.fields : noFields('无'), {
      ...(writePolicy ? { write: writePolicy } : {}),
      ...(invalidId ? { invalidId } : {}),
    });
  }
  const operation = r.operation ?? 'view';
  const guards = [...(r.guards ?? []), ...(r.write?.guards ?? [])];
  let writePolicy: WritePolicy | undefined;
  if (r.write) {
    const fields =
      r.write.fields === 'body'
        ? ('body' as const)
        : r.write.fields === 'derived'
          ? { guard: 'survey360.writeFields' }
          : none('状态流转 / 授权名单 / 同步参数，不写对象字段（fields: none）');
    writePolicy = write(
      fields,
      'survey360.commandAuthorize',
      r.write.results ? 'survey360.resultRefs' : none('返回前只按当前字段权限裁剪（present）'),
      { ledger: 'single' },
    );
  }
  return object({
    object: OBJECTS[r.key].code,
    operation,
    button: buttonFor(r.key, operation, r.button),
    scope: r.scope ?? noScope(`${r.key} 不按数据范围过滤（套卷 / 设置 / 角色为租户级配置）`),
    fields: r.receipt
      ? noFields(r.receipt)
      : r.out === 'asIs'
        ? noFields('授权名单是账号信息，不是 360 对象（asIs）')
        : shape(`survey360.${r.key}`),
    ...(guards.length ? { guards } : {}),
    ...(writePolicy ? { write: writePolicy } : {}),
    ...(r.byId ? byId : {}),
  });
}

const RESOURCE = 'survey360.resourceGuard';
const REFS = 'survey360.payloadRefs';
const ALSO = 'survey360.alsoObjects';
const PREFLIGHT = 'survey360.preflight';
/** 同步冲突与人员关联日志只给不受限的管理员（people.ts requireUnrestricted）。 */
const UNRESTRICTED = 'survey360.unrestricted';
/** 导入评价者 body.sync === true 时：员工信息查看权 + 当前员工信息范围（relations.ts preflight → routeEmployeeScope）。 */
const SYNC_EMPLOYEES = 'survey360.syncEmployees';

/** 转发与转发预览另要对报告正文涉及的全部结果字段有查看权（reports.ts requireFullReportView，第 2 轮 P2-5）。 */
const FULL_REPORT = 'survey360.fullReportView';
/** 我的待办：只看 user_id = 当前账号的待办（todos.ts）。 */
const TODO_RECIPIENT = 'survey360.todoRecipient';
const TODO_KEYS = ['id', 'activityId', 'title', 'content', 'status', 'sentAt', 'doneAt'];
/** 待办“去处理”：本人账号的待办 → 该评价者当前有效的作答链接（todos.ts todoEntry），别人的待办与不存在同一 404。 */
const todoOwn = (extra: { write?: WritePolicy } = {}): RoutePolicy =>
  own({
    predicate: TODO_RECIPIENT,
    target: { param: 'todoId' },
    locator: 'survey360.todo.mine',
    denied: NOT_FOUND,
    fields: noFields('作答视图与链接作答相同：只含本评价者自己的任务与答卷'),
    ...byId,
    ...extra,
  });
const todoWrite = () =>
  todoOwn({
    write: write('body', 'survey360.linkResolve', none('作答写入的回执只含本评价者可见的内容'), { ledger: 'single' }),
  });
/** 报告转发的收件人链接令牌（reports.ts registerReportLinkRoutes resolve + linkOf）。 */
const REPORT_LINK_TOKEN = 'survey360.reportLinkToken';

export const SURVEY360_POLICIES = defineTable('survey360', {
  // ---- settings.ts ------------------------------------------------------------------------------------------------
  'GET /settings': route({ key: 'settings' }),
  'PUT /settings': route({
    key: 'settings',
    operation: 'update',
    button: BUTTONS.finePermission,
    write: { fields: 'body' },
  }),
  'GET /roles': route({ key: 'settings' }),
  'POST /roles': route({ key: 'settings', operation: 'create', write: { fields: 'body' } }),
  'PUT /roles/:id': route({ key: 'settings', operation: 'update', write: { fields: 'body' }, byId: true }),
  // ---- sync.ts：从系统管理中同步人员信息（sync@list）----------------------------------------------------------------
  // 精细化下受限管理员 403 FINE_PERMISSION_RESTRICTED（people.ts requireUnrestricted，第 6 轮 R5-P2-1）；
  // 冲突清单在事务内经 syncAccess 取员工信息范围，无员工信息查看权 403 NO_EMPLOYEE_ACCESS（F-039 第 4 轮补登）
  'GET /people/sync-conflicts': route({
    key: 'person',
    button: BUTTONS.sync,
    scope: PEOPLE,
    guards: [UNRESTRICTED],
    employees: true,
  }),
  'POST /people/sync': route({
    key: 'person',
    button: BUTTONS.sync,
    scope: PEOPLE,
    write: { fields: 'none', guards: [PREFLIGHT] },
    employees: true,
  }),
  'POST /people/sync-conflicts/:id/resolve': route({
    key: 'person',
    button: BUTTONS.sync,
    scope: PEOPLE,
    write: { fields: 'none', guards: [RESOURCE, REFS, PREFLIGHT, UNRESTRICTED] },
    byId: true,
    employees: true,
  }),
  // ---- people.ts ----------------------------------------------------------------------------------------------------
  'GET /people': route({ key: 'person', scope: PEOPLE }),
  'GET /people/:id': route({ key: 'person', scope: PERSON, byId: true }),
  // 关联日志属“同步人员信息”（一般管理员看不到）；看不到的人员 404，看得到但受限（精细化）403
  'GET /people/:id/link-logs': route({
    key: 'person',
    button: BUTTONS.sync,
    scope: PERSON,
    guards: [UNRESTRICTED],
    byId: true,
  }),
  'POST /people': route({
    key: 'person',
    operation: 'create',
    scope: PEOPLE,
    write: { fields: 'body', guards: [RESOURCE, REFS] },
  }),
  'PUT /people/:id': route({
    key: 'person',
    operation: 'update',
    scope: PERSON,
    write: { fields: 'body', guards: [RESOURCE, REFS] },
    byId: true,
  }),
  // ---- questionnaires.ts：改他人创建的套卷另需 editOthers（guard）--------------------------------------------------
  'GET /questionnaires': route({ key: 'questionnaire' }),
  'GET /questionnaires/:id': route({ key: 'questionnaire', byId: true }),
  'POST /questionnaires': route({ key: 'questionnaire', operation: 'create', write: { fields: 'body' } }),
  'PUT /questionnaires/:id': route({
    key: 'questionnaire',
    operation: 'update',
    write: { fields: 'derived', guards: [RESOURCE] },
    byId: true,
  }),
  'POST /questionnaires/:id/enable': route({
    key: 'questionnaire',
    operation: 'update',
    button: 'enable',
    write: { fields: 'none', guards: [RESOURCE] },
    byId: true,
  }),
  'DELETE /questionnaires/:id': route({
    key: 'questionnaire',
    operation: 'delete',
    write: { fields: 'none', guards: [RESOURCE] },
    byId: true,
  }),
  // ---- activities.ts ------------------------------------------------------------------------------------------------
  'GET /activities': route({ key: 'activity', scope: listScope('survey360.activityVisible') }),
  'GET /activities/:id': route({ key: 'activity', scope: ACTIVITY, byId: true }),
  'POST /activities': route({ key: 'activity', operation: 'create', write: { fields: 'body' } }),
  'PUT /activities/:id': route({
    key: 'activity',
    operation: 'update',
    scope: ACTIVITY,
    write: { fields: 'body', guards: [RESOURCE] },
    byId: true,
  }),
  'DELETE /activities/:id': route({
    key: 'activity',
    operation: 'delete',
    scope: ACTIVITY,
    write: { fields: 'none', guards: [RESOURCE] },
    byId: true,
  }),
  'POST /activities/:id/enable': route({
    key: 'activity',
    operation: 'update',
    button: 'enable',
    scope: ACTIVITY,
    write: { fields: 'none', guards: [RESOURCE] },
    byId: true,
  }),
  'POST /activities/:id/disable': route({
    key: 'activity',
    operation: 'update',
    button: 'disable',
    scope: ACTIVITY,
    write: { fields: 'none', guards: [RESOURCE] },
    byId: true,
  }),
  'GET /activities/:id/objects/:objectId/scores': route({ key: 'result', scope: ACTIVITY_OBJECT, byId: true }),
  'GET /activities/:id/grants': route({ key: 'activity', scope: ACTIVITY, out: 'asIs', byId: true }),
  'POST /activities/:id/grants': route({
    key: 'activity',
    operation: 'update',
    scope: ACTIVITY,
    out: 'asIs',
    write: { fields: 'none', guards: [RESOURCE] },
    byId: true,
  }),
  'DELETE /activities/:id/grants/:userId': route({
    key: 'activity',
    operation: 'update',
    scope: ACTIVITY,
    out: 'asIs',
    write: { fields: 'none', guards: [RESOURCE] },
    byId: true,
  }),
  // ---- relations.ts：评价对象、评价者、导入、确认邀请（人员范围 + 活动可见）------------------------------------------
  'GET /activities/:id/objects': route({ key: 'relation', scope: ACTIVITY, byId: true }),
  'POST /activities/:id/objects': route({
    key: 'relation',
    operation: 'create',
    scope: ACTIVITY,
    write: { fields: 'body', guards: [RESOURCE, REFS, ALSO], results: true },
    byId: true,
  }),
  'PUT /activities/:id/objects/:objectId/questionnaires': route({
    key: 'relation',
    operation: 'update',
    scope: ACTIVITY_OBJECT,
    write: { fields: 'body', guards: [RESOURCE] },
    byId: true,
  }),
  'DELETE /activities/:id/objects/:objectId': route({
    key: 'relation',
    operation: 'delete',
    scope: ACTIVITY_OBJECT,
    write: { fields: 'none', guards: [RESOURCE] },
    byId: true,
  }),
  'GET /activities/:id/objects/:objectId/appraisers': route({ key: 'relation', scope: ACTIVITY_OBJECT, byId: true }),
  'POST /activities/:id/objects/:objectId/appraisers': route({
    key: 'relation',
    operation: 'create',
    scope: ACTIVITY_OBJECT,
    write: { fields: 'derived', guards: [RESOURCE, REFS, ALSO], results: true },
    byId: true,
  }),
  'DELETE /activities/:id/objects/:objectId/appraisers/:relationId': route({
    key: 'relation',
    operation: 'delete',
    scope: ACTIVITY_OBJECT,
    write: { fields: 'none', guards: [RESOURCE] },
    byId: true,
  }),
  'POST /activities/:id/objects/:objectId/appraisers/auto': route({
    key: 'relation',
    operation: 'create',
    button: 'autoAdd',
    scope: ACTIVITY_OBJECT,
    write: { fields: 'derived', guards: [RESOURCE, ALSO, PREFLIGHT] },
    byId: true,
    employees: true,
  }),
  'POST /activities/:id/appraisers/import': route({
    key: 'relation',
    operation: 'create',
    button: 'import',
    scope: ACTIVITY,
    // 选“同步”（body.sync === true）时才另要员工信息查看权与范围：条件准入登记为守卫（审查第 2 轮 P3-1）
    write: { fields: 'derived', guards: [RESOURCE, REFS, ALSO, PREFLIGHT, SYNC_EMPLOYEES], results: true },
    byId: true,
  }),
  'POST /activities/:id/objects/:objectId/confirmation': route({
    key: 'relation',
    operation: 'update',
    button: 'invite',
    scope: ACTIVITY_OBJECT,
    write: { fields: 'derived', guards: [RESOURCE] },
    byId: true,
  }),
  // ---- PR-B（docs/08_设计/R3-T03_360度评估PR-B_路由声明.md）----------------------------------------------------------
  // progress.ts：进程控制按评价关系查看；重新作答是答卷的 reanswer 按钮
  'GET /activities/:id/progress': route({ key: 'relation', scope: ACTIVITY, byId: true }),
  'GET /activities/:id/progress/:personId': route({ key: 'relation', scope: ACTIVITY, byId: true }),
  'POST /activities/:id/relations/:relationId/reanswer': route({
    key: 'answer',
    operation: 'update',
    button: 'reanswer',
    scope: ACTIVITY,
    write: { fields: 'none', guards: [RESOURCE] },
    byId: true,
  }),
  // todos.ts：发送 / 取消待办、邮件邀请是评价关系的 invite 按钮，回执只有人数
  ...Object.fromEntries(
    ['/todos', '/todos/cancel', '/invitations'].map((path) => [
      `POST /activities/:id${path}`,
      route({
        key: 'relation',
        operation: 'update',
        button: 'invite',
        scope: ACTIVITY,
        receipt: '回执只有人数与原站提示（asIs）',
        write: { fields: 'none', guards: [RESOURCE] },
        byId: true,
      }),
    ]),
  ),
  // 我的待办：只要租户成员身份，只看本人账号的待办（固定键）
  'GET /my/todos': own({
    predicate: TODO_RECIPIENT,
    fields: fixed(TODO_KEYS, 'R3-T03 PR-B 路由声明：我的待办固定键'),
  }),
  // 待办“去处理”：本人账号的待办 → 该评价者当前有效的作答链接，判定与链接作答相同（answering.ts todoEntry）
  // 作答页（匿名开关按活动设置）
  'GET /my/todos/:todoId/answer': todoOwn(),
  // 作答页人员头像：只给本单人员集合的当前头像字节
  'GET /my/todos/:todoId/avatars/:attachmentId/content': todoOwn(),
  // 作答页：本评价者的任务
  'GET /my/todos/:todoId/tasks/:relationId/questionnaires/:questionnaireId': todoOwn(),
  // 保存答卷
  'PUT /my/todos/:todoId/tasks/:relationId/questionnaires/:questionnaireId': todoWrite(),
  // 提交答卷
  'POST /my/todos/:todoId/tasks/:relationId/questionnaires/:questionnaireId/submit': todoWrite(),
  // sheets.ts：原始数据按答卷查看；屏蔽 / 取消屏蔽 / 屏蔽疑似 / 恢复是答卷的 block 按钮
  'GET /activities/:id/sheets': route({ key: 'answer', scope: ACTIVITY, byId: true }),
  ...Object.fromEntries(
    ['block', 'unblock'].map((action) => [
      `POST /activities/:id/sheets/:sheetId/${action}`,
      route({
        key: 'answer',
        operation: 'update',
        button: 'block',
        scope: ACTIVITY,
        write: { fields: 'none', guards: [RESOURCE] },
        byId: true,
      }),
    ]),
  ),
  ...Object.fromEntries(
    ['block-suspected', 'unblock-all'].map((path) => [
      `POST /activities/:id/sheets/${path}`,
      route({
        key: 'answer',
        operation: 'update',
        button: 'block',
        scope: ACTIVITY,
        receipt: '回执只有人数（asIs）',
        write: { fields: 'none', guards: [RESOURCE] },
        byId: true,
      }),
    ]),
  ),
  // reports.ts：报告模板是设置对象；报告、报表是结果对象；生成 / 转发是结果的按钮，转发另要报告正文完整查看权
  'GET /report-template': route({ key: 'settings' }),
  'PUT /report-template': route({ key: 'settings', operation: 'update', write: { fields: 'body' } }),
  'GET /activities/:id/reports': route({ key: 'result', scope: ACTIVITY, byId: true }),
  'GET /activities/:id/reports/:reportId': route({ key: 'result', scope: ACTIVITY, byId: true }),
  'POST /activities/:id/reports/generate': route({
    key: 'result',
    operation: 'update',
    button: 'generateReport',
    scope: ACTIVITY,
    receipt: '回执只有人数（asIs）',
    write: { fields: 'none', guards: [RESOURCE] },
    byId: true,
  }),
  // 预览是 POST 的只读接口（read()）：不开命令事务、不进台账
  'POST /activities/:id/reports/forward/preview': {
    ...route({ key: 'result', button: 'forwardReport', scope: ACTIVITY, guards: [FULL_REPORT], byId: true }),
    write: write(
      none('只读预览：载荷是收件人选择，不写对象字段'),
      none('只读预览：不开命令事务、不写入'),
      none('只读预览：预览行按结果字段裁剪'),
    ),
  },
  'POST /activities/:id/reports/forward': route({
    key: 'result',
    operation: 'update',
    button: 'forwardReport',
    scope: ACTIVITY,
    receipt: '回执只有人数（asIs）',
    write: { fields: 'none', guards: [RESOURCE, FULL_REPORT] },
    byId: true,
  }),
  // tables.ts
  'GET /activities/:id/score-tables': route({ key: 'result', scope: ACTIVITY, byId: true }),
  // questionnaires.ts：套卷模板与套卷同表同结构，模板入口只取模板（改 / 删他人模板同样要 editOthers）
  'GET /questionnaire-templates': route({ key: 'questionnaire' }),
  'GET /questionnaire-templates/:id': route({ key: 'questionnaire', byId: true }),
  'POST /questionnaire-templates': route({ key: 'questionnaire', operation: 'create', write: { fields: 'body' } }),
  'PUT /questionnaire-templates/:id': route({
    key: 'questionnaire',
    operation: 'update',
    write: { fields: 'derived', guards: [RESOURCE] },
    byId: true,
  }),
  'DELETE /questionnaire-templates/:id': route({
    key: 'questionnaire',
    operation: 'delete',
    write: { fields: 'none', guards: [RESOURCE] },
    byId: true,
  }),
  'POST /questionnaires/:id/save-as-template': route({
    key: 'questionnaire',
    operation: 'create',
    write: { fields: 'derived', guards: [RESOURCE] },
    byId: true,
  }),
  'POST /questionnaire-templates/:id/instantiate': route({
    key: 'questionnaire',
    operation: 'create',
    write: { fields: 'derived', guards: [RESOURCE] },
    byId: true,
  }),
});

/** 报告转发的收件人链接：令牌守卫在每个处理函数里（resolve + linkOf），报告须在链接的报告清单里。 */
export const SURVEY360_REPORT_LINK_POLICIES = defineTable('survey360-report-link', {
  'GET /': publicRoute('收件人链接主页：本链接的报告清单', 'DEC-280 同口径（R3-T03 PR-B）', [REPORT_LINK_TOKEN]),
  'GET /reports/:reportId': publicRoute(
    '收件人查看报告：报告须在本链接的清单里',
    'DEC-280 同口径（R3-T03 PR-B）',
    [REPORT_LINK_TOKEN],
    byId,
  ),
});

/** 链接作答 / 确认：令牌守卫在每个处理函数里（linkTenant + resolve），命令前与命令事务内各解析一次链接。 */
const TOKEN = ['survey360.linkToken'];
/** 带 :relationId / :questionnaireId 的入口：answering.ts uuidParam，非 UUID → 400 VALIDATION_FAILED（审查第 1 轮 P3-1）。 */
const linkRead = (reason: string, extra: { invalidId?: typeof BAD_REQUEST } = {}): RoutePolicy =>
  publicRoute(reason, 'DEC-280 / DEC-291 Q2', TOKEN, extra);
const linkWrite = (reason: string, fields: 'body' | 'none', extra: { invalidId?: typeof BAD_REQUEST } = {}) =>
  publicRoute(reason, 'DEC-280 / DEC-291 Q2', TOKEN, {
    ...extra,
    write: write(
      fields === 'body' ? 'body' : none('删除评价者只给 relationId'),
      'survey360.linkResolve',
      none('链接写入的回执只含本链接可见的内容'),
      { ledger: 'single' },
    ),
  });

export const SURVEY360_LINK_POLICIES = defineTable('survey360-link', {
  'GET /': linkRead('链接主页：作答链接给任务清单、确认链接给确认单'),
  'GET /tasks/:relationId/questionnaires/:questionnaireId': linkRead(
    '作答页：只读本链接评价者的任务（requireTask）',
    byId,
  ),
  'PUT /tasks/:relationId/questionnaires/:questionnaireId': linkWrite(
    '保存答卷（If-Match 答卷 revision）',
    'body',
    byId,
  ),
  'POST /tasks/:relationId/questionnaires/:questionnaireId/submit': linkWrite('提交答卷', 'body', byId),
  'GET /confirmation/candidates': linkRead('确认链接：候选评价者'),
  // F-058：本单人员集合（avatarPersonIds：作答任务 / 确认页的评价对象与评价者）里的当前有效头像；集合外、
  // 非 UUID、不存在一律 404（linkRead 内 notFound）
  'GET /avatars/:attachmentId/content': linkRead('作答 / 确认页人员头像：只给本单人员集合的当前头像字节'),
  'POST /confirmation/appraisers': linkWrite('确认人添加评价者', 'body'),
  'DELETE /confirmation/appraisers/:relationId': linkWrite('确认人删除评价者', 'none', byId),
  'POST /confirmation/submit': linkWrite('确认人提交', 'body'),
});
