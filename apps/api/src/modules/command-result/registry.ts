import type { Tx } from '@italent/db';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';

export type CommandResultDeps = Pick<TenantRouteDeps, 'authorize' | 'clock'>;

/** 授权与投影在发起人匹配后的同一租户事务内执行。 */
export interface CommandResultRegistration {
  readonly commandType: string;
  authorize(tx: Tx, deps: CommandResultDeps, ctx: TenantContext, body: unknown): Promise<void>;
  project(body: unknown): Readonly<Record<string, unknown>>;
}

/** 路由装配时建立索引；重复类型没有覆盖顺序。 */
export function createCommandResultRegistry(
  registrations: readonly CommandResultRegistration[],
): ReadonlyMap<string, CommandResultRegistration> {
  const registry = new Map<string, CommandResultRegistration>();
  for (const registration of registrations) {
    if (registry.has(registration.commandType)) throw new Error(`命令回查类型重复登记：${registration.commandType}`);
    registry.set(registration.commandType, registration);
  }
  return registry;
}
