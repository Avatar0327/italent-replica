/**
 * 授权钩子（“你能做什么”）。R1-T01 已接入：createApp 缺省使用 modules/permission 的 createPermissionAuthorizer，
 * 按用户在当前租户的管理员身份与业务身份判定功能权限，默认拒绝；数据范围由 R1-T02 判定（DEC-043）。
 * defaultAuthorizer 只在没有数据库时兜底（一律拒绝，fail-closed，AGENTS.md §2）。
 */
import { AppError } from './errors.js';

export interface AuthorizationRequest {
  readonly userId: string;
  readonly tenantId: string;
  /** 形如 `tenant.settings.read` / `tenant.settings.write`。 */
  readonly action: string;
  readonly resource?: string;
  /**
   * 本次写入的字段编码（服务端按解析后的载荷给出）。object.create / object.update 必填，
   * 每个字段都须至少一个有效身份可编辑，系统字段一律不可写（REQ-PRM-001 字段权限）。
   */
  readonly fields?: readonly string[];
}

export type Authorizer = (request: AuthorizationRequest) => boolean | Promise<boolean>;

export const defaultAuthorizer: Authorizer = () => false;

export async function requirePermission(authorizer: Authorizer, request: AuthorizationRequest): Promise<void> {
  if (!(await authorizer(request))) throw new AppError('FORBIDDEN', '无权执行该操作');
}
