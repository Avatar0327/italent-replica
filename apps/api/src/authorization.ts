/**
 * 授权钩子（“你能做什么”）。R1-T01 接入：按用户 × 应用的身份、功能权限与数据范围判定（DEC-043，硬规则 1、6）。
 * 在接入之前，缺省实现一律拒绝（含读，fail-closed，AGENTS.md §2）；测试通过 AppDeps.authorize 注入放行。
 */
import { AppError } from './errors.js';

export interface AuthorizationRequest {
  readonly userId: string;
  readonly tenantId: string;
  /** 形如 `tenant.settings.read` / `tenant.settings.write`。 */
  readonly action: string;
  readonly resource?: string;
}

export type Authorizer = (request: AuthorizationRequest) => boolean | Promise<boolean>;

// R1-T01 接入：替换为真实判定
export const defaultAuthorizer: Authorizer = () => false;

export async function requirePermission(authorizer: Authorizer, request: AuthorizationRequest): Promise<void> {
  if (!(await authorizer(request))) throw new AppError('FORBIDDEN', '无权执行该操作');
}
