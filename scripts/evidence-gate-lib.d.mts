export interface StatusDetails {
  file: string;
  line: number;
  pendingItems: string[];
}
export interface EvidenceRow extends StatusDetails {
  id: string;
  what: string;
  blocks: string;
  tasks: Set<string>;
  st: string;
  level: '开工前' | '可后补';
}
export interface DecisionRow extends StatusDetails {
  id: string;
  what: string;
  diff: string;
  st: string;
  tasks: Set<string> | null;
}
export declare function taskIds(text: string): Set<string>;
export declare function evidenceState(
  blocks: string,
  statusCell: string,
): Pick<EvidenceRow, 'st' | 'level' | 'pendingItems'>;
export declare function decisionSettled(statusCell: string): boolean;
export declare function parseEvidence(markdown: string, file?: string): EvidenceRow[];
export declare function parseDecisions(markdown: string, file?: string): DecisionRow[];
export declare function gateReport(
  evidence: readonly EvidenceRow[],
  decisions: readonly DecisionRow[],
  targets: readonly string[],
): { lines: string[]; exitCode: 0 | 1 };
