/**
 * 360 度评估（R3-T03，REQ-360-001）路由装配：管理端 /api/tenant/survey360（经租户成员中间件，按平台身份 × 应用
 * Survey360 的对象权限判定，DEC-280），作答 / 确认链接 /api/survey360/link（外部评价者凭链接访问，见 answering.ts），
 * 报告转发的收件人链接 /api/survey360/report-link（reports.ts）；我的待办 /api/tenant/survey360/my/todos 只要租户
 * 成员身份（todos.ts）。
 */
import { Hono } from 'hono';
import { handleError } from '../../errors.js';
import type { TenantRouteModule } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { registerActivityRoutes } from './activities.js';
import { registerSettingsRoutes } from './settings.js';
import { registerAnswerRoutes, registerLinkRoutes } from './answering.js';
import { mapDbError } from './context.js';
import { registerPeopleRoutes } from './people.js';
import { registerProgressRoutes } from './progress.js';
import { registerQuestionnaireRoutes } from './questionnaires.js';
import { registerRelationRoutes } from './relations.js';
import { registerReportLinkRoutes, registerReportRoutes } from './reports.js';
import { registerSheetRoutes } from './sheets.js';
import { registerSyncRoutes } from './sync.js';
import { registerTableRoutes } from './tables.js';
import { registerTodoRoutes, todoEntry } from './todos.js';

export const registerSurvey360Routes: TenantRouteModule = (router, deps) => {
  const module = new Hono<TenantEnv>();
  module.onError((error, c) => handleError(mapDbError(error) ?? error, c));
  registerSettingsRoutes(module, deps);
  // 同步路由先于 /people/:id 注册（/people/sync-conflicts 不能被当作人员编号）
  registerSyncRoutes(module, deps);
  registerPeopleRoutes(module, deps);
  registerQuestionnaireRoutes(module, deps);
  registerActivityRoutes(module, deps);
  registerRelationRoutes(module, deps);
  // PR-B：进程控制与重新作答、邀请与待办、原始数据与屏蔽、个人报告与转发、结果报表
  registerProgressRoutes(module, deps);
  registerTodoRoutes(module, deps);
  registerSheetRoutes(module, deps);
  registerReportRoutes(module, deps);
  registerTableRoutes(module, deps);
  // 站内待办“去处理”：登录账号本人作答，与链接作答同一套页面与命令
  registerAnswerRoutes(module, deps, todoEntry(), '/my/todos/:todoId');
  router.route('/api/tenant/survey360', module);
  registerLinkRoutes(router, deps);
  registerReportLinkRoutes(router, deps);
};
