import { QUALIFICATION_PAGES } from '../qualification/catalog.js';
import type { ObjectDefinition } from './object-permission.js';
import { pageNames } from './page-messages.js';

export interface PageDefinition {
  readonly pageCode: string;
  readonly appCode: string;
  readonly name: string;
  readonly carrierObject: string;
}

/**
 * 载体沿用 qualification/catalog.ts 的 QUALIFICATION_PAGES（F-474-9a §3.1）。
 * 首版只登记有运行时闸门的页面（DEC-896 U3）。目录与载体双向一致由 AC-PGP-F474-01 守卫。
 */
export const PAGE_CATALOG: readonly PageDefinition[] = [
  {
    pageCode: 'EmployeeDevelopmentChannel',
    appCode: QUALIFICATION_PAGES.application,
    name: pageNames.employeeDevelopmentChannel,
    carrierObject: QUALIFICATION_PAGES.code,
  },
];
export const PAGE_CARRIERS: readonly ObjectDefinition[] = [QUALIFICATION_PAGES];
export const isPageCarrier = (objectCode: string) => PAGE_CATALOG.some((page) => page.carrierObject === objectCode);
