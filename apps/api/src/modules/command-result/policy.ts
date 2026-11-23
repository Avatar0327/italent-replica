/** F-120 与 F-553（DEC-968）：本人同租户回查，登记类型另按当前来源、任务和人员变量授权。 */
import { defineTable } from '../../route-policy/index.js';
import { BAD_REQUEST, fixed, NOT_FOUND, own } from '../../route-policy/presets.js';

const RESULT = fixed(
  [
    'commandId',
    'status',
    'commandType',
    'businessType',
    'businessId',
    'revision',
    'httpStatus',
    'completedAt',
    'sourceId',
    'taskId',
  ],
  'F-120 基础摘要；F-553 签署只回 sourceId、taskId；BE-16 任务池仅回状态、业务 ID、版本和命令信息',
);

export const COMMAND_RESULT_POLICIES = defineTable('command-result', {
  'GET /api/tenant/commands/:commandId/result': own({
    predicate: 'command.result.initiator',
    denied: NOT_FOUND,
    guards: ['command.result.registered'],
    fields: RESULT,
    invalidId: BAD_REQUEST,
  }),
});
