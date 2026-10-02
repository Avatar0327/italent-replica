import type { TenantRouteModule } from '../../routes.js';
import { registerEstablishmentRoutes } from '../establishment/routes.js';
import { registerJobRoutes } from './routes.js';

/** 派发 §1：T04 的两个模块通过一行装配接入共享入口。 */
export const registerJobEstablishmentRoutes: TenantRouteModule = (router, deps) => {
  registerJobRoutes(router, deps);
  registerEstablishmentRoutes(router, deps);
};
