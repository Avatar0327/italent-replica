import { ORG_DIMENSIONS } from '@italent/domain';
import { z } from 'zod';

export const scopeAppCode = z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,63}$/);
export const scopeOrgRefBody = z.strictObject({
  orgId: z.uuid(),
  dimension: z.enum(ORG_DIMENSIONS).default('admin'),
  includeDescendants: z.boolean(),
});
const orgRanges = z.array(scopeOrgRefBody).max(200);
const defaultScope = z.strictObject({ kind: z.literal('default') });
const mouScope = z.strictObject({ kind: z.literal('mou'), mouId: z.uuid() });
const orgScope = z.strictObject({ kind: z.literal('org_range'), orgRanges });
export const scopeAssignmentBody = z.discriminatedUnion('kind', [defaultScope, mouScope, orgScope]);
const grantScopeFields = { appCode: scopeAppCode, expectedRevision: z.number().int().min(0).max(999999999) };
export const grantScopeBody = z.discriminatedUnion('kind', [
  defaultScope.extend(grantScopeFields),
  mouScope.extend(grantScopeFields),
  orgScope.extend(grantScopeFields),
]);
export const mouBody = z.strictObject({
  code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
  name: z.string().trim().min(1).max(100),
  parentId: z.uuid().nullable().default(null),
  description: z.string().max(500).default(''),
  status: z.enum(['active', 'disabled']).default('active'),
  orgRanges,
});
export type ScopeAssignment = z.infer<typeof scopeAssignmentBody>;
export type GrantScopeInput = z.infer<typeof grantScopeBody>;
export type MouInput = z.infer<typeof mouBody>;
export type OrgRangeInput = z.infer<typeof scopeOrgRefBody>;
