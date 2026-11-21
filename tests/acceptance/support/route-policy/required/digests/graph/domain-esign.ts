/**
 * 直接依赖图：区域 domain-esign（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'packages/domain/src/esign/events.ts#isTerminal': ['#TERMINAL_STATUSES'],
  'packages/domain/src/esign/events.ts#nextSignState': ['#isTerminal'],
  'packages/domain/src/esign/failure.ts#isEsignFailureReason': ['#ESIGN_FAILURE_REASONS'],
  'packages/domain/src/esign/notice-templates.ts#ESIGN_NOTICE_TEMPLATES': [
    '#ESIGN_COMPLETED_EMPLOYEE_TEMPLATE',
    '#ESIGN_COMPLETED_INITIATOR_TEMPLATE',
    '#ESIGN_REMIND_TEMPLATE',
    '#ESIGN_REVOKED_EMPLOYEE_TEMPLATE',
    '#ESIGN_REVOKED_INITIATOR_TEMPLATE',
  ],
  'packages/domain/src/esign/notice-templates.ts#SOURCE_NOTICE_BODIES': [
    '#ESIGN_COMPLETED_EMPLOYEE_TEMPLATE',
    '#ESIGN_COMPLETED_INITIATOR_TEMPLATE',
    '#ESIGN_REMIND_TEMPLATE',
    '#ESIGN_REVOKED_EMPLOYEE_TEMPLATE',
    '#ESIGN_REVOKED_INITIATOR_TEMPLATE',
  ],
  'packages/domain/src/esign/notice-templates.ts#renderEsignNotice': [
    '#ESIGN_NOTICE_TEMPLATES',
    '#SOURCE_NOTICE_BODIES',
    '#SOURCE_SCENE_LABELS',
    '#TASK_NUMBER',
    '#fill',
  ],
  'packages/domain/src/esign/source-events.ts#classifyOfferChange': ['#isOfferSignable'],
  'packages/domain/src/esign/source-events.ts#isOfferSignable': ['#SIGNABLE_OFFER_STATUSES'],
  'packages/domain/src/esign/variables.ts#renderTemplateBody': [
    '#ESIGN_EMPTY_VALUE',
    '#ESIGN_TEMPLATE_VARIABLES',
    '#PLACEHOLDER',
  ],
  'packages/domain/src/esign/variables.ts#unknownTemplateVariables': ['#ESIGN_TEMPLATE_VARIABLES', '#PLACEHOLDER'],
};
