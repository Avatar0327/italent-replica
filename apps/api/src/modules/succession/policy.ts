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
import { defineTable } from '../../route-policy/index.js';
import {
  any,
  BAD_REQUEST,
  button,
  fixed,
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
const RECHECK = 'succession.commandRecheck';
const AUTHORIZE_RESULT = 'succession.authorizeResult';
const COMMAND = write('body', RECHECK, AUTHORIZE_RESULT, {
  ledger: 'single',
  preconditions: ['succession.syncBarrier', 'succession.noOverlap'],
});
const MUTATE = 'succession.record.writable';

export const SUCCESSION_POLICIES = defineTable('succession', {
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
    guards: ['succession.filterFieldVisible', SELF_HIDDEN],
  }),
  [`GET ${BASE}/records/:id`]: object({
    invalidId: BAD_REQUEST,
    object: RECORD,
    operation: 'view',
    button: noButton('详情按对象查看权'),
    scope: pointScope({ param: 'id' }, 'succession.record.byId', NOT_FOUND),
    fields: OUT,
    guards: [SELF_HIDDEN],
  }),
  [`POST ${BASE}/records`]: object({
    object: RECORD,
    operation: 'create',
    button: button('create', 'list'),
    scope: guardScope('succession.targetInScope', NOT_FOUND),
    fields: OUT,
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
    guards: ['succession.immutableFields', SELF_HIDDEN],
    write: COMMAND,
  }),
  [`POST ${BASE}/records/end`]: object({
    object: RECORD,
    operation: 'update',
    button: button('end', 'list'),
    scope: pointScope({ body: 'items[*].id' }, MUTATE, NOT_FOUND),
    fields: OUT,
    guards: [SELF_HIDDEN],
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
