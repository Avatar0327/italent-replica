import { Alert, Button, Spin } from 'antd';
import { ui } from '../foundation/messages.js';
import { m as report } from '../hr-reports/messages.js';
import { m } from './messages.js';
import { boardErrorText, canRetryRead } from './model.js';

export function ReadState({
  loading,
  error,
  detail = false,
  missing,
  waiting,
  retry,
}: {
  loading: boolean;
  error?: unknown;
  detail?: boolean;
  missing?: string;
  waiting: boolean;
  retry?: () => void;
}) {
  if (loading)
    return (
      <div className="hr-dashboard-loading" role="status">
        <Spin /> {report.loading}
      </div>
    );
  if (!error) return null;
  return (
    <Alert
      type="error"
      role="alert"
      showIcon
      message={boardErrorText(error, detail, missing)}
      action={
        retry && (
          <Button disabled={waiting} onClick={retry}>
            {report.retry}
          </Button>
        )
      }
    />
  );
}

export function BoardReadFeedback({
  board,
  refresh,
}: {
  board: {
    read: { loading: boolean; error?: unknown };
    waiting: boolean;
    forbidden: boolean;
    noScope: boolean;
    retry(): void;
  };
  refresh(): void;
}) {
  const { read, waiting, forbidden, noScope, retry } = board;
  return (
    <>
      {forbidden ? (
        <Alert
          type="error"
          role="alert"
          message={m.boardDenied}
          action={<Button onClick={refresh}>{ui.refreshPage}</Button>}
        />
      ) : (
        <ReadState
          loading={read.loading}
          error={read.error}
          waiting={waiting}
          retry={canRetryRead(read.error) ? retry : undefined}
        />
      )}
      {noScope && <Alert type="info" message={report.noScope} />}
    </>
  );
}
