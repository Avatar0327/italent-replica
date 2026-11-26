import { withTenant, type Tx } from '@italent/db';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { runCommand, type CommandResult } from '../../commands.js';
import { AppError } from '../../errors.js';
import { policedSub } from '../../route-policy/index.js';
import type { TenantRouteDeps, TenantRouteModule } from '../../routes.js';
import { tenantOf, type TenantContext, type TenantEnv } from '../../tenant-context.js';
import { pageQuery, parseBody, revision, uuidParam } from '../job/context.js';
import { authorizeInTransaction } from '../permission/module-access.js';
import {
  archiveHandbook,
  createHandbook,
  handbookView,
  listHandbooks,
  previewHandbook,
  readHandbook,
  updateHandbook,
} from './handbook.js';
import {
  handbookAvailableActions,
  requireHandbookView,
  requireHandbookWrite,
  requireWelcomeView,
  requireWelcomeWrite,
  welcomeAvailableActions,
} from './welcome-access.js';
import { handbookCreateBody, handbookPatchBody, welcomeCreateBody, welcomePatchBody } from './welcome-input.js';
import {
  archiveWelcomeLetter,
  createWelcomeLetter,
  listWelcomeLetters,
  previewWelcomeLetter,
  readWelcomeLetter,
  updateWelcomeLetter,
  welcomeLetterView,
  type SettingsContext,
} from './welcome-letters.js';
import { WELCOME_POLICIES } from './welcome-policy.js';
import { previewBody } from './welcome-preview.js';

type Ctx = Context<TenantEnv>;
type Operation = 'create' | 'update';
type Check = (tx: Tx, ctx: TenantContext, operation: Operation) => Promise<void>;
const emptyDeleteBody = z.strictObject({});

function listQuery(c: Ctx) {
  const enabled = c.req.query('enabled');
  const archived = c.req.query('archived');
  const flag = (value: string | undefined) => value === undefined || value === 'true' || value === 'false';
  if (!flag(enabled) || !flag(archived)) throw new AppError('VALIDATION_FAILED', '启停或归档筛选不合法');
  return {
    ...pageQuery(c),
    enabled: enabled === undefined ? undefined : enabled === 'true',
    archived: archived === 'true',
  };
}

const settingsContext = (
  c: Ctx,
  deps: TenantRouteDeps,
  expectedRevision: number,
  commandId: string,
): SettingsContext => ({
  ...tenantOf(c),
  now: deps.clock(),
  expectedRevision,
  commandId,
});

/** 写入口：命令前后各复核一次设置权；重放前也复核，撤权后不再回放。 */
async function settingsWrite(
  c: Ctx,
  deps: TenantRouteDeps,
  check: Check,
  operation: Operation,
  prepare: (expectedRevision: number) => Promise<{
    input: unknown;
    execute: (tx: Tx, commandId: string) => Promise<CommandResult>;
  }>,
) {
  const tenant = tenantOf(c);
  await withTenant(deps.db, tenant.tenantId, (tx) => check(tx, tenant, operation));
  const expectedRevision = revision(c);
  const { input, execute } = await prepare(expectedRevision);
  return runCommand(deps.db, tenant, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, revision: expectedRevision, input },
    guard: { before: (tx) => check(tx, tenant, operation) },
    execute,
  });
}

/** 校验写在各自入口内（不用回调参数），F-039 探测才观测得到设置权与字段操作权。 */
const welcomeWrite = (
  c: Ctx,
  deps: TenantRouteDeps,
  operation: Operation,
  prepare: Parameters<typeof settingsWrite>[4],
) =>
  settingsWrite(
    c,
    deps,
    (tx, ctx, op) => requireWelcomeWrite(authorizeInTransaction(deps.authorize, tx), ctx, op),
    operation,
    prepare,
  );
const handbookWrite = (
  c: Ctx,
  deps: TenantRouteDeps,
  operation: Operation,
  prepare: Parameters<typeof settingsWrite>[4],
) =>
  settingsWrite(
    c,
    deps,
    (tx, ctx, op) => requireHandbookWrite(authorizeInTransaction(deps.authorize, tx), ctx, op),
    operation,
    prepare,
  );

function writeResponse(c: Ctx, result: CommandResult) {
  c.header('ETag', `"${(result.body as { revision: number }).revision}"`);
  return c.json(result.body, result.status);
}

type Module = Hono<TenantEnv>;
type Read = <T>(
  c: Ctx,
  body: (tx: Tx, tenant: TenantContext, authorize: ReturnType<typeof authorizeInTransaction>) => Promise<T>,
) => Promise<T>;

function welcomeRoutes(module: Module, deps: TenantRouteDeps, read: Read) {
  // ---- 欢迎信 ----------------------------------------------------------------------------------------------
  module.get('/welcome-letters', (c) =>
    read(c, async (tx, tenant, authorize) => {
      await requireWelcomeView(authorize, tenant);
      const rows = await listWelcomeLetters(tx, tenant.tenantId, listQuery(c));
      const availableActions = await welcomeAvailableActions(authorize, tenant, 'create');
      return c.json({ items: rows.map(welcomeLetterView), availableActions });
    }),
  );
  module.get('/welcome-letters/:id', (c) =>
    read(c, async (tx, tenant, authorize) => {
      const id = uuidParam(c);
      await requireWelcomeView(authorize, tenant);
      const row = await readWelcomeLetter(tx, tenant.tenantId, id);
      const availableActions = await welcomeAvailableActions(authorize, tenant, 'update');
      c.header('ETag', `"${row.revision}"`);
      return c.json({ ...welcomeLetterView(row), availableActions });
    }),
  );
  module.post('/welcome-letters', async (c) => {
    const result = await welcomeWrite(c, deps, 'create', async (expectedRevision) => {
      const input = await parseBody(c, welcomeCreateBody);
      return {
        input,
        execute: async (tx, commandId) => ({
          status: 201,
          body: await createWelcomeLetter(tx, settingsContext(c, deps, expectedRevision, commandId), input),
        }),
      };
    });
    return writeResponse(c, result);
  });
  module.patch('/welcome-letters/:id', async (c) => {
    const id = uuidParam(c);
    const result = await welcomeWrite(c, deps, 'update', async (expectedRevision) => {
      const input = await parseBody(c, welcomePatchBody);
      return {
        input,
        execute: async (tx, commandId) => ({
          status: 200,
          body: await updateWelcomeLetter(tx, settingsContext(c, deps, expectedRevision, commandId), id, input),
        }),
      };
    });
    return writeResponse(c, result);
  });
  module.delete('/welcome-letters/:id', async (c) => {
    const id = uuidParam(c);
    await welcomeWrite(c, deps, 'update', async (expectedRevision) => {
      if (c.req.raw.body !== null && c.req.header('content-length') !== '0') await parseBody(c, emptyDeleteBody);
      return {
        input: null,
        execute: async (tx, commandId) => ({
          // DEC-983：归档。命令台账存最小回执，HTTP 首次与重放均返回无正文的 204。
          status: 200,
          body: await archiveWelcomeLetter(tx, settingsContext(c, deps, expectedRevision, commandId), id),
        }),
      };
    });
    return c.body(null, 204);
  });
  module.post('/welcome-letters/:id/preview', async (c) => {
    const id = uuidParam(c);
    const { samples } = await parseBody(c, previewBody);
    return read(c, async (tx, tenant, authorize) => {
      await requireWelcomeView(authorize, tenant);
      return c.json(await previewWelcomeLetter(tx, tenant.tenantId, id, samples));
    });
  });
}

/** 入职手册：只读展示块；没有扫码报到入口（R2-T01 §11.1）。 */
function handbookRoutes(module: Module, deps: TenantRouteDeps, read: Read) {
  module.get('/handbooks', (c) =>
    read(c, async (tx, tenant, authorize) => {
      await requireHandbookView(authorize, tenant);
      const rows = await listHandbooks(tx, tenant.tenantId, listQuery(c));
      const availableActions = await handbookAvailableActions(authorize, tenant, 'create');
      return c.json({ items: rows.map(handbookView), availableActions });
    }),
  );
  module.get('/handbooks/:id', (c) =>
    read(c, async (tx, tenant, authorize) => {
      const id = uuidParam(c);
      await requireHandbookView(authorize, tenant);
      const row = await readHandbook(tx, tenant.tenantId, id);
      const availableActions = await handbookAvailableActions(authorize, tenant, 'update');
      c.header('ETag', `"${row.revision}"`);
      return c.json({ ...handbookView(row), availableActions });
    }),
  );
  module.post('/handbooks', async (c) => {
    const result = await handbookWrite(c, deps, 'create', async (expectedRevision) => {
      const input = await parseBody(c, handbookCreateBody);
      return {
        input,
        execute: async (tx, commandId) => ({
          status: 201,
          body: await createHandbook(tx, settingsContext(c, deps, expectedRevision, commandId), input),
        }),
      };
    });
    return writeResponse(c, result);
  });
  module.patch('/handbooks/:id', async (c) => {
    const id = uuidParam(c);
    const result = await handbookWrite(c, deps, 'update', async (expectedRevision) => {
      const input = await parseBody(c, handbookPatchBody);
      return {
        input,
        execute: async (tx, commandId) => ({
          status: 200,
          body: await updateHandbook(tx, settingsContext(c, deps, expectedRevision, commandId), id, input),
        }),
      };
    });
    return writeResponse(c, result);
  });
  module.delete('/handbooks/:id', async (c) => {
    const id = uuidParam(c);
    await handbookWrite(c, deps, 'update', async (expectedRevision) => {
      if (c.req.raw.body !== null && c.req.header('content-length') !== '0') await parseBody(c, emptyDeleteBody);
      return {
        input: null,
        execute: async (tx, commandId) => ({
          status: 200,
          body: await archiveHandbook(tx, settingsContext(c, deps, expectedRevision, commandId), id),
        }),
      };
    });
    return c.body(null, 204);
  });
  module.post('/handbooks/:id/preview', async (c) => {
    const id = uuidParam(c);
    const { samples } = await parseBody(c, previewBody);
    return read(c, async (tx, tenant, authorize) => {
      await requireHandbookView(authorize, tenant);
      return c.json(await previewHandbook(tx, tenant.tenantId, id, samples));
    });
  });
}

export const registerWelcomeRoutes: TenantRouteModule = (router, deps) => {
  const module = policedSub(router, WELCOME_POLICIES, () => new Hono<TenantEnv>());
  const read: Read = (c, body) =>
    withTenant(deps.db, tenantOf(c).tenantId, (tx) =>
      body(tx, tenantOf(c), authorizeInTransaction(deps.authorize, tx)),
    );
  welcomeRoutes(module, deps, read);
  handbookRoutes(module, deps, read);
  router.route('/api/tenant/onboarding', module);
};
