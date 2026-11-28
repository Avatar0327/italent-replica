import { isUuid } from '@italent/db';
import { AppError } from '../../errors.js';
import type { CommandResultRegistration } from '../command-result/registry.js';
import { authorizeInTransaction } from '../permission/module-access.js';
import { HANDBOOK_PATH, requireHandbookWrite, requireWelcomeWrite, WELCOME_PATH } from './welcome-access.js';
import { readHandbook } from './handbook.js';
import { readWelcomeLetter } from './welcome-letters.js';

function receipt(body: unknown) {
  const { id, revision } = (body ?? {}) as Partial<Record<'id' | 'revision', unknown>>;
  if (typeof id !== 'string' || !isUuid(id) || typeof revision !== 'number' || !Number.isInteger(revision))
    throw new AppError('NOT_FOUND', '欢迎信或手册配置回执不存在');
  return { id, revision };
}

const OPERATIONS = [
  { suffix: '', operation: 'create', httpStatus: 201, method: 'POST' },
  { suffix: '/:id', operation: 'update', httpStatus: 200, method: 'PATCH' },
  { suffix: '/:id', operation: 'update', httpStatus: 204, method: 'DELETE' },
] as const;

const RESOURCES = [
  { path: WELCOME_PATH, requireWrite: requireWelcomeWrite, read: readWelcomeLetter },
  { path: HANDBOOK_PATH, requireWrite: requireHandbookWrite, read: readHandbook },
] as const;

export const WELCOME_COMMAND_RESULTS: readonly CommandResultRegistration[] = RESOURCES.flatMap((resource) =>
  OPERATIONS.map(({ suffix, operation, httpStatus, method }) => {
    const commandType = `${method} ${resource.path}${suffix}`;
    return {
      commandType,
      async authorize(tx, deps, ctx, body) {
        await resource.requireWrite(authorizeInTransaction(deps.authorize, tx), ctx, operation);
        if (httpStatus !== 204) await resource.read(tx, ctx.tenantId, receipt(body).id);
      },
      project(body) {
        const { id, revision } = receipt(body);
        return { status: 'succeeded', commandType, businessId: id, revision, httpStatus };
      },
    } satisfies CommandResultRegistration;
  }),
);
