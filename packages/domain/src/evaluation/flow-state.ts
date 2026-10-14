/** 设计 §3.5：终止、资格未通过、结果已发布为终态，材料未通过仍进行中。 */
export interface EvaluationState {
  readonly terminatedAt: unknown;
  readonly applyStatus: string;
  readonly resultStatus: string | null;
}
export function isInProgress(row: EvaluationState): boolean {
  return (
    (row.terminatedAt === null || row.terminatedAt === undefined) &&
    row.applyStatus !== 'failed' &&
    row.resultStatus !== 'published'
  );
}
