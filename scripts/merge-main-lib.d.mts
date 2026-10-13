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
export declare function normalizeSql(text: string): string;
export declare function sqlDigest(text: string | undefined): string | undefined;
export interface SqlReaders {
  /** main 上该迁移 SQL 的文本（读不到返回 undefined） */
  main?: (tag: string) => string | undefined;
  /** 本分支上该迁移 SQL 的文本（读不到返回 undefined） */
  branch?: (tag: string) => string | undefined;
}
export declare function planRenumber(
  mainJournal: Journal,
  branchJournal: Journal,
  sql?: SqlReaders,
): {
  journal: Journal;
  renames: { from: JournalEntry; to: JournalEntry }[];
  /** 上游已合并但改了号的迁移：本分支旧名条目（from）与 main 上内容相同的条目（mainEntry），要清理、不改号 */
  stale: { from: JournalEntry; mainEntry: JournalEntry }[];
  changed: boolean;
  forkIdx: number | undefined;
};
export declare function merge3(base: unknown, ours: unknown, theirs: unknown): { value: unknown; conflicts: string[] };
export declare function rebaseSnapshots(
  forkSnapshot: Snapshot,
  ownSnapshots: readonly Snapshot[],
  mainLast: Snapshot,
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
