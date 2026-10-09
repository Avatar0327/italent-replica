/**
 * 个人发展计划（IDP）路由的现状声明（F-039 PR-A；R3-T07 / #111、#115 已合并代码，处理函数不变），共 56 条：
 * - 配置（routes.ts）：流程 / 子流程候选审批流程 / 模板（复制、发布、取消发布）/ 模板模块 / 模板通用目标——
 *   idpContext / idpWriteContext（数据操作权 + 写入口按钮，命令台账之前，重放同样复核）+ checkWriteFields（逐字段编辑权，
 *   含显式清空）；范围按所属组织（visible / scopeSql，应用 IDP，DEC-043），向下公开只读（403 IDP_PUBLIC_DOWN_READONLY）；
 *   命令事务内 recheck（currentEditable / stillVisible），响应逐层按字段权限裁剪。
 * - 计划（plan-routes.ts）：HR 按（用户 × IDP）范围；参与人（本人 / 指导人 / 当前待办人）按参与关系；执行写入
 *   （目标 / 任务 / 回顾 / 模块内容）要求当前阶段在办待办人且模块在该节点配置了按钮（requireExecutor，DEC-296④），
 *   看不到计划 404、节点无按钮 403 IDP_NODE_BUTTON_DENIED；HR 不经节点按钮不能改（K-49）。
 * - 关键信息（key-info-routes.ts）：带教 / 职业发展 / 轮岗按员工归属（registerPersonScopedObject，K-50）。
 */
import { IDP_OBJECTS } from '@italent/domain';
import { defineTable, type RoutePolicy } from '../../route-policy/index.js';
import {
  any,
  BAD_REQUEST,
  button,
  denied,
  fixed,
  guardScope,
  listScope,
  noButton,
  none,
  noScope,
  NOT_FOUND,
  object,
  own,
  pointScope,
  projector,
  relation,
  write,
} from '../../route-policy/presets.js';

const BASE = '/api/tenant/idp';
type Key = keyof typeof IDP_OBJECTS;
const code = (key: Key) => IDP_OBJECTS[key].code;
/** `idp uuidParam`：路径标识非 UUID → 400 VALIDATION_FAILED。 */
const byId = { invalidId: BAD_REQUEST };
const out = (key: Key) => projector(`idp.${key}`, `idp.${key}`);
const ORG_LIST = (key: Key) => listScope(`idp.orgScope(${key})`);
const ORG_POINT = (key: Key, param = 'id') => pointScope({ param }, `idp.${key}.byId`, NOT_FOUND);
const PLAN_LIST = listScope('idp.planScope');
const PLAN_POINT = pointScope({ param: 'id' }, 'idp.plan.byId', NOT_FOUND);
const NODE_DENIED = denied(403, 'FORBIDDEN', 'IDP_NODE_BUTTON_DENIED');

function idpWrite(fields: 'body' | 'none', result: string, extra: { preconditions?: readonly string[] } = {}) {
  return write(fields === 'body' ? 'body' : none('删除 / 状态流转不写对象字段'), 'idp.commandRecheck', result, {
    ledger: 'single',
    ...extra,
  });
}

type Operation = 'create' | 'update' | 'delete';
interface Writer {
  readonly key: Key;
  readonly operation: Operation;
  readonly button: string;
  readonly level: 'list' | 'detail';
  readonly scope: ReturnType<typeof listScope>;
  readonly fields: 'body' | 'none';
  readonly result: string;
  readonly guards?: readonly string[];
  readonly outKey?: Key;
  readonly byId?: boolean;
  readonly preconditions?: readonly string[];
}
function writer(w: Writer): RoutePolicy {
  return object({
    object: code(w.key),
    operation: w.operation,
    button: button(w.button, w.level),
    scope: w.scope,
    fields: out(w.outKey ?? w.key),
    ...(w.guards?.length ? { guards: w.guards } : {}),
    ...(w.byId ? byId : {}),
    write: idpWrite(w.fields, w.result, w.preconditions ? { preconditions: w.preconditions } : {}),
  });
}
function reader(key: Key, scope: ReturnType<typeof listScope>, extra: { byId?: boolean; outKey?: Key } = {}) {
  return object({
    object: code(key),
    operation: 'view',
    button: noButton('查看按对象查看权'),
    scope,
    fields: out(extra.outKey ?? key),
    ...(extra.byId ? byId : {}),
  });
}

/** 配置对象（流程 / 模板）的标准五条；写入口 currentEditable 复核（向下公开只读 403）。 */
function configCrud(key: 'process' | 'template', path: string, guards: readonly string[] = []) {
  const editable = `idp.currentEditable(${key})`;
  return {
    [`GET ${path}`]: reader(key, ORG_LIST(key)),
    [`GET ${path}/:id`]: reader(key, ORG_POINT(key), { byId: true }),
    [`POST ${path}`]: writer({
      key,
      operation: 'create',
      button: 'create',
      level: 'list',
      // 新建：所属组织须在新建范围内（currentEditable：scopeAllows 含创建人维度），范围外 404
      scope: guardScope(`idp.currentEditable(${key})`, NOT_FOUND),
      fields: 'body',
      result: editable,
      guards,
      preconditions: ['requireNew'],
    }),
    [`PATCH ${path}/:id`]: writer({
      key,
      operation: 'update',
      button: 'update',
      level: 'detail',
      scope: ORG_POINT(key),
      fields: 'body',
      result: editable,
      guards: ['idp.publicDownReadonly', ...guards],
      byId: true,
    }),
    [`DELETE ${path}/:id`]: writer({
      key,
      operation: 'delete',
      button: 'delete',
      level: 'detail',
      scope: ORG_POINT(key),
      fields: 'none',
      result: editable,
      guards: ['idp.publicDownReadonly'],
      byId: true,
    }),
  };
}

/** 模板模块 / 通用目标：父模板范围内，按各自对象的数据操作权 + 同名按钮（create@list / update|delete@detail）。 */
function templatePart(key: 'templateModule' | 'commonGoal', segment: string) {
  const path = `${BASE}/templates/:id/${segment}`;
  const part = (operation: Operation, fields: 'body' | 'none') =>
    writer({
      key,
      operation,
      button: operation,
      level: operation === 'create' ? 'list' : 'detail',
      scope: ORG_POINT('template'),
      fields,
      result: 'idp.currentEditable(template)',
      guards: ['idp.publicDownReadonly'],
      outKey: 'template',
      byId: true,
    });
  return {
    [`POST ${path}`]: part('create', 'body'),
    [`PATCH ${path}/:partId`]: part('update', 'body'),
    [`DELETE ${path}/:partId`]: part('delete', 'none'),
  };
}

/** 计划详情 / 能力候选：HR（持计划查看权且员工在范围内）或参与人（本人 / 指导人 / 当前待办人），都不是 → 404。 */
const PLAN_VIEWER: RoutePolicy = any(
  [
    reader('plan', PLAN_POINT),
    relation({
      relation: 'idp.participant',
      target: { param: 'id' },
      denied: NOT_FOUND,
      fields: projector('idp.participantPlan', 'idp.plan'),
    }),
  ],
  byId,
);

/** 执行写入（目标 / 任务 / 回顾 / 模块内容）：当前阶段在办待办人 + 节点按钮（requireExecutor）。 */
function executor(fields: 'body' | 'none'): RoutePolicy {
  return relation({
    relation: 'idp.executor',
    target: { param: 'id' },
    denied: NODE_DENIED,
    fields: projector('idp.plan', 'idp.plan'),
    ...byId,
    write: idpWrite(fields, 'idp.executorRecheck', { preconditions: ['requireExecutor', 'requireViewer'] }),
    // 响应按查看人（HR 字段裁剪 / 参与人固定字段）投影，计划及组成对象的查看权只决定出口
    optional: { responseView: reader('plan', PLAN_LIST) },
  });
}

/** 批量干预（催办 / 启动下一阶段 / 终止）：plan update + 列表按钮；逐条回执按当前范围复核（范围外 404）。 */
function intervention(buttonCode: 'urge' | 'startNext' | 'terminate'): RoutePolicy {
  return writer({
    key: 'plan',
    operation: 'update',
    button: buttonCode,
    level: 'list',
    scope: PLAN_LIST,
    fields: 'body',
    result: 'idp.receiptRecheck',
    // 进行中阶段的审批实例经审批引擎处理（openRun 锁运行行）
    preconditions: ['requireNew', 'openRun'],
  });
}

function keyInfo(key: 'tutorship' | 'career' | 'workShift', segment: string) {
  const path = `${BASE}/${segment}`;
  const list = listScope(`idp.personScope(${key})`);
  const point = pointScope({ param: 'id' }, `idp.${key}.byId`, NOT_FOUND);
  const editable = `idp.keyInfoInScope(${key})`;
  return {
    [`GET ${path}`]: reader(key, list),
    [`GET ${path}/:id`]: reader(key, point, { byId: true }),
    [`POST ${path}`]: writer({
      key,
      operation: 'create',
      button: 'create',
      level: 'list',
      scope: list,
      fields: 'body',
      result: editable,
    }),
    [`PATCH ${path}/:id`]: writer({
      key,
      operation: 'update',
      button: 'update',
      level: 'detail',
      scope: point,
      fields: 'body',
      result: editable,
      byId: true,
    }),
    [`DELETE ${path}/:id`]: writer({
      key,
      operation: 'delete',
      button: 'delete',
      level: 'detail',
      scope: point,
      fields: 'none',
      result: editable,
      byId: true,
    }),
  };
}

export const IDP_POLICIES = defineTable('idp', {
  // ---- 流程（含子流程）与候选审批流程 ---------------------------------------------------------------------------------
  ...configCrud('process', `${BASE}/processes`),
  [`GET ${BASE}/approval-processes`]: reader('process', noScope('候选审批流程按审批类型列出，不按 IDP 范围过滤'), {
    outKey: 'subProcess',
  }),
  // ---- 模板：引用流程须另有流程查看权且流程在范围内（processScopeFor，DEC-178 同口径）---------------------------------
  ...configCrud('template', `${BASE}/templates`, ['idp.processReference']),
  [`POST ${BASE}/templates/:id/copy`]: writer({
    key: 'template',
    operation: 'create',
    button: 'copy',
    level: 'detail',
    scope: ORG_POINT('template'),
    fields: 'body',
    result: 'idp.currentEditable(template)',
    byId: true,
  }),
  [`POST ${BASE}/templates/:id/publish`]: writer({
    key: 'template',
    operation: 'update',
    button: 'publish',
    level: 'detail',
    scope: ORG_POINT('template'),
    fields: 'none',
    result: 'idp.currentEditable(template)',
    guards: ['idp.publicDownReadonly'],
    byId: true,
  }),
  [`POST ${BASE}/templates/:id/unpublish`]: writer({
    key: 'template',
    operation: 'update',
    button: 'unpublish',
    level: 'detail',
    scope: ORG_POINT('template'),
    fields: 'none',
    result: 'idp.currentEditable(template)',
    guards: ['idp.publicDownReadonly'],
    byId: true,
  }),
  ...templatePart('templateModule', 'modules'),
  ...templatePart('commonGoal', 'common-goals'),
  // ---- 计划（HR）----------------------------------------------------------------------------------------------------
  [`GET ${BASE}/plans`]: reader('plan', PLAN_LIST),
  // 参与人列表（K-30～K-32）：本人 / 指导人的非未开始计划 + 当前有待办的计划；固定字段（去掉 tutorRole 等）
  [`GET ${BASE}/my-plans`]: own({
    predicate: 'idp.participant',
    fields: projector('idp.participantSummary', 'idp.plan'),
  }),
  [`GET ${BASE}/plans/:id`]: PLAN_VIEWER,
  // 新建计划所选模板须对操作人可见（templateCheck：模板查看权 + 模板范围，自有或向下公开）
  [`POST ${BASE}/plans`]: writer({
    key: 'plan',
    operation: 'create',
    button: 'create',
    level: 'list',
    scope: PLAN_LIST,
    fields: 'body',
    result: 'idp.stillVisible',
    guards: ['idp.templateVisible'],
  }),
  [`PATCH ${BASE}/plans/:id`]: writer({
    key: 'plan',
    operation: 'update',
    button: 'update',
    level: 'detail',
    scope: PLAN_POINT,
    fields: 'body',
    result: 'idp.stillVisible',
    byId: true,
  }),
  [`POST ${BASE}/plans/:id/start`]: writer({
    key: 'plan',
    operation: 'update',
    button: 'start',
    level: 'detail',
    scope: PLAN_POINT,
    fields: 'none',
    result: 'idp.stillVisible',
    byId: true,
  }),
  [`DELETE ${BASE}/plans/:id`]: writer({
    key: 'plan',
    operation: 'delete',
    button: 'delete',
    level: 'detail',
    scope: PLAN_POINT,
    fields: 'none',
    result: 'idp.stillVisible',
    // 进行中阶段先撤销审批实例（plan-service.ts cancelStageInstance → 审批引擎 openRun）
    preconditions: ['openRun'],
    byId: true,
  }),
  // 能力候选：执行人（execution-service.ts candidates → requireExecutor(…, 'RowAddIdpGoal')：查看人 + 当前阶段在办
  // 待办人 + 节点按钮）；query.moduleId 非 UUID → 400；候选只含 id / name / definition / category
  [`GET ${BASE}/plans/:id/competency-candidates`]: relation({
    relation: 'idp.executor',
    target: { param: 'id' },
    denied: NODE_DENIED,
    fields: fixed(['id', 'name', 'definition', 'category'], 'competency.ts competencyCandidates 固定键'),
    ...byId,
  }),
  // ---- 计划执行（执行人 + 节点按钮）--------------------------------------------------------------------------------
  [`POST ${BASE}/plans/:id/goals`]: executor('body'),
  [`PATCH ${BASE}/plans/:id/goals/:goalId`]: executor('body'),
  [`DELETE ${BASE}/plans/:id/goals/:goalId`]: executor('none'),
  [`POST ${BASE}/plans/:id/goals/:goalId/tasks`]: executor('body'),
  [`PATCH ${BASE}/plans/:id/goals/:goalId/tasks/:taskId`]: executor('body'),
  [`DELETE ${BASE}/plans/:id/goals/:goalId/tasks/:taskId`]: executor('none'),
  [`PUT ${BASE}/plans/:id/goals/:goalId/review`]: executor('body'),
  [`PUT ${BASE}/plans/:id/modules/:moduleId/content`]: executor('body'),
  // ---- 干预与统一下发（DEC-321①：计划所有者全量流程干预另见 ownerIntervention，命令内）--------------------------------
  [`POST ${BASE}/plans/urge`]: intervention('urge'),
  [`POST ${BASE}/plans/start-next`]: intervention('startNext'),
  [`POST ${BASE}/plans/terminate`]: intervention('terminate'),
  // 跳转经审批引擎管理员动作（intervention-service.ts jumpPlan → adminAct(kind jump)）
  [`POST ${BASE}/plans/:id/jump`]: writer({
    key: 'plan',
    operation: 'update',
    button: 'jump',
    level: 'detail',
    scope: PLAN_POINT,
    fields: 'body',
    result: 'idp.stillVisible',
    preconditions: ['openRun', 'assertBusinessUnchanged', 'assertNotNodeAssignee', 'assertNotSelf', 'assertReviewer'],
    byId: true,
  }),
  [`POST ${BASE}/plans/tasks/issue`]: writer({
    key: 'task',
    operation: 'create',
    button: 'issue',
    level: 'list',
    scope: PLAN_LIST,
    fields: 'body',
    result: 'idp.receiptRecheck',
    outKey: 'plan',
  }),
  // ---- 关键信息（按员工归属）------------------------------------------------------------------------------------
  ...keyInfo('tutorship', 'tutorships'),
  ...keyInfo('career', 'careers'),
  ...keyInfo('workShift', 'work-shifts'),
});
