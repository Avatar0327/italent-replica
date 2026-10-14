import type { FieldAccess } from '../foundation/permission-model.js';
import { formText, kindText, pageText as m } from './messages.js';
export const jobKinds = [
  'layers',
  'grades',
  'level-types',
  'levels',
  'sequences',
  'professional-lines',
  'posts',
  'positions',
] as const;
export type JobKind = (typeof jobKinds)[number];
export const jobObjects: Record<JobKind, string> = {
  layers: 'TenantBase.JobLayer',
  grades: 'TenantBase.JobGrade',
  'level-types': 'TenantBase.JobLevelType',
  levels: 'TenantBase.JobLevel',
  sequences: 'TenantBase.JobSequence',
  'professional-lines': 'TenantBase.JobProfessionalLine',
  posts: 'TenantBase.JobPost',
  positions: 'TenantBase.Position',
};
export interface JobRow {
  id: string;
  revision: number;
  name?: string;
  parents?: Partial<Record<'admin' | 'dotted', { parentId: string | null; sequence?: number | null }>>;
  [field: string]: unknown;
}
export const jobFields: Record<JobKind, string[]> = {
  layers: ['layerLevel'],
  grades: ['grade', 'scoreLow', 'scoreHigh', 'layerId'],
  'level-types': [],
  levels: ['level', 'levelTypeId', 'minGradeId', 'maxGradeId'],
  sequences: ['parentId', 'levelTypeId', 'source', 'externalId'],
  'professional-lines': ['parentId'],
  posts: [
    'sequenceId',
    'professionalLineId',
    'levelTypeId',
    'minLevelId',
    'maxLevelId',
    'minGradeId',
    'maxGradeId',
    'responsibilities',
    'requirements',
    'evaluationScore',
  ],
  positions: [
    'orgId',
    'postId',
    'sequenceId',
    'professionalLineId',
    'levelTypeId',
    'minLevelId',
    'maxLevelId',
    'minGradeId',
    'maxGradeId',
    'workLocation',
    'standardPositionId',
    'adminParent',
    'adminSequence',
    'dottedParent',
    'dottedSequence',
  ],
};
const references: Record<string, string> = {
  layerId: 'layers',
  levelTypeId: 'level-types',
  minGradeId: 'grades',
  maxGradeId: 'grades',
  minLevelId: 'levels',
  maxLevelId: 'levels',
  sequenceId: 'sequences',
  professionalLineId: 'professional-lines',
  orgId: 'org',
  postId: 'posts',
  adminParent: 'positions',
  dottedParent: 'positions',
  standardPositionId: 'positions',
};
/** 引用字段指向的对象；parentId 指向同类对象。'org' 为组织。 */
export function referenceKind(kind: JobKind, field: string): string | undefined {
  return field === 'parentId' ? kind : references[field];
}
interface FieldGate {
  field(name: string): FieldAccess;
}
// 原站各视图列（F-132 对照表）；职层、专业条线未截到，保持原列。在岗人数、胜任力等接口未返回的列不展示。
const listFields: Partial<Record<JobKind, string[]>> = {
  sequences: ['name', 'parentId', 'levelTypeId', 'displayOrder', 'startDate'],
  'level-types': ['name', 'displayOrder', 'startDate'],
  grades: ['grade', 'name', 'layerId', 'scoreHigh', 'scoreLow', 'startDate'],
  levels: ['levelTypeId', 'name', 'level', 'minGradeId', 'maxGradeId'],
  posts: ['code', 'name', 'sequenceId', 'levelTypeId', 'minLevelId', 'maxLevelId'],
  positions: [
    'code',
    'name',
    'postId',
    'orgId',
    'sequenceId',
    'levelTypeId',
    'minLevelId',
    'maxLevelId',
    'displayOrder',
  ],
};
// 原站职务新建弹窗与职位详情的字段顺序：head、traits 为原站所见顺序；others 是原站未出现的已有字段，排在后面不删。
interface JobLayout {
  head: string[];
  traits: string[];
  others: string[];
  extra: { key: string; fields: string[] };
}
const layouts: Partial<Record<JobKind, JobLayout>> = {
  posts: {
    head: ['code', 'name', 'establishedOn', 'sequenceId', 'levelTypeId', 'minLevelId', 'maxLevelId'],
    traits: ['evaluationScore', 'isKey', 'isConfidential', 'displayOrder'],
    others: ['professionalLineId', 'minGradeId', 'maxGradeId'],
    extra: { key: 'duty', fields: ['responsibilities', 'requirements'] },
  },
  positions: {
    head: [
      'code',
      'name',
      'establishedOn',
      'orgId',
      'workLocation',
      'postId',
      'sequenceId',
      'levelTypeId',
      'minLevelId',
      'maxLevelId',
    ],
    traits: ['isKey', 'isConfidential', 'displayOrder'],
    others: ['professionalLineId', 'minGradeId', 'maxGradeId', 'standardPositionId'],
    extra: { key: 'reporting', fields: ['adminParent', 'adminSequence', 'dottedParent', 'dottedSequence'] },
  },
};
// 原站职位表单：上级职位、虚线上级穿插在基本信息里；职位汇报关系只是详情分区。
const positionForm = ['adminParent', 'isKey', 'dottedParent', 'isConfidential', 'displayOrder'];
export function jobLabel(kind: JobKind, field: string, place?: 'form') {
  const own: Record<string, string> = { ...kindText[kind], ...(place === 'form' ? formText[kind] : {}) };
  return own[field] ?? m[field as keyof typeof m] ?? field;
}
export function jobListFields(kind: JobKind, access: FieldGate) {
  const fields = listFields[kind] ?? [
    'code',
    'name',
    ...jobFields[kind].slice(0, 5),
    'enabled',
    'startDate',
    'stopDate',
  ];
  return fields.filter((field) => access.field(field).visible);
}
export function jobFormGroups(kind: JobKind) {
  const layout = layouts[kind];
  if (!layout) {
    const fields = ['name', 'code', ...jobFields[kind], 'displayOrder', 'establishedOn', 'stopDate', 'enabled'];
    return [{ key: 'basic', fields }];
  }
  const { head, traits, others, extra } = layout;
  if (kind === 'positions') {
    const tail = ['adminSequence', 'dottedSequence', 'stopDate', 'enabled'];
    return [{ key: 'basic', fields: [...head, ...positionForm, ...others, ...tail] }];
  }
  return [{ key: 'basic', fields: [...head, ...traits, ...others, 'stopDate', 'enabled'] }, extra];
}
export function jobDetailSections(kind: JobKind, access: FieldGate, values: Record<string, unknown>) {
  const layout = layouts[kind];
  const groups = layout
    ? [
        {
          key: 'basic',
          fields: [...layout.head, ...layout.traits, 'enabled', 'startDate', ...layout.others, 'stopDate'],
        },
        layout.extra,
      ]
    : [
        {
          key: 'basic',
          fields: [
            'name',
            'code',
            ...jobFields[kind],
            'displayOrder',
            'enabled',
            'startDate',
            'stopDate',
            'establishedOn',
          ],
        },
      ];
  return groups
    .map(({ key, fields }) => ({
      key,
      fields: fields.filter((field) => access.field(jobPermissionField(field)).visible && values[field] !== undefined),
    }))
    .filter((section) => section.fields.length);
}
export interface JobCatalogFilters {
  asOf: string;
  page: number;
  pageSize: number;
  name: string;
  enabled: string;
  orgId?: string;
}
/** 无名称查看权时不按名称筛选，避免借筛选结果探测被裁剪的名称。 */
export function jobCatalogQuery(kind: JobKind, filters: JobCatalogFilters, nameVisible = true) {
  const query = new URLSearchParams({
    asOf: filters.asOf,
    page: String(filters.page),
    pageSize: String(filters.pageSize),
    ...(nameVisible && filters.name ? { name: filters.name } : {}),
    ...(filters.enabled ? { enabled: filters.enabled } : { includeDisabled: 'true' }),
    // 接口只有职位支持按所属组织筛选。
    ...(kind === 'positions' && filters.orgId ? { orgId: filters.orgId } : {}),
  });
  return query.toString();
}
/** DEC-465：候选与写入共用时点；无日期编辑权时使用后端默认的租户当天。 */
export function jobTiming(original: JobRow | undefined, selectedDate: string, today: string, access: FieldAccess) {
  if (original) return { asOf: selectedDate, createFields: {} };
  if (access.visible && access.editable) return { asOf: selectedDate, createFields: { startDate: selectedDate } };
  return { asOf: today, createFields: {} };
}

export function jobBody(kind: JobKind, values: Record<string, unknown>, original: JobRow | undefined, date: string) {
  const { adminParent, adminSequence, dottedParent, dottedSequence, ...fields } = values;
  const body: Record<string, unknown> = {};
  const links = { adminParent, adminSequence, dottedParent, dottedSequence };
  if (kind === 'positions') {
    const parents = positionParents(links, original);
    if (parents) body.parents = parents;
  }
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const normalized = normalizeField(key, value);
    if (original && normalized === original[key]) continue;
    body[key] = normalized;
  }
  if (!original && (typeof body.name !== 'string' || !body.name)) throw new Error(m.required);
  if (!original && kind === 'positions' && (!body.orgId || !body.postId)) throw new Error(m.positionRequired);
  if (
    original &&
    (kind === 'posts' || kind === 'positions') &&
    body.sequenceId &&
    body.sequenceId !== original.sequenceId
  )
    body.syncSequenceToAssignments = true;
  // startDate 只由 jobTiming 按字段编辑权提供；省略时由后端按租户当天默认。
  return original ? { ...body, effectiveDate: date } : body;
}

function positionParents(values: Record<string, unknown>, original?: JobRow) {
  const parents = { ...original?.parents };
  let changed = false;
  for (const key of ['admin', 'dotted'] as const) {
    const parent = values[`${key}Parent`];
    const sequence = values[`${key}Sequence`];
    if (parent === undefined && sequence === undefined) continue;
    const next = {
      ...parents[key],
      parentId: parents[key]?.parentId ?? null,
      sequence: parents[key]?.sequence ?? null,
    };
    if (parent !== undefined) next.parentId = typeof parent === 'string' && parent ? parent.toLowerCase() : null;
    if (sequence !== undefined) next.sequence = typeof sequence === 'number' ? sequence : null;
    if (next.parentId !== parents[key]?.parentId || next.sequence !== parents[key]?.sequence) {
      parents[key] = next;
      changed = true;
    }
  }
  return changed ? parents : undefined;
}
export function jobPermissionField(name: string) {
  return ['adminParent', 'adminSequence', 'dottedParent', 'dottedSequence'].includes(name) ? 'parents' : name;
}
export function jobInitialValues(original?: JobRow): Record<string, unknown> {
  if (!original) return { enabled: true, stopDate: '9999-12-31' };
  return {
    ...original,
    adminParent: original.parents?.admin?.parentId,
    adminSequence: original.parents?.admin?.sequence,
    dottedParent: original.parents?.dotted?.parentId,
    dottedSequence: original.parents?.dotted?.sequence,
  };
}

function normalizeField(key: string, value: unknown) {
  if (key.endsWith('Id')) return typeof value === 'string' && value ? value.toLowerCase() : null;
  if (key === 'name' && typeof value === 'string') return value.trim();
  return value;
}
