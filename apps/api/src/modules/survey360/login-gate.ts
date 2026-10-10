/**
 * 登录的 KDF 并发闸 G（F-076 设计 §3.2、§3.6）：每进程“全局 + 单租户”双限，满则 503，不计任何认证维度。
 * 单租户上限防止一个租户占满全部名额、让其他租户 503（参照 F-060 的 admitted 双限）。进程内计数，名额在整个登录
 * 请求（含登录时迁移的第二次 KDF）结束时释放。
 */
export interface GateLimits {
  readonly global: number;
  readonly perTenant: number;
}

const DEFAULT_LIMITS: GateLimits = { global: 4, perTenant: 2 };
let limits: GateLimits = DEFAULT_LIMITS;
let active = 0;
const perTenant = new Map<string, number>();

/** 只供测试调整（并发原子性、全局满等场景）；生产用常量。 */
export function configureLoginGate(next: GateLimits): void {
  limits = next;
}

export function resetLoginGate(): void {
  limits = DEFAULT_LIMITS;
}

/** 取名额；取不到返回 undefined。返回的函数释放名额（幂等）。 */
export function acquireLoginSlot(tenantId: string): (() => void) | undefined {
  const own = perTenant.get(tenantId) ?? 0;
  if (active >= limits.global || own >= limits.perTenant) return undefined;
  active += 1;
  perTenant.set(tenantId, own + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active -= 1;
    const left = (perTenant.get(tenantId) ?? 1) - 1;
    if (left <= 0) perTenant.delete(tenantId);
    else perTenant.set(tenantId, left);
  };
}
