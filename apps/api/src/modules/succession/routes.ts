/**
 * R3-T05 继任管理接口（设计 §2.2；前缀 /api/tenant/succession）。契约 PR 只占装配位：登记权限对象、开关校验与
 * 对外端口，不注册任何路由；记录、地图、规则、计算、同步的路由随 PR-A～PR-D 在本函数追加，并按 F-039 格式登记
 * 权限声明。
 */
import type { Hono } from 'hono';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import './access.js';
import './settings.js';
import { installSuccessionPorts } from './ports.js';

export function registerSuccessionRoutes(_router: Hono<TenantEnv>, _deps: TenantRouteDeps): void {
  installSuccessionPorts();
}
