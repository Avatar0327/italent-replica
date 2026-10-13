import type { FieldAccess } from '../foundation/permission-model.js';
import { pageText as m } from './messages.js';
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
