export interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}
export interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}
export interface Snapshot {
  id: string;
  prevId: string;
  [key: string]: unknown;
}
export declare const JOURNAL_PATH: string;
export declare const GENERATED_PATHS: readonly string[];
export declare function isGeneratedPath(file: string): boolean;
export declare function pad4(idx: number): string;
export declare function snapshotPath(idx: number): string;
export declare function sqlPath(tag: string): string;
export declare function sqlDigest(text: string | undefined): string | undefined;
export interface SqlReaders {
  /** main 上该迁移 SQL 的文本（读不到返回 undefined） */
  main?: (tag: string) => string | undefined;
  /** 本分支上该迁移 SQL 的文本（读不到返回 undefined） */
  branch?: (tag: string) => string | undefined;
}
export interface SnapshotIdentityInput {
  /** main 上每条迁移的 tag 与快照 id */
  main: readonly { tag: string; id: string | undefined }[];
  /** 本分支要保留（改号）的迁移的 tag 与快照 id（改号前的） */
  kept: readonly { tag: string; id: string | undefined }[];
  /** main 最新一条迁移的快照 id：保留项与它重复就会形成 id = prevId 自环 */
  mainLastId?: string;
  digestOf?: (side: 'main' | 'branch', tag: string) => string | undefined;
}
export declare function checkSnapshotIdentity(input: SnapshotIdentityInput): string[];
export declare function formatStale(
  stale: readonly { from: JournalEntry; mainEntry: JournalEntry; digest: string }[],
): string[];
export declare function planRenumber(
  mainJournal: Journal,
  branchJournal: Journal,
  sql?: SqlReaders,
): {
  journal: Journal;
  renames: { from: JournalEntry; to: JournalEntry; baseIdx: number | undefined }[];
  /** 上游已合并但改了号的迁移：本分支旧名条目（from）与 main 上内容相同的条目（mainEntry），要清理、不改号 */
  stale: { from: JournalEntry; mainEntry: JournalEntry; digest: string }[];
  changed: boolean;
  forkIdx: number | undefined;
};
export declare function merge3(base: unknown, ours: unknown, theirs: unknown): { value: unknown; conflicts: string[] };
export declare function rebaseSnapshots(
  forkSnapshot: Snapshot,
  ownSnapshots: readonly Snapshot[],
  mainLast: Snapshot,
  bases?: readonly Snapshot[],
): { snapshots: Snapshot[]; conflicts: string[] };
export declare function drizzleJson(value: unknown): string;
export interface Diff3Hunk {
  ours: string;
  base: string | null;
  theirs: string;
}
export declare function parseDiff3(text: string): (string | Diff3Hunk)[];
export declare function maskNumbers(text: string): string;
export declare function isCountOnlyHunk(hunk: Diff3Hunk): boolean;
export declare function classifyConflict(diff3Text: string): { hunks: number; countOnly: boolean };
export declare function takeOursForCounts(diff3Text: string): { text: string; remaining: number };
export declare const GRANTS_PATH: string;
export declare const GRANT_HISTORY_PATH: string;
export interface GrantConstants {
  version: number;
  digest: string;
}
export interface GrantHistoryEntry extends GrantConstants {
  comments: string[];
}
export declare function readGrantConstants(text: string): GrantConstants;
export declare function writeGrantConstants(text: string, constants: GrantConstants): string;
export declare function parseGrantHistory(text: string): GrantHistoryEntry[];
export declare function writeGrantHistory(text: string, entries: readonly GrantHistoryEntry[]): string;
export declare function planGrantVersion(input: {
  main: GrantConstants;
  mainHistory: readonly GrantHistoryEntry[];
  branch: GrantConstants | undefined;
  branchHistory: readonly GrantHistoryEntry[];
  mergedDigest: string;
  label: string;
}): GrantConstants & { bumped: boolean; changed: boolean; history: GrantHistoryEntry[] };
export declare function isGrantConstantHunk(hunk: Diff3Hunk): boolean;
export declare function isGrantHistoryHunk(hunk: Diff3Hunk, prefix: string): boolean;
export declare function resolveGrantConflict(
  file: string,
  diff3Text: string,
): { text: string; remaining: number } | null;
export declare const GRANT_CHANGES_PATH: string;
export interface GrantChanges {
  reason: string;
  add: readonly string[];
  remove: readonly string[];
}
export declare const EMPTY_GRANT_CHANGES: GrantChanges;
export declare function parseGrantChanges(text: string): GrantChanges;
export declare function activeGrantChanges(baseText: string | undefined, headText: string | undefined): GrantChanges;
export declare function checkGrantChanges(input: {
  baseCodes: readonly string[];
  headCodes: readonly string[];
  declared: GrantChanges;
}): { added: string[]; removed: string[]; problems: string[] };
export declare function pickGrantChanges(input: {
  branch: string | undefined;
  fork: string | undefined;
  main: string | undefined;
}): string | undefined;
export declare function describeGrantPlan(input: {
  main: GrantConstants;
  mergedDigest: string | undefined;
  branchDigest: string;
  forkDigest: string;
}): string;
