/**
 * R2-T03 离职路由（挂在任职子应用 policedSub 上，策略登记在 employment/policy.ts，设计 §4 / §9.2）。
 * B1a 只有三个字典的读写：读取对持任职记录查看权者开放（表单下拉、列表显示名称），写入是配置对象
 * （tenant.employment.configuration.write，管理员 other_settings；字段按任职设置配置对象校验）。
 */
import { EXIT_SETTING_KEYS, EXIT_SETTINGS } from '@italent/domain';
import { withTenant } from '@italent/db';
import type { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { registerSettingValidator } from '../tenant-settings/service.js';
import { jsonBody, readContext, requireEmploymentWrite, revision, runWrite, uuidParam } from './context.js';
import {
  exitDictionaryKind,
  listExitDictionary,
  parseExitDictionaryInput,
  saveExitDictionaryEntry,
} from './exit-dictionaries.js';

// §2.2 转交时机配置项的取值校验（两层配置写入口，非法值 400 SETTING_VALUE_INVALID）
for (const key of EXIT_SETTING_KEYS) registerSettingValidator(key, EXIT_SETTINGS[key].valid);

const enabledQuery = z.enum(['true', 'false']).optional();

export function registerExitRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/exits/dictionaries/:dict', async (c) => {
    const ctx = await readContext(c, deps, 'object.view', 0);
    const kind = exitDictionaryKind(c.req.param('dict'));
    const enabled = enabledQuery.safeParse(c.req.query('enabled'));
    if (!enabled.success) throw new AppError('VALIDATION_FAILED', 'enabled 只能为 true 或 false');
    const filter = enabled.data === undefined ? {} : { enabled: enabled.data === 'true' };
    const items = await withTenant(deps.db, ctx.tenantId, (tx) => listExitDictionary(tx, ctx.tenantId, kind, filter));
    return c.json({ items });
  });
  router.post('/exits/dictionaries/:dict', async (c) => {
    const ctx = await readContext(
      c,
      deps,
      'tenant.employment.configuration.write',
      revision(c),
      undefined,
      'TenantBase.EmploymentSettings',
    );
    const kind = exitDictionaryKind(c.req.param('dict'));
    const input = parseExitDictionaryInput(await jsonBody(c), 'create');
    await requireEmploymentWrite(ctx, 'create', input, undefined, 'TenantBase.EmploymentSettings');
    return runWrite(c, deps, ctx, { kind, input }, async (tx, context) => ({
      status: 201,
      body: await saveExitDictionaryEntry(tx, context, kind, input),
    }));
  });
  router.put('/exits/dictionaries/:dict/:id', async (c) => {
    const ctx = await readContext(
      c,
      deps,
      'tenant.employment.configuration.write',
      revision(c),
      undefined,
      'TenantBase.EmploymentSettings',
    );
    const kind = exitDictionaryKind(c.req.param('dict'));
    const id = uuidParam(c);
    const input = parseExitDictionaryInput(await jsonBody(c), 'update');
    await requireEmploymentWrite(ctx, 'update', input, undefined, 'TenantBase.EmploymentSettings');
    return runWrite(c, deps, ctx, { kind, id, input }, async (tx, context) => ({
      status: 200,
      body: await saveExitDictionaryEntry(tx, context, kind, input, id),
    }));
  });
}
