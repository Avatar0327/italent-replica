export declare const PHASES: readonly ['pre-enable', 'deploy', 'post-restore'];
export declare const APP_NAME_PREFIX: string;
export type DeployPhase = (typeof PHASES)[number];
export type Query = (text: string) => Promise<readonly Record<string, unknown>[]>;
export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}
export declare function readSwitchDefault(codeRoot: string): boolean | undefined;
export declare function readCodeMigrations(codeRoot: string): { count: number; last: number };
export interface SessionCounts {
  /** 带 italent-api: 前缀的连接数。 */
  marked: number;
  /** 应用数据库角色名下、未带前缀的连接数（如旧默认连接名 postgres.js）。 */
  unmarked: number;
}
export type SessionProbe = (query: Query, appRole: string) => Promise<SessionCounts>;
export declare function applicationSessions(query: Query, appRole: string): Promise<SessionCounts>;
export declare function checkDeployTarget(options: {
  phase: DeployPhase;
  query: Query;
  codeRoot?: string;
  sessions?: SessionProbe;
  /** 应用运行时数据库角色（pre-enable / post-restore 必填）。 */
  appRole?: string | undefined;
}): Promise<{ ok: boolean; results: CheckResult[] }>;
