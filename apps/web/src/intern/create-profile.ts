import { PERSONNEL_OBJECT, SUBSETS } from '@italent/domain';
import { ApiError } from '../foundation/client.js';
import { canButton, fieldAccess, type ObjectPermission } from '../foundation/permission-model.js';
import { isBlank, type Values } from '../foundation/forms/values.js';
import { c } from './create-messages.js';

export const profileObject = PERSONNEL_OBJECT;
export const educationObject = SUBSETS.education.objectCode;
const ordinary = [
  'backupMail',
  'mobilePhone',
  'gender',
  'birthday',
  'engName',
  'idType',
  'idNumber',
  'dailyWageStandard',
];
const education: Record<string, string> = {
  educationLevel: 'educationLevel',
  lastSchool: 'school',
  major: 'major',
  graduateDate: 'endDate',
};
export const profileFields = [...ordinary, ...Object.keys(education)];
/** F-322：资料使用档案更新权，教育使用子集创建权；不能借用建档权限或反写列编辑权。 */
export function profileAccess(profile?: ObjectPermission, subset?: ObjectPermission) {
  return (name: string) => {
    const educationField = education[name];
    const permission = educationField ? subset : profile;
    const access = fieldAccess(permission, educationField ?? name);
    const operation = educationField ? 'create' : 'update';
    return {
      visible: access.visible,
      editable:
        access.editable &&
        permission?.dataOperations[operation] === true &&
        canButton(permission, operation, educationField ? 'list' : 'detail') &&
        (!educationField ||
          ['isHighestEducation', 'isMainMajor'].every((key) => permission?.editableFields.includes(key))),
    };
  };
}
/** Ant Form 未填写值为 undefined；先缩小投影集合，避免公共 projectFields 将它变成清空指令。 */
export function providedFields(values: Values, editable: readonly string[], touched: readonly string[]) {
  return editable.filter(
    (name) =>
      !profileFields.includes(name) ||
      (values[name] !== undefined && (name !== 'idType' || !isBlank(values.idNumber) || touched.includes(name))),
  );
}
/** 与 F-322 白名单一致，保留“未提供”与“显式清空”；金额始终是字符串，不经浮点转换。 */
export function createProfile(values: Values): Values {
  return Object.fromEntries(
    profileFields
      .filter((name) => values[name] !== undefined)
      .map((name) => {
        const value = values[name];
        const normalized = typeof value === 'string' ? value.trim() : value;
        return [name, normalized === '' ? null : normalized];
      }),
  );
}
export function validateProfile(values: Values) {
  const profile = createProfile(values);
  if (
    Object.hasOwn(profile, 'graduateDate') &&
    !['educationLevel', 'lastSchool', 'major'].some((name) => Object.hasOwn(profile, name))
  )
    throw new ApiError(400, 'VALIDATION_FAILED', 'fields', c.graduateRequiresEducation);
  const wage = profile.dailyWageStandard;
  if (wage !== undefined && wage !== null && (typeof wage !== 'string' || !/^\d{1,12}(\.\d{1,2})?$/.test(wage)))
    throw new ApiError(400, 'DAILY_WAGE_STANDARD_INVALID', 'fields', c.invalidWage);
}
/** 新建任职没有旧资料基线；409 重读只更换候选版本，不能把明确清空误当未编辑而丢掉。 */
export function retainProfileClears(values: Values, baseline: Values): Values {
  return {
    ...baseline,
    ...Object.fromEntries(Object.entries(createProfile(values)).filter(([, value]) => value === null)),
  };
}
