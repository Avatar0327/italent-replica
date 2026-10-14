import type { Resource } from '../talent/catalog/types.js';
import { m } from '../talent/catalog/messages.js';
import { q } from './messages.js';
const base = '/api/tenant/qualification/';
export const qualificationResources: Resource[] = [
  {
    // F-141（DEC-500）补登记的任职分类维护页：字段取自后端契约（category-classes）；原站该页的列与交互证据不足（未验证），
    // 复用同一套目录页，不自创交互。上级分类建后不可改（后端 categoryClassPatch 不收 parentId）。
    key: 'category-classes',
    title: q.categoryClasses,
    module: 'qualification',
    object: 'Qualification.EmploymentCategoryClassify',
    owner: 'categoryClass',
    note: 'qualification-category-class',
    columns: ['name', 'code', 'parentId', 'displayOrder', 'enabled'],
    fields: [
      { key: 'name', label: m.name, required: true },
      { key: 'code', label: m.code, max: 50 },
      {
        key: 'parentId',
        label: q.parentClass,
        kind: 'select',
        nullable: true,
        createOnly: true,
        source: `${base}category-classes`,
      },
      { key: 'displayOrder', label: m.order, kind: 'number' },
      { key: 'enabled', label: m.status, kind: 'boolean' },
      { key: 'publicDown', label: q.publicDown, kind: 'boolean' },
    ],
  },
  {
    key: 'categories',
    title: q.categories,
    module: 'qualification',
    object: 'Qualification.EmploymentCategory',
    owner: 'category',
    note: 'qualification-category',
    columns: ['name', 'code', 'classId', 'enabled'],
    fields: [
      { key: 'name', label: m.name, required: true },
      { key: 'code', label: m.code, max: 50 },
      {
        key: 'classId',
        label: q.class,
        kind: 'select',
        required: true,
        createOnly: true,
        source: `${base}category-classes`,
      },
      { key: 'enabled', label: m.status, kind: 'boolean' },
      { key: 'publicDown', label: q.publicDown, kind: 'boolean' },
    ],
  },
  {
    key: 'levels',
    title: q.levels,
    module: 'qualification',
    object: 'Qualification.EmploymentLevel',
    owner: 'level',
    note: 'qualification-level',
    columns: ['name', 'code', 'displayOrder', 'layerId', 'enabled'],
    fields: [
      { key: 'name', label: m.name, required: true },
      { key: 'code', label: m.code, max: 50 },
      { key: 'displayOrder', label: m.order, kind: 'number' },
      { key: 'layerId', label: q.layer, kind: 'select', nullable: true, source: `${base}layers` },
      { key: 'enabled', label: m.status, kind: 'boolean' },
      { key: 'publicDown', label: q.publicDown, kind: 'boolean' },
    ],
  },
  {
    key: 'standards',
    title: q.standards,
    module: 'qualification',
    object: 'Qualification.QualificationStandard',
    note: 'qualification-standard',
    columns: ['name', 'categoryId', 'enabled'],
    fields: [
      { key: 'name', label: m.name, required: true },
      {
        key: 'categoryId',
        label: q.category,
        kind: 'select',
        required: true,
        createOnly: true,
        source: `${base}categories?enabled=true`,
      },
      {
        key: 'levelIds',
        label: q.levelsRange,
        kind: 'select',
        required: true,
        createOnly: true,
        multiple: true,
        source: `${base}levels?enabled=true`,
      },
      { key: 'details', label: q.targets, kind: 'targets', source: `${base}targets?enabled=true` },
      { key: 'enabled', label: m.status, kind: 'boolean' },
    ],
  },
];
