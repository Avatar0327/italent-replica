import type { CommandForm } from '../../foundation/forms/useCommandForm.js';
import { CommandStatus } from '../../foundation/forms/CommandStatus.js';
import { Alert, Button } from 'antd';
import { useDesignerPeople } from './FallbackHandlers.js';
import { m } from './messages.js';
import { sourceList, sourceSummary } from './sources.js';

/** 仅投影展示数据，内核仍持有原始 ID 做差异比较、恢复与提交。 */
export function SourceCommandStatus({
  submission,
  labels,
}: {
  submission: CommandForm;
  labels: Record<string, unknown>;
}) {
  const state = submission.state;
  const sourceField = (field: string) => /:(approver|approvers|emptyApproverSources)$/.test(field);
  const values = [
    ...(state?.differences ?? [])
      .filter((diff) => sourceField(diff.field))
      .flatMap((diff) => [diff.before, diff.latest, diff.mine]),
    ...Object.entries(state?.latest?.values ?? {})
      .filter(([field]) => sourceField(field))
      .map(([, value]) => value),
  ];
  const ids = [
    ...new Set(
      values.flatMap((value) => {
        const sources = sourceList(value) ?? [];
        return sources.filter((source) => source.type === 'specified').map((source) => source.value);
      }),
    ),
  ];
  const { known, retry } = useDesignerPeople(ids);
  const names = new Map(known?.choices.map((item) => [item.value, item.label]));
  const display = (field: string, value: unknown) => (sourceField(field) ? sourceSummary(value, names) : value);
  const projected = state && {
    ...state,
    differences: state.differences?.map((diff) => ({
      ...diff,
      before: display(diff.field, diff.before),
      latest: display(diff.field, diff.latest),
      mine: display(diff.field, diff.mine),
    })),
    latest: state.latest && {
      ...state.latest,
      values: Object.fromEntries(
        Object.entries(state.latest.values).map(([field, value]) => [field, display(field, value)]),
      ),
    },
  };
  return (
    <>
      {known?.failed && (
        <Alert type="warning" message={m.fallbackReadFailed} action={<Button onClick={retry}>{m.refresh}</Button>} />
      )}
      <CommandStatus submission={{ ...submission, state: projected }} labels={labels} />
    </>
  );
}
