import {
  APP_OBJECT_DIRECTORY,
  APPROVAL_OBJECTS,
  EMPLOYEE_PAGES,
  EMPLOYEE_SELF_SERVICE_CODE,
  EVALUATION_OBJECTS,
  EVALUATION_FLOW_OBJECTS,
  IDP_OBJECTS,
  MODULE_OBJECTS,
  PAGE_CATALOG,
  PAGE_CARRIERS,
  PERSONNEL_OBJECTS,
  QUALIFICATION_OBJECTS,
  SUCCESSION_OBJECTS,
  TALENT_OBJECTS,
  TALENT_REVIEW_OBJECTS,
  survey360,
  objectCatalogDigest,
  type PageDefinition,
} from '@italent/domain';
import type { Values } from '../foundation/forms/store.js';
import type { ProfileDetail } from './object-dialog-model.js';
import { pm } from './page-messages.js';

export function pageState(profile: ProfileDetail, page: PageDefinition) {
  const carrier = profile.objects.find((o) => o.objectCode === page.carrierObject);
  const implicit =
    !carrier &&
    profile.code === EMPLOYEE_SELF_SERVICE_CODE &&
    (EMPLOYEE_PAGES as readonly string[]).includes(page.pageCode);
  return {
    granted: implicit || !!carrier?.buttons.some((b) => b.buttonCode === page.pageCode && b.level === 'app_page'),
    implicit,
    missingApp: !profile.apps.includes(page.appCode),
  };
}
export function pageValues(profile: ProfileDetail, objectCode: string): Values {
  const definition = PAGE_CARRIERS.find((o) => o.code === objectCode)!;
  const digest = objectCatalogDigest(definition);
  const stored = profile.objects.find((o) => o.objectCode === objectCode);
  if (stored && stored.catalogDigest !== digest) throw new Error(pm.catalogChanged);
  return {
    catalogDigest: stored?.catalogDigest ?? digest,
    ...Object.fromEntries(
      PAGE_CATALOG.filter((p) => p.carrierObject === objectCode).map((page) => [
        page.pageCode,
        pageState(profile, page).granted,
      ]),
    ),
  };
}
export function pageBody(values: Values, objectCode: string) {
  return {
    fields: [],
    buttons: PAGE_CATALOG.filter((p) => p.carrierObject === objectCode && values[p.pageCode] === true).map((p) => ({
      buttonCode: p.pageCode,
      level: 'app_page' as const,
    })),
    dataOperations: { create: false, update: false, delete: false },
    catalogDigest: values.catalogDigest,
  };
}

// 与 APP_OBJECT_DIRECTORY 使用同一批域层定义取 application，不从对象编码猜所属应用。
const definitions = [
  ...Object.values(MODULE_OBJECTS),
  ...APPROVAL_OBJECTS,
  ...PERSONNEL_OBJECTS,
  ...Object.values(QUALIFICATION_OBJECTS),
  ...PAGE_CARRIERS,
  ...Object.values(EVALUATION_OBJECTS),
  ...Object.values(EVALUATION_FLOW_OBJECTS),
  ...Object.values(IDP_OBJECTS),
  ...Object.values(SUCCESSION_OBJECTS),
  ...Object.values(TALENT_OBJECTS),
  ...Object.values(TALENT_REVIEW_OBJECTS),
  ...Object.values(survey360.SURVEY360_OBJECTS),
];
const appOf = new Map(definitions.map((o) => [o.code, o.application]));
export function profileMenuGroups(profile: ProfileDetail) {
  const held = new Set(profile.objects.map((o) => o.objectCode));
  const ordered = [...new Set(Object.values(APP_OBJECT_DIRECTORY).flat())];
  return profile.apps.map((appCode) => ({
    appCode,
    objects: ordered.filter((code) => appOf.get(code) === appCode && held.has(code)),
  }));
}
