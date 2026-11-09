/**
 * 试用期考核（试用中 / 转正两类共用）的办理份内容源（F-476 P7，设计 §5.4）：
 * 内容 = 考核表单字段（ASSESSMENT_FORM_FIELDS）；状态、版本号、生成的转正业务编号、离职终止标记等是流程事实，读现值。
 * 捕获是单行单语句读取，发生在审批适配器已持有员工锁 + 考核行锁之后、业务回调（生成转正记录）之前，天然一致。
 */
import type { Tx } from '@italent/db';
import { ASSESSMENT_FORM_FIELDS } from '@italent/domain';
import { composeHandled, pickContent, requireExt } from './handled-read.js';
import { loadAssessment } from './assessment-store.js';

const CONTENT_KEYS: readonly string[] = ASSESSMENT_FORM_FIELDS;

/** 详情里的流程事实（读现值）；考核类型不随办理变化，也归现值。 */
const FACTS: readonly string[] = [
  'id',
  'employeeId',
  'assessmentType',
  'status',
  'initiation',
  'initiatorUserId',
  'regularizationBusinessId',
  'revision',
];

/** 办理时冻结的内容扩展（provider 的 ext）。 */
export async function loadAssessmentContent(tx: Tx, tenantId: string, businessId: string) {
  return pickContent(await loadAssessment(tx, tenantId, businessId), CONTENT_KEYS);
}

export const composeAssessment = (live: object, ext: unknown, allowed: ReadonlySet<string>) =>
  composeHandled(live, requireExt(ext, CONTENT_KEYS), FACTS, allowed);
