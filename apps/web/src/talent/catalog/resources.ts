import type { Resource } from './types.js';
import { m } from './messages.js';
const base = '/api/tenant/talent/';
export const talentResources: Resource[] = [
  {
    key: 'libraries',
    title: m.library,
    module: 'talent',
    object: 'TalentCenter.DimensionLibrary',
    owner: 'library',
    form: 'library',
    note: 'talent-library',
    columns: ['name', 'type', 'enabled', 'displayOrder'],
    fields: [
      { key: 'name', label: m.name, required: true },
      { key: 'type', label: m.type, kind: 'select', required: true, createOnly: true, options: m.typeOptions },
      { key: 'displayOrder', label: m.order, kind: 'number' },
      { key: 'enabled', label: m.status, kind: 'boolean' },
    ],
  },
  {
    key: 'dimensions',
    title: m.target,
    module: 'talent',
    object: 'TalentCenter.Dimension',
    owner: 'dimension',
    form: 'dimension',
    note: 'talent-dimension',
    columns: ['name', 'code', 'definition', 'enabled'],
    fields: [
      { key: 'name', label: m.name, required: true },
      { key: 'code', label: m.code, required: true, createOnly: true, max: 50 },
      {
        key: 'libraryId',
        label: m.library,
        kind: 'select',
        required: true,
        createOnly: true,
        source: `${base}libraries`,
      },
      { key: 'definition', label: m.definition, kind: 'text' },
      { key: 'displayOrder', label: m.order, kind: 'number' },
      { key: 'enabled', label: m.status, kind: 'boolean' },
    ],
  },
  {
    key: 'criteria',
    title: m.criterion,
    module: 'talent',
    object: 'TalentCenter.TalentCriterion',
    owner: 'criterion',
    form: 'criterion',
    note: 'talent-criterion',
    columns: ['name', 'categoryId', 'enabled'],
    fields: [
      { key: 'name', label: m.name, required: true },
      { key: 'categoryId', label: m.category, kind: 'select', required: true, source: `${base}criterion-categories` },
      { key: 'dimensions', label: m.dimensions, kind: 'references', source: `${base}candidates/dimensions` },
      { key: 'enabled', label: m.status, kind: 'boolean' },
      ...(['ability', 'potential', 'experience', 'achievement'] as const).map((type) => ({
        key: `${type}Note`,
        label: m[type],
        kind: 'text' as const,
      })),
    ],
  },
];
