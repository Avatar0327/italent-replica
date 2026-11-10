/**
 * 意向退休日期申请的办理份内容源（F-476 P7，设计 §5.4）：
 * 内容 = 申请表单字段（意向日期、原因与申请时冻结的预计 / 最早 / 最晚退休日期快照）；状态与版本号读现值。
 * 通过只记录、不写人事字段（A-6），所以办理份里的快照三项是申请时的值，不会被之后人事上的预计退休日期冒充。
 */
import type { Tx } from '@italent/db';
import { RETIREMENT_INTENTION_FORM_FIELDS } from '@italent/domain';
import { composeHandled, pickContent, requireExt } from './handled-read.js';
import { loadIntention } from './retirement-intention-store.js';

const CONTENT_KEYS: readonly string[] = RETIREMENT_INTENTION_FORM_FIELDS;
const FACTS: readonly string[] = ['id', 'employeeId', 'status', 'revision'];

export async function loadIntentionContent(tx: Tx, tenantId: string, businessId: string) {
  return pickContent(await loadIntention(tx, tenantId, businessId), CONTENT_KEYS);
}

export const composeIntention = (live: object, ext: unknown, allowed: ReadonlySet<string>) =>
  composeHandled(live, requireExt(ext, CONTENT_KEYS), FACTS, allowed);
