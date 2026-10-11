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
export declare function planRenumber(
  mainJournal: Journal,
  branchJournal: Journal,
): {
  journal: Journal;
  renames: { from: JournalEntry; to: JournalEntry }[];
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
