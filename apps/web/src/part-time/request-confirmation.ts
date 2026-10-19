import type { Values } from '../foundation/forms/values.js';
import { r } from './request-messages.js';
/** DEC-635：只比较单据快照；相等交后端拒绝，裁剪的日期不补值。 */
export function shorteningNotice(values: Values): string | undefined {
  const { endDate, originalEndDate } = values;
  const date = /^\d{4}-\d{2}-\d{2}$/;
  return values.kind === 'extend' &&
    typeof endDate === 'string' &&
    typeof originalEndDate === 'string' &&
    date.test(endDate) &&
    date.test(originalEndDate) &&
    endDate < originalEndDate
    ? r.shorten(endDate, originalEndDate)
    : undefined;
}
