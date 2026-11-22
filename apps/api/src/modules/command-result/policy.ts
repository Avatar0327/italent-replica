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
  'F-120 未登记类型返回八键摘要；F-553 登记的签署类型只返回 sourceId、taskId 两键',
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
