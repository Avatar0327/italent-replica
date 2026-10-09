/** F-057：派生上级摘要仍受 Person.superiorPersonId 与 Person.name 联合权限约束。 */
import { survey360 } from '@italent/domain';
import { ExactAuditFields } from './transfer-linkage.js';

export function survey360PersonAuditFields(fields: ReadonlySet<string> | undefined): ExactAuditFields {
  const allowed = new Set(fields ?? survey360.SURVEY360_OBJECTS.person.fields.map((field) => field.code));
  if (allowed.has('superiorPersonId')) {
    for (const path of ['superior', 'superior.id', 'superior.avatar']) allowed.add(path);
    if (allowed.has('name')) allowed.add('superior.name');
  }
  return new ExactAuditFields(allowed);
}
