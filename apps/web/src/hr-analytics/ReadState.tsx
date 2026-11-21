import { Alert, Button, Spin } from 'antd';
import { m as report } from '../hr-reports/messages.js';
import { boardErrorText } from './model.js';

export function ReadState({
  loading,
  error,
  detail = false,
  waiting,
  retry,
}: {
  loading: boolean;
  error?: unknown;
  detail?: boolean;
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
      message={boardErrorText(error, detail)}
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
