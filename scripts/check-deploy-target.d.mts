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
export declare function applicationSessions(query: Query): Promise<number>;
export declare function checkDeployTarget(options: {
  phase: DeployPhase;
  query: Query;
  codeRoot?: string;
  sessions?: (query: Query) => Promise<number>;
}): Promise<{ ok: boolean; results: CheckResult[] }>;
