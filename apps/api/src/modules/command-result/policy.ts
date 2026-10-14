/**
 * 本人命令结果查询（F-120）路由的现状声明（F-039）：
 * - GET /api/tenant/commands/:commandId/result：只返回当前登录用户自己发起的命令；台账按（租户，命令 ID）
 *   取归属并比对 actor_user_id = 当前用户（不是本人含发起人为空即 404，不回退失败审计），失败审计再固定带 tenant_id 与
 *   actor_user_id = 当前用户（service.readOwnCommandResult）；不是本人的 / 不存在的 / 其他租户的 / 结果未知的
 *   同为 404 NOT_FOUND，不用 403，避免泄露命令是否存在；命令 ID 格式不合法为 400。
 * - 不新增授权项编码：本人读取，无对象权限、无按钮、无数据范围（member 预设）；只读，不写台账、不写审计。
 */
import { defineTable } from '../../route-policy/index.js';
import { BAD_REQUEST, fixed, NOT_FOUND, own } from '../../route-policy/presets.js';

const RESULT = fixed(
  ['commandId', 'status', 'commandType', 'businessType', 'businessId', 'revision', 'httpStatus', 'completedAt'],
  'F-120：命令结果摘要，不含响应正文与他人信息',
);

export const COMMAND_RESULT_POLICIES = defineTable('command-result', {
  'GET /api/tenant/commands/:commandId/result': own({
    predicate: 'command.result.initiator',
    denied: NOT_FOUND,
    fields: RESULT,
    invalidId: BAD_REQUEST,
  }),
});
