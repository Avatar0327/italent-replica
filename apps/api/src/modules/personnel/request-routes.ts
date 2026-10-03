import { withTenant } from '@italent/db';
import { PERSONNEL_REQUEST_OBJECT, SUBSETS } from '@italent/domain';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { revision, uuidParam } from '../job/context.js';
import { authorizeInTransaction, resolveModuleScope } from '../permission/module-access.js';
import { access, authorize, preflight, requirePerson, trim } from './access.js';
import { createChange, loadChange, requireSelf } from './change-requests.js';
import { body, safe, write } from './http.js';
import { parse, subsetInput, subsetKind } from './validation.js';

const base = '/api/tenant/personnel/change-requests';
const requestSchema = z
  .object({
    employeeId: z.uuid(),
    subset: z.string(),
    recordId: z.uuid().optional(),
    targetRevision: z.number().int().nonnegative().optional(),
    values: z.record(z.string(), z.unknown()),
  })
  .strict();
export function registerChangeRequestRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post(base, (c) =>
    safe(async () => {
      const raw = parse(requestSchema, await body(c));
      const kind = subsetKind(raw.subset);
      const input = { ...raw, subset: kind, values: subsetInput(kind, raw.values, true) };
      const { values, ...metadata } = input;
      const ctx = await access(c, deps, PERSONNEL_REQUEST_OBJECT, 'create', metadata, 'submit', revision(c));
      const objectCode = SUBSETS[kind].objectCode;
      const operation = raw.recordId ? 'update' : 'create';
      // Patch fields are evaluated against the target object's catalog, never the values container.
      await authorize(deps.authorize, { ...ctx, objectCode }, operation, values);
      const scope = await resolveModuleScope(deps, ctx, undefined, objectCode);
      const target = { ...ctx, objectCode, scope, ...(input.recordId ? { targetId: input.recordId } : {}) };
      await preflight(deps, target, input.employeeId);
      await withTenant(deps.db, ctx.tenantId, (tx) => requireSelf(tx, ctx, input.employeeId));
      return write(
        c,
        deps,
        ctx,
        input.employeeId,
        'create',
        metadata,
        async (tx, ctx) => {
          await authorize(authorizeInTransaction(deps.authorize, tx), { ...ctx, objectCode }, operation, values);
          await requirePerson(tx, target, input.employeeId);
          return createChange(tx, ctx, input);
        },
        'submit',
        input,
      );
    }),
  );
  router.get(`${base}/:id`, (c) =>
    safe(async () => {
      const ctx = await access(c, deps, PERSONNEL_REQUEST_OBJECT, 'view');
      const result = await withTenant(deps.db, ctx.tenantId, async (tx) => {
        const row = await loadChange(tx, ctx, uuidParam(c));
        await requireSelf(tx, ctx, String(row.employeeId));
        return row;
      });
      await preflight(deps, ctx, String(result.employeeId));
      // Approval-node disclosure is R1-T07. Generic request metadata never exposes an untrimmed patch.
      return c.json(await trim(deps, ctx, PERSONNEL_REQUEST_OBJECT, result));
    }),
  );
}
