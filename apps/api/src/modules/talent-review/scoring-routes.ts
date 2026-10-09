/**
 * R3-T04 PR-B2 接口（设计 §7 配置 CRUD 行；前缀 /api/tenant/talent-review）：评价规则 score-rules、模块等级 module-grades、
 * 字段映射 field-mappings。读写模式同 B1（config-routes.ts）：没有组织字段，列表按创建人谓词分页前过滤，范围外与不存在同一个
 * 404，写入走命令台账并按当前权限复核；字段映射另需字段对象的查看权与范围（引用字段 = 读取字段对象）。
 * 路由权限声明见 docs/08_设计/R3-T04_PR-B2_路由声明.md。
 */
import { withTenant } from '@italent/db';
import type { Context, Hono } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { pageQuery, parseBody, requireNew, revision, uuidParam } from '../talent/http.js';
import {
  checkWriteFields,
  configEnvelope,
  configScopeSql,
  notFoundMessage,
  requireConfigVisible,
  requireFilterVisible,
  reviewContext,
  reviewScope,
  reviewWriteContext,
  TALENT_REVIEW_BASE,
  trimReview,
  type ModuleScope,
} from './access.js';
import {
  mappingCreate,
  mappingPatch,
  moduleGradeCreate,
  moduleGradePatch,
  scoreRuleCreate,
  scoreRulePatch,
} from './config-input.js';
import { deleteConfig, loadConfig } from './config-kit.js';
import { detailResponse, listResponse, runWrite, visibleTo } from './config-routes.js';
import * as grades from './module-grade-service.js';
import * as mappings from './mapping-service.js';
import * as rules from './score-rule-service.js';

const SCORE_RULES = `${TALENT_REVIEW_BASE}/score-rules`;
const MODULE_GRADES = `${TALENT_REVIEW_BASE}/module-grades`;
const MAPPINGS = `${TALENT_REVIEW_BASE}/field-mappings`;

export function registerScoringRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerScoreRules(router, deps);
  registerModuleGrades(router, deps);
  registerMappings(router, deps);
}

function registerScoreRules(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(SCORE_RULES, async (c) => {
    const ctx = await reviewContext(c, deps, 'scoreRule');
    return listResponse(c, deps, ctx, 'scoreRule', 'talent_review_score_rules', rules.SCORE_RULE, (tx, found) =>
      rules.withLevels(tx, ctx.tenantId, found as never),
    );
  });
  router.get(`${SCORE_RULES}/:id`, async (c) => {
    const ctx = await reviewContext(c, deps, 'scoreRule');
    return detailResponse(c, deps, ctx, 'scoreRule', rules.SCORE_RULE);
  });
  router.post(SCORE_RULES, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'scoreRule', 'create', revision(c));
    requireNew(ctx.expectedRevision);
    const body = await parseBody(c, scoreRuleCreate);
    await checkWriteFields(deps, ctx, 'scoreRule', 'create', body);
    return runWrite(c, deps, ctx, 'scoreRule', body, 201, visibleTo('scoreRule'), (tx, w) =>
      rules.createScoreRule(tx, w, body),
    );
  });
  router.patch(`${SCORE_RULES}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'scoreRule', 'update', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, scoreRulePatch);
    await checkWriteFields(deps, ctx, 'scoreRule', 'update', body);
    return runWrite(c, deps, ctx, 'scoreRule', body, 200, visibleTo('scoreRule'), (tx, w) =>
      rules.updateScoreRule(tx, w, id, body),
    );
  });
  router.delete(`${SCORE_RULES}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'scoreRule', 'delete', revision(c));
    const id = uuidParam(c);
    return runWrite(c, deps, ctx, 'scoreRule', { id }, 200, visibleTo('scoreRule'), (tx, w) =>
      deleteConfig(tx, rules.SCORE_RULE, w, id),
    );
  });
}

function registerModuleGrades(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(MODULE_GRADES, async (c) => {
    const ctx = await reviewContext(c, deps, 'moduleGrade');
    return listResponse(c, deps, ctx, 'moduleGrade', 'talent_review_module_grades', grades.MODULE_GRADE, (tx, found) =>
      grades.withItems(tx, ctx.tenantId, found as never),
    );
  });
  router.get(`${MODULE_GRADES}/:id`, async (c) => {
    const ctx = await reviewContext(c, deps, 'moduleGrade');
    return detailResponse(c, deps, ctx, 'moduleGrade', grades.MODULE_GRADE);
  });
  router.post(MODULE_GRADES, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'moduleGrade', 'create', revision(c));
    requireNew(ctx.expectedRevision);
    const body = await parseBody(c, moduleGradeCreate);
    await checkWriteFields(deps, ctx, 'moduleGrade', 'create', body);
    return runWrite(c, deps, ctx, 'moduleGrade', body, 201, visibleTo('moduleGrade'), (tx, w) =>
      grades.createModuleGrade(tx, w, body),
    );
  });
  router.patch(`${MODULE_GRADES}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'moduleGrade', 'update', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, moduleGradePatch);
    await checkWriteFields(deps, ctx, 'moduleGrade', 'update', body);
    return runWrite(c, deps, ctx, 'moduleGrade', body, 200, visibleTo('moduleGrade'), (tx, w) =>
      grades.updateModuleGrade(tx, w, id, body),
    );
  });
  router.delete(`${MODULE_GRADES}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'moduleGrade', 'delete', revision(c));
    const id = uuidParam(c);
    return runWrite(c, deps, ctx, 'moduleGrade', { id }, 200, visibleTo('moduleGrade'), (tx, w) =>
      deleteConfig(tx, grades.MODULE_GRADE, w, id),
    );
  });
}

/**
 * 字段映射引用字段 = 读取字段对象：另需字段对象的查看权（403）与范围；返回字段对象的数据范围，
 * 命令里不存在与范围外同一个 404。先于读取字段校验。
 */
async function requireMappingFields(c: Context<TenantEnv>, deps: TenantRouteDeps): Promise<ModuleScope> {
  const ctx = await reviewContext(c, deps, 'field');
  return reviewScope(c, deps, ctx, 'field');
}

function registerMappings(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(MAPPINGS, async (c) => {
    const ctx = await reviewContext(c, deps, 'mapping');
    const page = pageQuery(c);
    const scene = c.req.query('scene') || undefined;
    // 筛选字段同样受字段查看权约束：看不到 scene 的人不能用筛选还原场景
    if (scene !== undefined) await requireFilterVisible(deps, ctx, 'mapping', 'scene');
    const scope = await reviewScope(c, deps, ctx, 'mapping');
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      mappings.listMappings(tx, ctx.tenantId, {
        ...page,
        scene,
        visible: configScopeSql(scope, 'talent_review_field_mappings'),
      }),
    );
    return c.json({ ...configEnvelope(page, scope), items: await trimReview(deps, ctx, 'mapping', items) });
  });
  router.get(`${MAPPINGS}/:id`, async (c) => {
    const ctx = await reviewContext(c, deps, 'mapping');
    const id = uuidParam(c);
    const scope = await reviewScope(c, deps, ctx, 'mapping');
    const found = await withTenant(deps.db, ctx.tenantId, (tx) => loadConfig(tx, mappings.MAPPING, ctx.tenantId, id));
    if (!found) throw new AppError('NOT_FOUND', notFoundMessage('mapping'));
    requireConfigVisible(scope, 'mapping', found.createdBy);
    c.header('ETag', `"${found.revision}"`);
    return c.json((await trimReview(deps, ctx, 'mapping', [found]))[0]);
  });
  router.post(MAPPINGS, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'mapping', 'create', revision(c));
    requireNew(ctx.expectedRevision);
    const body = await parseBody(c, mappingCreate);
    await checkWriteFields(deps, ctx, 'mapping', 'create', body);
    const fieldScope = await requireMappingFields(c, deps);
    return runWrite(c, deps, ctx, 'mapping', body, 201, visibleTo('mapping'), (tx, w) =>
      mappings.createMapping(tx, w, fieldScope, body),
    );
  });
  router.patch(`${MAPPINGS}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'mapping', 'update', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, mappingPatch);
    await checkWriteFields(deps, ctx, 'mapping', 'update', body);
    const touched = body.sourceFieldId !== undefined || body.targetFieldId !== undefined;
    const fieldScope = touched ? await requireMappingFields(c, deps) : undefined;
    return runWrite(c, deps, ctx, 'mapping', body, 200, visibleTo('mapping'), (tx, w) =>
      mappings.updateMapping(tx, w, fieldScope, id, body),
    );
  });
  router.delete(`${MAPPINGS}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'mapping', 'delete', revision(c));
    const id = uuidParam(c);
    return runWrite(c, deps, ctx, 'mapping', { id }, 200, visibleTo('mapping'), (tx, w) =>
      deleteConfig(tx, mappings.MAPPING, w, id, (before) => {
        if (before.preset) throw new AppError('CONFLICT', '预置映射不能删除', { reason: 'MAPPING_PRESET' });
      }),
    );
  });
}
