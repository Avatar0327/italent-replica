import {
  MODULE_OBJECTS,
  TALENT_OBJECTS,
  QUALIFICATION_OBJECTS,
  EVALUATION_OBJECTS,
  EVALUATION_FLOW_OBJECTS,
  TALENT_REVIEW_OBJECTS,
  SUCCESSION_OBJECTS,
  IDP_OBJECTS,
  survey360,
} from '@italent/domain';
import type { AppRoute } from '../foundation/routes.js';

/** 缺少应用菜单接口时复用后端共享目录的应用归属，不用“拥有首个对象”推断整个应用。 */
const directory: Record<string, readonly { code: string }[]> = {
  job: Object.values(MODULE_OBJECTS).filter((object) => object.code.startsWith('TenantBase.Job')),
  talent: Object.values(TALENT_OBJECTS),
  qualification: Object.values(QUALIFICATION_OBJECTS),
  evaluation: [...Object.values(EVALUATION_OBJECTS), ...Object.values(EVALUATION_FLOW_OBJECTS)],
  survey360: Object.values(survey360.SURVEY360_OBJECTS),
  'talent-review': Object.values(TALENT_REVIEW_OBJECTS),
  succession: Object.values(SUCCESSION_OBJECTS),
  idp: Object.values(IDP_OBJECTS),
};
export function menuObjects(route: AppRoute): string[] {
  return [
    ...new Set([
      ...(route.objectCode ? [route.objectCode] : []),
      ...(directory[route.id] ?? []).map((object) => object.code),
    ]),
  ];
}
