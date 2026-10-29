import { NameOf, useToday } from '../contracts/references.js';
import { cellValue, type Row, type View } from './model.js';
export const refPaths: Record<string, string> = {
  departmentId: '/api/tenant/org/organizations',
  institutionId: '/api/tenant/org/organizations',
  institution: '/api/tenant/org/organizations',
  positionId: '/api/tenant/job/positions',
  postId: '/api/tenant/job/posts',
  levelId: '/api/tenant/job/levels',
  sequenceId: '/api/tenant/job/sequences',
  directManagerId: '/api/tenant/personnel/employees',
  dottedManagerId: '/api/tenant/personnel/employees',
};
export function Cell({ row, field, view }: { row: Row; field: string; view: View }) {
  const today = useToday();
  const path = refPaths[field];
  const id = ['institution', 'institutionId'].includes(field) ? row.institutionId : row.fields?.[field];
  return path ? <NameOf path={path} id={id} asOf={today} /> : <>{cellValue(row, field, view)}</>;
}
