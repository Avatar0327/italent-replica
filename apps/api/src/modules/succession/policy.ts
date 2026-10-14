/**
 * 继任管理路由的权限声明（F-039 格式；挂在 /api/tenant/succession 之下，应用 SuccessionAndDevelopment，
 * DEC-043：范围按 用户 × SuccessionAndDevelopment，缺省为空）。每条新增路由在这里登记声明，并在
 * tests/acceptance/support/route-policy/required/succession.ts 登记必需义务与证据（设计 §2.2 路由编号）。
 *
 * A1（记录读侧）：
 * - #1 GET /readiness：Succession.Record 查看权即可，准备度是共享字典（HR 读字典契约，§8.3），不按数据范围裁剪；
 * - #2 GET /records、/records/:id：范围锚点 = 目标组织（职位继任 = 职位请求当日所属组织（DEC-368①））∪ 创建人；SELF 过滤
 *   （succession.selfHidden：开关为 false 时本人为目标的记录不返回、不计数、详情 404）；范围外与不存在同一个 404。
 *
 * A2（记录写侧，设计 §2.1、§2.2 #3～#6、§8.5）：写入口一律 Idempotency-Key + 命令台账（single）；命令事务内先
 * succession.commandRecheck（CommandGuard.before，对象 / 按钮 / 字段 / 范围按事务内当前授权重判），返回前一律走
 * succession.authorizeResult（首次 / 直接重放 / 失败回查重放同一个函数：台账只存记录 ID，按请求人当时范围逐个复核后投影）。
 * - #3 POST /records：范围锚点 = 目标组织（职位 = 职位请求当日所属组织）在范围内；继任者不判范围（DEC-308）；
 * - #3a GET /successor-candidates：新增或编辑按钮之一，全租户搜索，不按范围裁剪；
 * - #4 PUT、#6 DELETE：按记录定位（范围外 / 已删除 / SELF 与不存在同一个 404）；#5 POST /records/end：逐条同上，整批 404。
 */
import { SUCCESSION_OBJECTS } from '@italent/domain';
import { defineTable, type RoutePolicy } from '../../route-policy/index.js';
import {
  any,
  all,
  BAD_REQUEST,
  button,
  fixed,
  commandWrite,
  seeAll,
  FORBIDDEN,
  guardScope,
  listScope,
  noButton,
  noScope,
  NOT_FOUND,
  object,
  pointScope,
  projector,
  write,
} from '../../route-policy/presets.js';

const BASE = '/api/tenant/succession';
const RECORD = SUCCESSION_OBJECTS.record.code;
const OUT = projector('succession.record', 'succession.record');
const SELF_HIDDEN = 'succession.selfHidden';
const LEFT_PROJECTED = 'succession.successorLeftProjected';
const RECHECK = 'succession.commandRecheck';
const AUTHORIZE_RESULT = 'succession.authorizeResult';
const COMMAND = write('body', RECHECK, AUTHORIZE_RESULT, {
  ledger: 'single',
  preconditions: ['succession.syncBarrier', 'succession.noOverlap'],
});
const MUTATE = 'succession.record.writable';

function configPolicy(
  key: 'population' | 'ruleSettings' | 'riskLevel' | 'healthLevel',
  operation: 'view' | 'create' | 'update' | 'delete',
) {
  return object({
    object: SUCCESSION_OBJECTS[key].code,
    operation,
    button: operation === 'view' ? noButton('配置查看') : button(operation, operation === 'create' ? 'list' : 'detail'),
    scope: seeAll(FORBIDDEN),
    fields: projector('succession.config', 'succession.config'),
    ...(operation === 'view' ? {} : { write: write('body', RECHECK, AUTHORIZE_RESULT, { ledger: 'single' }) }),
  });
}

function levelPolicies(): Record<string, RoutePolicy> {
  const policies: Record<string, RoutePolicy> = {};
  for (const kind of ['risk', 'health'] as const) {
    const key = kind === 'risk' ? 'riskLevel' : 'healthLevel';
    const path = `${BASE}/${kind}-levels`;
    policies[`GET ${path}`] = configPolicy(key, 'view');
    policies[`POST ${path}`] = configPolicy(key, 'create');
    for (const [method, operation] of [
      ['GET', 'view'],
      ['PUT', 'update'],
      ['DELETE', 'delete'],
    ] as const)
      policies[`${method} ${path}/:id`] = { ...configPolicy(key, operation), invalidId: BAD_REQUEST };
    policies[`PUT ${path}/order`] = { ...configPolicy(key, 'update'), button: button('reorder', 'list') };
    const result = kind === 'risk' ? SUCCESSION_OBJECTS.riskResult.code : SUCCESSION_OBJECTS.healthResult.code;
    const option = (code: string, level: 'list' | 'detail') =>
      object({
        object: result,
        operation: 'update',
        button: button(code, level),
        scope: noScope('设计 §2.2 #12：赋值选择器只含启用等级的安全字典，不读取规则正文'),
        fields: fixed(['id', 'code', 'name', 'color', 'enabled'], '设计 §2.2 #12 固定键'),
      });
    policies[`GET ${path}/options`] =
      kind === 'risk' ? option('assign', 'detail') : any([option('assign', 'detail'), option('reset', 'list')]);
  }
  return policies;
}

function calcPolicy(retry = false) {
  return object({
    object: SUCCESSION_OBJECTS.calcRun.code,
    operation: retry ? 'update' : 'view',
    button: retry ? button('retry', 'detail') : noButton('计算 run 查看'),
    scope: guardScope('succession.calcVisible', NOT_FOUND),
    fields: projector('succession.calc', 'succession.calc'),
    ...(retry
      ? {
          write: write('body', 'succession.calcRetry', AUTHORIZE_RESULT, {
            ledger: 'single',
            commandOnly: true,
          }),
          guards: ['succession.calcRetryScope'],
        }
      : {}),
  });
}

function syncPolicy(action?: 'sync' | 'retry' | 'abort') {
  const read = object({
    object: SUCCESSION_OBJECTS.syncBatch.code,
    operation: 'view',
    button: noButton('同步批次查看'),
    scope: guardScope('succession.syncVisible', NOT_FOUND),
    fields: projector('succession.sync', 'succession.sync'),
  });
  if (!action) return read;
  const change = object({
    object: SUCCESSION_OBJECTS.syncBatch.code,
    operation: action === 'sync' ? 'create' : 'update',
    button: button(action, action === 'sync' ? 'list' : 'detail'),
    scope: guardScope('succession.syncVisible', NOT_FOUND),
    fields: projector('succession.sync', 'succession.sync'),
    write: write('body', 'succession.syncRecheck', AUTHORIZE_RESULT, { ledger: 'single', commandOnly: true }),
    guards: [action === 'abort' ? 'succession.syncAdmin' : 'succession.syncRequestScope'],
  });
  return all([read, change], projector('succession.sync', 'succession.sync'));
}

export const SUCCESSION_POLICIES = defineTable('succession', {
  [`GET ${BASE}/maps/org`]: object({
    object: SUCCESSION_OBJECTS.map.code,
    operation: 'view',
    button: noButton('组织地图查看'),
    scope: listScope('succession.mapDisplay'),
    fields: projector('succession.orgMap', 'succession.orgMap'),
    guards: [SELF_HIDDEN],
    optional: {
      mapRecords: object({
        object: RECORD,
        operation: 'view',
        button: noButton('卡片继任与现任披露'),
        scope: listScope('succession.recordScope(org ∪ creator)'),
        fields: OUT,
      }),
      mapRisk: object({
        object: SUCCESSION_OBJECTS.riskResult.code,
        operation: 'view',
        button: noButton('卡片风险披露'),
        scope: listScope('succession.riskScope'),
        fields: projector('succession.risk', 'succession.risk'),
      }),
      mapHealth: object({
        object: SUCCESSION_OBJECTS.healthResult.code,
        operation: 'view',
        button: noButton('卡片健康度披露'),
        scope: listScope('succession.healthScope'),
        fields: projector('succession.health', 'succession.health'),
      }),
    },
  }),
  [`GET ${BASE}/health-results`]: object({
    object: SUCCESSION_OBJECTS.healthResult.code,
    operation: 'view',
    button: noButton('健康度读取'),
    scope: listScope('succession.healthScope'),
    fields: projector('succession.health', 'succession.health'),
  }),
  [`PUT ${BASE}/health-results/:orgId`]: object({
    invalidId: BAD_REQUEST,
    object: SUCCESSION_OBJECTS.healthResult.code,
    operation: 'update',
    button: button('assign', 'detail'),
    scope: guardScope('succession.healthOrg', NOT_FOUND),
    fields: projector('succession.health', 'succession.health'),
    write: write('body', RECHECK, AUTHORIZE_RESULT, { ledger: 'single' }),
  }),
  [`POST ${BASE}/health-results/reset`]: object({
    object: SUCCESSION_OBJECTS.healthResult.code,
    operation: 'update',
    button: button('reset', 'list'),
    scope: guardScope('succession.healthQueue', NOT_FOUND),
    fields: fixed(['runId'], '设计 #15a 202 回执'),
    write: write('body', 'succession.healthQueueRecheck', AUTHORIZE_RESULT, { ledger: 'single' }),
  }),
  [`POST ${BASE}/maps/org/compute-health`]: object({
    object: SUCCESSION_OBJECTS.map.code,
    operation: 'view',
    button: button('computeHealth', 'list'),
    scope: guardScope('succession.healthQueue', NOT_FOUND),
    fields: fixed(['runId'], '设计 #9a 202 回执'),
    write: write('body', 'succession.healthQueueRecheck', AUTHORIZE_RESULT, { ledger: 'single' }),
  }),
  [`GET ${BASE}/maps/position`]: object({
    object: SUCCESSION_OBJECTS.map.code,
    operation: 'view',
    button: noButton('职位地图只读，显示条件应用本人保存偏好（DEC-453④）'),
    scope: listScope('succession.positionMapScope'),
    fields: projector('succession.positionMap', 'succession.positionMap'),
    optional: {
      risk: object({
        object: SUCCESSION_OBJECTS.riskResult.code,
        operation: 'view',
        button: noButton('风险卡片只披露，不要求赋值按钮'),
        scope: listScope('succession.riskScope'),
        fields: projector('succession.risk', 'succession.risk'),
      }),
    },
  }),
  [`GET ${BASE}/maps/:kind/preferences`]: object({
    object: SUCCESSION_OBJECTS.map.code,
    operation: 'view',
    button: noButton('本人显示设置'),
    scope: noScope('本人偏好，不是组织数据集'),
    fields: fixed(
      ['rootOrgId', 'depth', 'hiddenOrgIds', 'showKeyPositions', 'showPositionsWithoutSuccessor', 'revision'],
      '设计 #8 个人设置白名单',
    ),
  }),
  [`PUT ${BASE}/maps/:kind/preferences`]: object({
    object: SUCCESSION_OBJECTS.map.code,
    operation: 'view',
    button: noButton('Map.view 保存本人显示设置'),
    scope: guardScope('succession.preferenceIds', NOT_FOUND),
    fields: fixed(
      ['rootOrgId', 'depth', 'hiddenOrgIds', 'showKeyPositions', 'showPositionsWithoutSuccessor', 'revision'],
      '设计 #8 个人设置白名单',
    ),
    write: commandWrite('succession.mapCommandRecheck', AUTHORIZE_RESULT, { ledger: 'single' }),
  }),
  [`POST ${BASE}/maps/org/compute-stats`]: object({
    object: SUCCESSION_OBJECTS.map.code,
    operation: 'view',
    button: button('computeStats', 'list'),
    scope: guardScope('succession.mapDisplay', NOT_FOUND),
    fields: fixed(['runId'], '设计 #9 202 回执'),
    write: commandWrite('succession.mapCommandRecheck', AUTHORIZE_RESULT, { ledger: 'single' }),
  }),
  [`POST ${BASE}/maps/position/compute-risk`]: object({
    object: SUCCESSION_OBJECTS.map.code,
    operation: 'view',
    button: button('computeRisk', 'list'),
    scope: guardScope('succession.riskDisplay', NOT_FOUND),
    fields: fixed(['runId'], '设计 #9 202 回执'),
    write: commandWrite('succession.riskCommandRecheck', AUTHORIZE_RESULT, { ledger: 'single' }),
  }),
  [`GET ${BASE}/risk-results`]: object({
    object: SUCCESSION_OBJECTS.riskResult.code,
    operation: 'view',
    button: noButton('风险结果查看'),
    scope: listScope('succession.riskScope'),
    fields: projector('succession.risk', 'succession.risk'),
  }),
  [`PUT ${BASE}/risk-results/:positionId`]: object({
    invalidId: BAD_REQUEST,
    object: SUCCESSION_OBJECTS.riskResult.code,
    operation: 'update',
    button: button('assign', 'detail'),
    scope: pointScope({ param: 'positionId' }, 'succession.riskTarget', NOT_FOUND),
    fields: projector('succession.risk', 'succession.risk'),
    write: write('body', RECHECK, AUTHORIZE_RESULT, { ledger: 'single', preconditions: ['succession.syncBarrier'] }),
  }),
  ...levelPolicies(),
  [`GET ${BASE}/sync-batches`]: syncPolicy(),
  [`GET ${BASE}/sync-batches/:id`]: { ...syncPolicy(), invalidId: BAD_REQUEST },
  [`GET ${BASE}/sync-batches/:id/items`]: { ...syncPolicy(), invalidId: BAD_REQUEST },
  [`GET ${BASE}/sync-batches/:id/targets`]: { ...syncPolicy(), invalidId: BAD_REQUEST },
  [`POST ${BASE}/sync`]: syncPolicy('sync'),
  [`POST ${BASE}/sync-batches/:id/retry`]: { ...syncPolicy('retry'), invalidId: BAD_REQUEST },
  [`POST ${BASE}/sync-batches/:id/abort`]: { ...syncPolicy('abort'), invalidId: BAD_REQUEST },
  [`GET ${BASE}/calc-runs`]: calcPolicy(),
  [`GET ${BASE}/calc-runs/:id`]: { ...calcPolicy(), invalidId: BAD_REQUEST },
  [`GET ${BASE}/calc-runs/:id/failures`]: { ...calcPolicy(), invalidId: BAD_REQUEST },
  [`POST ${BASE}/calc-runs/:id/retry`]: {
    ...all([calcPolicy(), calcPolicy(true)], projector('succession.calc', 'succession.calc')),
    invalidId: BAD_REQUEST,
  },
  [`GET ${BASE}/populations`]: configPolicy('population', 'view'),
  [`GET ${BASE}/populations/:id`]: { ...configPolicy('population', 'view'), invalidId: BAD_REQUEST },
  [`POST ${BASE}/populations`]: configPolicy('population', 'create'),
  [`PUT ${BASE}/populations/:id`]: { ...configPolicy('population', 'update'), invalidId: BAD_REQUEST },
  [`DELETE ${BASE}/populations/:id`]: { ...configPolicy('population', 'delete'), invalidId: BAD_REQUEST },
  [`GET ${BASE}/rule-settings/:kind`]: configPolicy('ruleSettings', 'view'),
  [`PUT ${BASE}/rule-settings/:kind`]: configPolicy('ruleSettings', 'update'),
  [`GET ${BASE}/readiness`]: object({
    object: RECORD,
    operation: 'view',
    button: noButton('选择器按对象查看权，无按钮'),
    scope: noScope('准备度是共享字典，HR 只读选择器，不按数据范围裁剪（设计 §8.3）'),
    fields: fixed(['id', 'code', 'name', 'color', 'sort'], '设计 §2.2 #1 固定键（准备度字典字段，非 Record 字段）'),
  }),
  // 带 status / successionType / targetOrgId / targetPositionId / successorEmployeeId 筛选而无对应字段查看权
  // → 403 FILTER_FIELD_HIDDEN
  [`GET ${BASE}/records`]: object({
    object: RECORD,
    operation: 'view',
    button: noButton('列表按对象查看权'),
    scope: listScope('succession.recordScope(org ∪ creator)'),
    fields: OUT,
    guards: ['succession.filterFieldVisible', SELF_HIDDEN, LEFT_PROJECTED],
  }),
  [`GET ${BASE}/records/:id`]: object({
    invalidId: BAD_REQUEST,
    object: RECORD,
    operation: 'view',
    button: noButton('详情按对象查看权'),
    scope: pointScope({ param: 'id' }, 'succession.record.byId', NOT_FOUND),
    fields: OUT,
    guards: [SELF_HIDDEN, LEFT_PROJECTED],
  }),
  [`POST ${BASE}/records`]: object({
    object: RECORD,
    operation: 'create',
    button: button('create', 'list'),
    scope: guardScope('succession.targetInScope', NOT_FOUND),
    fields: OUT,
    guards: [LEFT_PROJECTED],
    write: write('body', RECHECK, AUTHORIZE_RESULT, {
      ledger: 'single',
      preconditions: ['succession.successorActive', 'succession.syncBarrier', 'succession.noOverlap'],
    }),
  }),
  // 候选：新增或编辑权之一；全租户在职人员（含待入职，≤ 30 条），不按员工范围裁剪（DEC-308）
  [`GET ${BASE}/successor-candidates`]: any([
    object({
      object: RECORD,
      operation: 'create',
      button: button('create', 'list'),
      scope: noScope('候选是全租户在职人员搜索，继任者可在范围外（DEC-308）'),
      fields: fixed(['employeeId', 'name', 'email', 'status'], '设计 §2.2 #3a 固定键'),
    }),
    object({
      object: RECORD,
      operation: 'update',
      button: button('update', 'detail'),
      scope: noScope('候选是全租户在职人员搜索，继任者可在范围外（DEC-308）'),
      fields: fixed(['employeeId', 'name', 'email', 'status'], '设计 §2.2 #3a 固定键'),
    }),
  ]),
  [`PUT ${BASE}/records/:id`]: object({
    invalidId: BAD_REQUEST,
    object: RECORD,
    operation: 'update',
    button: button('update', 'detail'),
    scope: pointScope({ param: 'id' }, MUTATE, NOT_FOUND),
    fields: OUT,
    guards: ['succession.immutableFields', SELF_HIDDEN, LEFT_PROJECTED],
    write: COMMAND,
  }),
  [`POST ${BASE}/records/end`]: object({
    object: RECORD,
    operation: 'update',
    button: button('end', 'list'),
    scope: pointScope({ body: 'items[*].id' }, MUTATE, NOT_FOUND),
    fields: OUT,
    guards: [SELF_HIDDEN, LEFT_PROJECTED],
    rows: {
      path: 'items[*]',
      operation: 'update',
      button: button('end', 'list'),
      fields: { none: true, reason: '结束只写 endDate / endReason 两个系统约定字段，无字段目录提取' },
      target: { body: 'items[*].id' },
      batch: 'atomic',
    },
    write: write('body', RECHECK, AUTHORIZE_RESULT, {
      ledger: 'single',
      commandOnly: true,
      preconditions: ['succession.syncBarrier'],
    }),
  }),
  [`DELETE ${BASE}/records/:id`]: object({
    invalidId: BAD_REQUEST,
    object: RECORD,
    operation: 'delete',
    button: button('delete', 'detail'),
    scope: pointScope({ param: 'id' }, MUTATE, NOT_FOUND),
    fields: OUT,
    guards: [SELF_HIDDEN],
    write: write('body', RECHECK, AUTHORIZE_RESULT, {
      ledger: 'single',
      preconditions: ['succession.syncBarrier'],
    }),
  }),
});
