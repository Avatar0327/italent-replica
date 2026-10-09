/**
 * 360 度评估（R3-T03，REQ-360-001）路由装配：管理端 /api/tenant/survey360（经租户成员中间件，按平台身份 × 应用
 * Survey360 的对象权限判定，DEC-280），作答 / 确认链接 /api/survey360/link（外部评价者凭链接访问，见 answering.ts）。
 */
import { Hono } from 'hono';
import { policedSub } from '../../route-policy/index.js';
import { SURVEY360_POLICIES } from './policy.js';
import { handleError } from '../../errors.js';
import type { TenantRouteModule } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { registerActivityRoutes } from './activities.js';
import { registerSettingsRoutes } from './settings.js';
import { registerLinkRoutes } from './answering.js';
import { mapDbError } from './context.js';
import { registerPeopleRoutes } from './people.js';
import { registerQuestionnaireRoutes } from './questionnaires.js';
import { registerRelationRoutes } from './relations.js';
import { registerSyncRoutes } from './sync.js';

export const registerSurvey360Routes: TenantRouteModule = (router, deps) => {
  // F-039：子应用套本模块登记表（SURVEY360_POLICIES），注册行不变、处理函数不变
  const module = policedSub(router, SURVEY360_POLICIES, () => new Hono<TenantEnv>());
  module.onError((error, c) => handleError(mapDbError(error) ?? error, c));
  registerSettingsRoutes(module, deps);
  // 同步路由先于 /people/:id 注册（/people/sync-conflicts 不能被当作人员编号）
  registerSyncRoutes(module, deps);
  registerPeopleRoutes(module, deps);
  registerQuestionnaireRoutes(module, deps);
  registerActivityRoutes(module, deps);
  registerRelationRoutes(module, deps);
  router.route('/api/tenant/survey360', module);
  registerLinkRoutes(router, deps);
};
