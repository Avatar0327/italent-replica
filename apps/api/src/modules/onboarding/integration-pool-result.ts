import { isUuid } from '@italent/db';
import { AppError } from '../../errors.js';
import type { CommandResultRegistration } from '../command-result/registry.js';
import { authorizeInTransaction } from '../permission/module-access.js';
import { INTEGRATION_POOL_PATH, requirePoolWrite } from './integration-pool-access.js';
import { readIntegrationPoolTask } from './integration-pool.js';

const POOL_RESULT_TYPES = [
  { commandType: `POST ${INTEGRATION_POOL_PATH}`, operation: 'create', httpStatus: 201 },
  { commandType: `PATCH ${INTEGRATION_POOL_PATH}/:id`, operation: 'update', httpStatus: 200 },
  { commandType: `DELETE ${INTEGRATION_POOL_PATH}/:id`, operation: 'update', httpStatus: 204 },
] as const;

function receipt(body: unknown) {
  const { id, revision } = (body ?? {}) as Partial<Record<'id' | 'revision', unknown>>;
  if (typeof id !== 'string' || !isUuid(id) || typeof revision !== 'number' || !Number.isInteger(revision))
    throw new AppError('NOT_FOUND', '融入任务配置回执不存在');
  return { id, revision };
}

export const INTEGRATION_POOL_COMMAND_RESULTS: readonly CommandResultRegistration[] = POOL_RESULT_TYPES.map(
  ({ commandType, operation, httpStatus }) => ({
    commandType,
    async authorize(tx, deps, ctx, body) {
      await requirePoolWrite(authorizeInTransaction(deps.authorize, tx), ctx, operation);
      if (httpStatus !== 204) await readIntegrationPoolTask(tx, ctx.tenantId, receipt(body).id);
    },
    project(body) {
      const { id, revision } = receipt(body);
      return { status: 'succeeded', commandType, businessId: id, revision, httpStatus };
    },
  }),
);
