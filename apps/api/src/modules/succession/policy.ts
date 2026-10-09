/**
 * 继任管理路由的权限声明登记位（F-039 格式；挂在 /api/tenant/succession 之下，应用 SuccessionAndDevelopment，
 * DEC-043：范围按 用户 × SuccessionAndDevelopment，缺省为空）。契约 PR 没有路由，表为空；PR-A～PR-D 每新增一条路由
 * 在这里登记声明，并在 tests/acceptance/support/route-policy/required/succession.ts 登记必需义务与证据。
 */
import { defineTable } from '../../route-policy/index.js';

export const SUCCESSION_POLICIES = defineTable('succession', {});
