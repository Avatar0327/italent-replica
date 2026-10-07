/**
 * 360 度评估（R3-T03，REQ-360-001）路由装配：管理端 /api/tenant/survey360（经租户成员中间件，按 360 管理员身份
 * 判定），作答 / 确认链接 /api/survey360/link（外部评价者凭链接访问，见 answering.ts）。
 */
import { Hono } from 'hono';
import { handleError } from '../../errors.js';
import type { TenantRouteModule } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { registerActivityRoutes } from './activities.js';
import { registerAdminRoutes } from './admins.js';
import { registerLinkRoutes } from './answering.js';
import { mapDbError } from './context.js';
import { registerPeopleRoutes } from './people.js';
import { registerQuestionnaireRoutes } from './questionnaires.js';
import { registerRelationRoutes } from './relations.js';

export const registerSurvey360Routes: TenantRouteModule = (router, deps) => {
  const module = new Hono<TenantEnv>();
  module.onError((error, c) => handleError(mapDbError(error) ?? error, c));
  registerAdminRoutes(module, deps);
  registerPeopleRoutes(module, deps);
  registerQuestionnaireRoutes(module, deps);
  registerActivityRoutes(module, deps);
  registerRelationRoutes(module, deps);
  router.route('/api/tenant/survey360', module);
  registerLinkRoutes(router, deps);
};
