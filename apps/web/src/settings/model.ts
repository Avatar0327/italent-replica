import { ORG_DIMENSIONS, type OrgDimension } from '@italent/domain';
import { ApiError, type PageRequest } from '../foundation/client.js';
import { m } from './messages.js';
export interface AdminMenu {
  code: string;
  path?: string;
  editable: boolean;
}
export const settingsPages = [
  { code: 'users.internal', title: m.users },
  { code: 'users.all', title: m.all },
  { code: 'users.external', title: m.external },
  { code: 'permission.profiles', title: m.profiles },
  { code: 'permission.user_grant', title: m.grants },
  { code: 'permission.mous', title: m.mous },
  { code: 'audit.business', title: m.audit },
];
export function settingsAccess(menus: readonly AdminMenu[], code: string) {
  const menu = menus.find((item) => item.code === code);
  return { visible: !!menu, editable: menu?.editable === true };
}
export const base = '/api/tenant/permission';
export function listPath(code: string, page: PageRequest) {
  const paging = `limit=${page.pageSize}&offset=${(page.page - 1) * page.pageSize}`;
  if (code.startsWith('users.')) return `${base}/users?type=${code.split('.')[1]}&${paging}`;
  const resource = { 'permission.profiles': 'profiles', 'permission.user_grant': 'grants', 'permission.mous': 'mous' }[
    code
  ];
  return `${base}/${resource}${resource === 'mous' ? `?${paging}` : ''}`;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validId(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}
export function userInput(values: Record<string, unknown>) {
  const displayName = String(values.displayName ?? '').trim();
  const email = String(values.email ?? '').trim();
  const businessIdentity = String(values.businessIdentity ?? '').trim();
  if (
    !displayName ||
    displayName.length > 100 ||
    !businessIdentity ||
    businessIdentity.length > 50 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 320 ||
    values.userType === 'internal'
  )
    throw new ApiError(400, 'VALIDATION_ERROR', 'fields', m.invalid);
  return { displayName, email, businessIdentity, userType: 'external' };
}
export interface OrgRange {
  orgId: string;
  dimension: OrgDimension;
  includeDescendants: boolean;
}
export interface Scope {
  userId: string;
  appCode: string;
  kind: 'default' | 'mou' | 'org_range';
  mouId: string | null;
  revision: number;
  orgRanges: OrgRange[];
}
export function scopeInput(values: Record<string, unknown>) {
  if (values.kind === 'default') return { kind: 'default' };
  if (values.kind === 'mou' && validId(values.mouId)) return { kind: 'mou', mouId: values.mouId };
  if (
    values.kind === 'org_range' &&
    Array.isArray(values.orgRanges) &&
    values.orgRanges.length <= 200 &&
    values.orgRanges.every(
      (r: OrgRange) =>
        validId(r.orgId) && ORG_DIMENSIONS.includes(r.dimension) && typeof r.includeDescendants === 'boolean',
    )
  )
    return { kind: 'org_range', orgRanges: values.orgRanges as OrgRange[] };
  throw new ApiError(400, 'VALIDATION_ERROR', 'fields', m.invalid);
}
export interface User {
  userId: string;
  displayName: string;
  email: string;
  userType: string | null;
  businessIdentity: string | null;
  membershipStatus: string;
  membershipRevision: number;
  employeeId: string | null;
}
export interface Profile {
  id: string;
  name: string;
  code: string;
  description: string;
  source: string;
  apps: string[];
  revision: number;
  autoHeld: boolean;
  objects?: {
    objectCode: string;
    fields: { fieldCode: string; view: boolean; edit: boolean }[];
    buttons: { buttonCode: string; level: string }[];
  }[];
}
export interface Grant {
  id: string;
  userId: string;
  profileId: string;
  source: string;
  status: string;
  revision: number;
}
export interface LicenseOverage {
  code: 'LICENSE_OVERAGE';
  licenseType: string;
  quota: number;
  used: number;
  balance: number;
}
export interface GrantReceipt {
  licenseOverage: LicenseOverage | null;
}
export interface Mou {
  id: string;
  name: string;
  code: string;
  description: string;
  status: string;
  parentId: string | null;
  revision: number;
  orgRanges?: OrgRange[];
}
export interface Audit {
  id: string;
  occurredAt: string;
  operator: { name: string };
  operationLabel: string;
  objectLabel: string;
  objectId: string | null;
  content: string;
  sourceAction: string | null;
  traceId: string | null;
  changes?: { field: string; before: unknown; after: unknown }[];
  snapshot?: unknown;
}
