import {
  MODULE_OBJECTS,
  PERSONNEL_OBJECTS,
  PERSONNEL_REQUEST_OBJECT,
  APPROVAL_OBJECTS,
  TALENT_OBJECTS,
  QUALIFICATION_OBJECTS,
  QUALIFICATION_PAGES,
  EVALUATION_OBJECTS,
  EVALUATION_FLOW_OBJECTS,
  TALENT_REVIEW_OBJECTS,
  SUCCESSION_OBJECTS,
  IDP_OBJECTS,
  survey360,
} from '@italent/domain';
import type { AppRoute } from '../foundation/routes.js';

/** DEC-456：应用归属显式登记、编码来自后端共享目录；Position 等实际编码不遵循模块前缀。 */
const directory: Record<AppRoute['id'], readonly { code: string }[]> = {
  org: [MODULE_OBJECTS.organization, MODULE_OBJECTS.establishment],
  job: [
    MODULE_OBJECTS.jobLayer,
    MODULE_OBJECTS.jobGrade,
    MODULE_OBJECTS.jobLevelType,
    MODULE_OBJECTS.jobLevel,
    MODULE_OBJECTS.jobSequence,
    MODULE_OBJECTS.jobProfessionalLine,
    MODULE_OBJECTS.jobPost,
    MODULE_OBJECTS.jobPosition,
  ],
  staff: [
    MODULE_OBJECTS.employee,
    ...PERSONNEL_OBJECTS.filter((object) => object.code !== PERSONNEL_REQUEST_OBJECT),
    MODULE_OBJECTS.contract,
    MODULE_OBJECTS.contractType,
    MODULE_OBJECTS.contractCompany,
  ],
  transfer: [MODULE_OBJECTS.employmentRecord],
  // 这四个分区的目录只记录归属；可见性仍由 navigation.ts 的专用接口决定，不能以对象授权代替本人关系或管理能力。
  approval: APPROVAL_OBJECTS,
  self: [{ code: PERSONNEL_REQUEST_OBJECT }],
  manager: [],
  settings: [
    MODULE_OBJECTS.employmentSettings,
    MODULE_OBJECTS.employmentCustomField,
    MODULE_OBJECTS.contractSettings,
    MODULE_OBJECTS.contractRules,
  ],
  talent: Object.values(TALENT_OBJECTS),
  qualification: [...Object.values(QUALIFICATION_OBJECTS), QUALIFICATION_PAGES],
  evaluation: [...Object.values(EVALUATION_OBJECTS), ...Object.values(EVALUATION_FLOW_OBJECTS)],
  survey360: Object.values(survey360.SURVEY360_OBJECTS),
  'talent-review': Object.values(TALENT_REVIEW_OBJECTS),
  succession: Object.values(SUCCESSION_OBJECTS),
  idp: Object.values(IDP_OBJECTS),
};
export function menuObjects(route: AppRoute): string[] {
  return [
    ...new Set([...(route.objectCode ? [route.objectCode] : []), ...directory[route.id].map((object) => object.code)]),
  ];
}
