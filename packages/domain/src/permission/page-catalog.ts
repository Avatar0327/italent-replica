import type { ObjectDefinition } from './object-permission.js';
import { pageNames } from './page-messages.js';

export interface PageDefinition {
  readonly pageCode: string;
  readonly appCode: string;
  readonly name: string;
  readonly carrierObject: string;
}

/** F-474-9a §3.1：载体只承载页面按钮，不进模块 *_OBJECTS 的全部对象遍历。 */
export const QUALIFICATION_PAGES: ObjectDefinition = {
  code: 'Qualification.Pages',
  application: 'Qualification',
  fields: [],
  buttons: [{ code: 'EmployeeDevelopmentChannel', level: 'app_page' }],
};

/** 首版只登记有运行时闸门的页面（DEC-896 U3）。目录与载体双向一致由 AC-PGP-F474-01 守卫。 */
export const PAGE_CATALOG: readonly PageDefinition[] = [
  {
    pageCode: 'EmployeeDevelopmentChannel',
    appCode: 'Qualification',
    name: pageNames.employeeDevelopmentChannel,
    carrierObject: QUALIFICATION_PAGES.code,
  },
];
export const PAGE_CARRIERS: readonly ObjectDefinition[] = [QUALIFICATION_PAGES];
export const isPageCarrier = (objectCode: string) => PAGE_CATALOG.some((page) => page.carrierObject === objectCode);
