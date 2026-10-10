/**
 * 评价表接口（B4，设计 §3.2、§5.2 #6）：`/api/tenant/evaluation/evaluation-forms`。带所属组织（按所属组织 ∪ 所属人，无向下
 * 公开，DEC-324②）与嵌套评分项；评分项引用通用评分项与任职资格指标，名称按查看人当前的对象查看权 / 范围 / 字段权投影，所以
 * 单独成文件、不进通用注册器（通用接口的权限事实里不会多出这两类引用的查看权）。
 * 写命令走 `runWrite` / `runDelete`：权限、范围与引用访问都在命令事务内由 `ledgerExit` 之前的 `before` 重新解析
 * （首次、直接重放、失败后回查同一出口，DEC-388①）。
 */
import { sql, withTenant, type Tx } from '@italent/db';
import type { Hono } from 'hono';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { booleanQuery, pageQuery, parseBody, requireNew, revision, uuidParam } from '../talent/http.js';
import {
  checkWriteFields,
  evaluationContext,
  evaluationScope,
  evaluationWriteContext,
  listEnvelope,
  requireFilterVisible,
  requireVisible,
  scopePredicate,
  viewableFields,
} from './access.js';
import * as forms from './form-service.js';
import { registerFormUsage } from './form-usage.js';
import { formRefAccess, type FormRefAccess, resolveFormRefs } from './form-refs.js';
import * as input from './input.js';
import * as read from './read-model.js';
import { EV_BASE, presenter, runDelete, runWrite, type WriteRefs, writeContext } from './route-support.js';
import { rowAccess } from './store.js';

const OBJECT = 'evaluationForm';
const PATH = `${EV_BASE}/evaluation-forms`;

/** 评分项的引用：写命令在事务内重新解析通用评分项 / 指标的访问；响应按解析结果整形（form-service.presentForms）。 */
const REFS: WriteRefs = {
  resolve: async (deps, ctx, tx) => ({
    forms: await resolveFormRefs(deps, ctx, tx),
    // deps 此时已绑定事务内的授权器：隐含的变更（切换评分方式清空总分规则）按当前字段编辑权校验
    checkFields: (payload) => checkWriteFields(deps, ctx, OBJECT, 'update', payload),
  }),
  shape: (tx, write, views) => forms.presentForms(tx, write.tenantId, write.forms!, views),
};

export function registerFormRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerFormUsage();
  const present = presenter(deps, OBJECT);
  /** 读出行 → 挂评分项 → 引用名称整形（字段权限裁剪之前）。 */
  const shapeRows = async (tx: Tx, tenantId: string, access: FormRefAccess, rows: Record<string, unknown>[]) =>
    forms.presentForms(tx, tenantId, access, await forms.withItems(tx, tenantId, rows));

  router.get(PATH, async (c) => {
    const ctx = await evaluationContext(c, deps, OBJECT);
    const page = pageQuery(c);
    const scope = await evaluationScope(c, deps, ctx, OBJECT);
    const fields = await viewableFields(deps, ctx, OBJECT);
    const enabled = booleanQuery(c, 'enabled');
    if (enabled !== undefined) requireFilterVisible(fields, 'enabled');
    const filter = enabled === undefined ? sql`true` : sql`t.enabled = ${enabled}`;
    const access = await formRefAccess(c, deps, ctx);
    const items = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const rows = await read.listRows(
        tx,
        ctx.tenantId,
        OBJECT,
        scopePredicate(scope, OBJECT),
        page,
        filter,
        read.orderBy(OBJECT, fields),
      );
      return shapeRows(tx, ctx.tenantId, access, rows);
    });
    return c.json({ ...listEnvelope(page, scope, OBJECT), items: await present(ctx, items) });
  });

  router.get(`${PATH}/:id`, async (c) => {
    const ctx = await evaluationContext(c, deps, OBJECT);
    const id = uuidParam(c);
    const scope = await evaluationScope(c, deps, ctx, OBJECT);
    const access = await formRefAccess(c, deps, ctx);
    const found = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      requireVisible((await rowAccess(tx, ctx, scope, OBJECT, id)).visible, OBJECT);
      const row = (await read.loadRow(tx, ctx.tenantId, OBJECT, id))!;
      return (await shapeRows(tx, ctx.tenantId, access, [row]))[0]!;
    });
    c.header('ETag', `"${found.revision}"`);
    return c.json((await present(ctx, [found]))[0]);
  });

  router.post(PATH, async (c) => {
    const ctx = await evaluationWriteContext(c, deps, OBJECT, 'create', revision(c));
    requireNew(ctx.expectedRevision);
    const body = await parseBody(c, input.formCreate);
    await checkWriteFields(deps, ctx, OBJECT, 'create', body);
    const w = writeContext(ctx, await evaluationScope(c, deps, ctx, OBJECT));
    return runWrite(c, deps, w, OBJECT, body, 201, (tx, x) => forms.createForm(tx, x, body), REFS);
  });

  router.patch(`${PATH}/:id`, async (c) => {
    const ctx = await evaluationWriteContext(c, deps, OBJECT, 'update', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, input.formPatch);
    await checkWriteFields(deps, ctx, OBJECT, 'update', body);
    const w = writeContext(ctx, await evaluationScope(c, deps, ctx, OBJECT));
    return runWrite(c, deps, w, OBJECT, body, 200, (tx, x) => forms.updateForm(tx, x, id, body), REFS);
  });

  router.delete(`${PATH}/:id`, async (c) => {
    const ctx = await evaluationWriteContext(c, deps, OBJECT, 'delete', revision(c));
    const id = uuidParam(c);
    const w = writeContext(ctx, await evaluationScope(c, deps, ctx, OBJECT));
    return runDelete(c, deps, w, OBJECT, id, (tx, x) => forms.deleteForm(tx, x, id), REFS);
  });
}
