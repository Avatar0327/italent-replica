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
  [field: string]: unknown;
}
export function jobBody(kind: JobKind, values: Record<string, unknown>, original: JobRow | undefined, date: string) {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    body[key] = key.endsWith('Id')
      ? typeof value === 'string' && value
        ? value.toLowerCase()
        : null
      : key === 'name' && typeof value === 'string'
        ? value.trim()
        : value;
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
  return { ...body, [original ? 'effectiveDate' : 'startDate']: date };
}
