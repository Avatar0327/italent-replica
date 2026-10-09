/**
 * 继任管理的平台接口登记位（设计 §2.2 #19；拆分方案 v2 P0）：平台运营调度 `POST /api/platform/succession/jobs/run`
 * （B3）与规则重新编译 `POST /api/platform/succession/rules/recompile`（B2a）在本函数追加注册，并在
 * SUCCESSION_PLATFORM_POLICIES 登记 F-039 声明、在 tests/acceptance/support/route-policy/required/succession.ts 登记
 * 必需义务。平台路由器已套平台运营身份中间件（只认平台运营，与租户权限互不相通）；P0 不注册任何路由。
 */
import type { Db } from '@italent/db';
import type { Hono } from 'hono';
import { defineTable } from '../../route-policy/index.js';
import type { PlatformEnv } from '../platform/context.js';

export interface PlatformRouteDeps {
  readonly db: Db;
  readonly clock: () => Date;
}

export const SUCCESSION_PLATFORM_POLICIES = defineTable('succession-platform', {});

export function registerSuccessionPlatformRoutes(_router: Hono<PlatformEnv>, _deps: PlatformRouteDeps): void {}
