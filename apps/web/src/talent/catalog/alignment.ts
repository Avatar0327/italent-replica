import type { Resource } from './types.js';
import { m } from './messages.js';

type Column = { label: string; width: number; permission?: string; unavailable?: boolean };
/** R3a：仅定义已取证的呈现；缺契约的列保留空值，不伪造业务数据。 */
export function alignment(resource: Resource): Record<string, Column> {
  if (resource.module === 'talent') {
    const audit = {
      createdBy: { label: m.createdBy, width: 189 },
      createdAt: { label: m.createdAt, width: 217 },
    };
    if (resource.key === 'criteria')
      return {
        name: { label: m.name, width: 199 },
        categoryId: { label: m.category, width: 199 },
        enabled: { label: m.status, width: 199 },
        ...audit,
      };
    if (resource.key === 'libraries')
      return {
        name: { label: m.libraryName, width: 168 },
        description: { label: m.libraryDescription, width: 168, permission: 'name', unavailable: true },
        enabled: { label: m.status, width: 168 },
        type: { label: m.type, width: 168 },
        createdBy: { ...audit.createdBy, width: 158 },
        createdAt: { ...audit.createdAt, width: 186 },
      };
    if (resource.key === 'criterion-categories')
      return {
        name: { label: m.categoryName, width: 199 },
        description: { label: m.description, width: 199, permission: 'name', unavailable: true },
        enabled: { label: m.status, width: 199, permission: 'name', unavailable: true },
        ...audit,
      };
  } else {
    const jobs = {
      jobLinkType: { label: m.jobLinkType, width: 172 },
      jobLinks: { label: m.jobLinks, width: 172 },
    };
    if (resource.key === 'categories' || resource.key === 'levels')
      return {
        name: { label: m.name, width: 172 },
        code: { label: m.code, width: 172 },
        ...(resource.key === 'categories'
          ? { classId: { label: m.categoryClass, width: 172 } }
          : { displayOrder: { label: m.order, width: 172 }, layerId: { label: m.layer, width: 172 } }),
        ...jobs,
      };
    if (resource.key === 'standards')
      return {
        name: { label: m.name, width: 172 },
        classId: { label: m.categoryClass, width: 172, permission: 'categoryId' },
        categoryId: { label: m.employmentCategory, width: 172 },
        effectiveDate: { label: m.effectiveDate, width: 110, permission: 'name', unavailable: true },
        enabled: { label: m.status, width: 172 },
      };
    if (resource.key === 'targets')
      return Object.fromEntries(
        [m.name, m.code, m.targetType, m.targetDescription, m.order, m.status].map((label, index) => [
          resource.columns[index]!,
          { label, width: 133 },
        ]),
      );
    if (resource.key === 'grade-schemes')
      return { name: { label: m.name, width: 531 }, description: { label: m.schemeDescription, width: 531 } };
  }
  return {};
}
export const fullPageDetail = (resource: Resource) => ['criteria', 'standards'].includes(resource.key);
