import { isUuid, type Tx } from '@italent/db';
import type { CommandResultRegistration } from '../command-result/registry.js';
import type { ModuleScope } from '../permission/module-access.js';
import { requireSchemeWriteScope, SCHEME_PATH, schemeMissing } from './integration-schemes-access.js';
import { readScheme } from './integration-schemes-read.js';
import { requireDeletedSchemeScope } from './integration-schemes.js';

const commands = [
  { commandType: `POST ${SCHEME_PATH}`, operation: 'create', httpStatus: 201 },
  { commandType: `PATCH ${SCHEME_PATH}/:id`, operation: 'update', httpStatus: 200 },
  { commandType: `DELETE ${SCHEME_PATH}/:id`, operation: 'update', httpStatus: 204 },
] as const;

function receipt(body: unknown) {
  const { id, revision } = (body ?? {}) as { id?: string; revision?: number };
  if (typeof id !== 'string' || !isUuid(id) || typeof revision !== 'number' || !Number.isInteger(revision))
    throw schemeMissing();
  return { id, revision };
}

export async function requireSchemeResultScope(
  tx: Tx,
  tenantId: string,
  scope: ModuleScope,
  body: unknown,
  deleted: boolean,
) {
  const { id } = receipt(body);
  if (deleted) await requireDeletedSchemeScope(tx, tenantId, scope, id);
  else await readScheme(tx, tenantId, scope, id);
}

export const INTEGRATION_SCHEME_COMMAND_RESULTS: readonly CommandResultRegistration[] = commands.map(
  ({ commandType, operation, httpStatus }) => ({
    commandType,
    async authorize(tx, deps, ctx, body) {
      const scope = await requireSchemeWriteScope(tx, deps, ctx, operation);
      await requireSchemeResultScope(tx, ctx.tenantId, scope, body, httpStatus === 204);
    },
    project(body) {
      const { id, revision } = receipt(body);
      return { status: 'succeeded', commandType, businessId: id, revision, httpStatus };
    },
  }),
);
