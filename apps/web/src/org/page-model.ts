import { canButton, fieldAccess, type ObjectPermission } from '../foundation/permission-model.js';
import { pageText as m } from './messages.js';
export interface OrgRow {
  id: string;
  revision: number;
  name?: string;
  code?: string;
  enabled?: boolean;
  parents?: Partial<Record<Dimension, { parentId: string | null; sequence?: number | null }>>;
  [field: string]: unknown;
}
export type Dimension = 'admin' | 'business' | 'product';
export interface OrgNode {
  key: string;
  value: string;
  title: string;
  children: OrgNode[];
}
export function organizationTree(rows: OrgRow[], dimension: Dimension): OrgNode[] {
  const nodes = new Map(
    rows.map((row) => [
      row.id,
      {
        key: row.id,
        value: row.id,
        title: row.name ?? m.unavailable,
        children: [] as OrgNode[],
      },
    ]),
  );
  const parents = new Map(rows.map((row) => [row.id, row.parents?.[dimension]?.parentId]));
  const roots: OrgNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id)!;
    const parent = parents.get(row.id);
    const seen = new Set([row.id]);
    let cursor = parent;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = parents.get(cursor);
    }
    if (parent && nodes.has(parent) && !cursor) nodes.get(parent)!.children.push(node);
    else roots.push(node);
  }
  return roots;
}
export function orgChangeBody(original: OrgRow, values: Record<string, unknown>, effectiveDate: string) {
  const { addEmployment, adminParent, businessParent, productParent, ...fields } = values;
  const body: Record<string, unknown> = { effectiveDate };
  for (const [key, raw] of Object.entries(fields)) {
    const value = key === 'name' && typeof raw === 'string' ? raw.trim() : raw;
    if (value !== undefined && value !== original[key]) body[key] = value;
  }
  const parents: OrgRow['parents'] = {};
  for (const [dimension, value] of Object.entries({
    admin: adminParent,
    business: businessParent,
    product: productParent,
  })) {
    const key = dimension as Dimension;
    if (typeof value === 'string' && value.toLowerCase() !== original.parents?.[key]?.parentId) {
      parents[key] = { parentId: value.toLowerCase(), sequence: original.parents?.[key]?.sequence ?? null };
    }
  }
  if (Object.keys(parents).length) body.parents = parents;
  if (body.name !== undefined || parents.admin) {
    if (typeof addEmployment !== 'boolean') throw new Error(m.choiceRequired);
    body.addEmployment = addEmployment;
  }
  return body;
}

export function pageAccess(permission: ObjectPermission | undefined) {
  return {
    readable: !!permission,
    field: (name: string) => fieldAccess(permission, name),
    can: (button: string, level = 'detail') =>
      canButton(permission, button, level) &&
      (!['create', 'update', 'delete'].includes(button) || permission?.dataOperations[button] === true),
  };
}
