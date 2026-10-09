/** F-058：账号头像随 Person.name；上级头像另受 superiorPersonId 权限约束，引用按完整路径裁剪。 */
import { survey360 } from '@italent/domain';
import { ExactAuditFields } from './transfer-linkage.js';

export function survey360PersonAuditFields(fields: ReadonlySet<string> | undefined): ExactAuditFields {
  const allowed = new Set(fields ?? survey360.SURVEY360_OBJECTS.person.fields.map((field) => field.code));
  if (allowed.has('name')) {
    for (const path of ['avatar', 'avatar.id', 'avatar.url']) allowed.add(path);
  }
  if (allowed.has('superiorPersonId')) {
    for (const path of ['superior', 'superior.id', 'superior.avatar']) allowed.add(path);
    if (allowed.has('name')) {
      for (const path of ['superior.name', 'superior.avatar.id', 'superior.avatar.url']) allowed.add(path);
    }
  }
  return new ExactAuditFields(allowed);
}
