/**
 * 继任管理路由的权限声明（F-039 格式；挂在 /api/tenant/succession 之下，应用 SuccessionAndDevelopment，
 * DEC-043：范围按 用户 × SuccessionAndDevelopment，缺省为空）。每条新增路由在这里登记声明，并在
 * tests/acceptance/support/route-policy/required/succession.ts 登记必需义务与证据（设计 §2.2 路由编号）。
 *
 * A1（记录读侧）：
 * - #1 GET /readiness：Succession.Record 查看权即可，准备度是共享字典（HR 读字典契约，§8.3），不按数据范围裁剪；
 * - #2 GET /records、/records/:id：范围锚点 = 目标组织（职位继任 = 职位请求当日所属组织（DEC-368①））∪ 创建人；SELF 过滤
 *   （succession.selfHidden：开关为 false 时本人为目标的记录不返回、不计数、详情 404）；范围外与不存在同一个 404。
 */
import { SUCCESSION_OBJECTS } from '@italent/domain';
import { defineTable } from '../../route-policy/index.js';
import {
  BAD_REQUEST,
  fixed,
  listScope,
  noButton,
  noScope,
  NOT_FOUND,
  object,
  pointScope,
  projector,
} from '../../route-policy/presets.js';

const BASE = '/api/tenant/succession';
const RECORD = SUCCESSION_OBJECTS.record.code;
const OUT = projector('succession.record', 'succession.record');
const SELF_HIDDEN = 'succession.selfHidden';

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
});
