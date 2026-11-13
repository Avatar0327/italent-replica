import { lazyPage, type ModulePages } from '../foundation/page-registry.js';
import { m } from './messages.js';

export const pages: ModulePages = {
  entries: [
    {
      id: 'custom-field-definitions',
      app: 'settings',
      label: m.title,
      group: 'settings',
      objectCode: 'TenantBase.EmploymentCustomField',
      page: lazyPage('CustomFieldDefinitionsPage', () => import('./CustomFieldDefinitionsPage.js')),
    },
  ],
};
