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
import { survey360 } from '@italent/domain';
import { defineTable, type RoutePolicy, type WritePolicy } from '../../route-policy/index.js';
import {
  BAD_REQUEST,
  button,
  listScope,
  noButton,
  noFields,
  none,
  noScope,
  NOT_FOUND,
  object,
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
  readonly write?: {
    readonly fields: 'body' | 'none' | 'derived';
    readonly guards?: readonly string[];
    readonly results?: boolean;
  };
  readonly guards?: readonly string[];
  readonly byId?: boolean;
}

function route(r: Route): RoutePolicy {
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
    fields: r.out === 'asIs' ? noFields('授权名单是账号信息，不是 360 对象（asIs）') : shape(`survey360.${r.key}`),
    ...(guards.length ? { guards } : {}),
    ...(writePolicy ? { write: writePolicy } : {}),
    ...(r.byId ? byId : {}),
  });
}

const RESOURCE = 'survey360.resourceGuard';
const REFS = 'survey360.payloadRefs';
const ALSO = 'survey360.alsoObjects';
const PREFLIGHT = 'survey360.preflight';

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
  'GET /people/sync-conflicts': route({ key: 'person', button: BUTTONS.sync, scope: PEOPLE }),
  'POST /people/sync': route({
    key: 'person',
    button: BUTTONS.sync,
    scope: PEOPLE,
    write: { fields: 'none', guards: [PREFLIGHT] },
  }),
  'POST /people/sync-conflicts/:id/resolve': route({
    key: 'person',
    button: BUTTONS.sync,
    scope: PEOPLE,
    write: { fields: 'none', guards: [RESOURCE, REFS, PREFLIGHT] },
    byId: true,
  }),
  // ---- people.ts ----------------------------------------------------------------------------------------------------
  'GET /people': route({ key: 'person', scope: PEOPLE }),
  'GET /people/:id': route({ key: 'person', scope: PERSON, byId: true }),
  // 关联日志属“同步人员信息”（一般管理员看不到）；看不到的人员 404，看得到但受限（精细化）403
  'GET /people/:id/link-logs': route({ key: 'person', button: BUTTONS.sync, scope: PERSON, byId: true }),
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
  }),
  'POST /activities/:id/appraisers/import': route({
    key: 'relation',
    operation: 'create',
    button: 'import',
    scope: ACTIVITY,
    write: { fields: 'derived', guards: [RESOURCE, REFS, ALSO, PREFLIGHT], results: true },
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
});

/** 链接作答 / 确认：令牌守卫在每个处理函数里（linkTenant + resolve），命令前与命令事务内各解析一次链接。 */
const TOKEN = ['survey360.linkToken'];
const linkRead = (reason: string): RoutePolicy => publicRoute(reason, 'DEC-280 / DEC-291 Q2', TOKEN);
const linkWrite = (reason: string, fields: 'body' | 'none'): RoutePolicy =>
  publicRoute(reason, 'DEC-280 / DEC-291 Q2', TOKEN, {
    write: write(
      fields === 'body' ? 'body' : none('删除评价者只给 relationId'),
      'survey360.linkResolve',
      none('链接写入的回执只含本链接可见的内容'),
      { ledger: 'single' },
    ),
  });

export const SURVEY360_LINK_POLICIES = defineTable('survey360-link', {
  'GET /': linkRead('链接主页：作答链接给任务清单、确认链接给确认单'),
  'GET /tasks/:relationId/questionnaires/:questionnaireId': linkRead('作答页：只读本链接评价者的任务（requireTask）'),
  'PUT /tasks/:relationId/questionnaires/:questionnaireId': linkWrite('保存答卷（If-Match 答卷 revision）', 'body'),
  'POST /tasks/:relationId/questionnaires/:questionnaireId/submit': linkWrite('提交答卷', 'body'),
  'GET /confirmation/candidates': linkRead('确认链接：候选评价者'),
  'POST /confirmation/appraisers': linkWrite('确认人添加评价者', 'body'),
  'DELETE /confirmation/appraisers/:relationId': linkWrite('确认人删除评价者', 'none'),
  'POST /confirmation/submit': linkWrite('确认人提交', 'body'),
});
