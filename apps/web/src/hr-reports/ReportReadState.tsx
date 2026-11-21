import { Alert, Button, Spin } from 'antd';
import { useEffect, useState } from 'react';
import { m } from './messages.js';
import { errorText } from './model.js';

export function useReportRetryWait(retryAt: number) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!retryAt) return;
    let timer: ReturnType<typeof setTimeout>;
    const wait = () => {
      const remaining = retryAt - Date.now();
      if (remaining <= 0) setElapsed(retryAt);
      else timer = setTimeout(wait, Math.min(remaining, 2_147_483_647));
    };
    wait();
    return () => clearTimeout(timer);
  }, [retryAt]);
  return retryAt > elapsed;
}

export function ReportReadState({
  loading,
  error,
  retry,
  waiting,
}: {
  loading: boolean;
  error?: unknown;
  retry?: () => void;
  waiting?: boolean;
}) {
  if (loading)
    return (
      <div role="status">
        <Spin /> {m.loading}
      </div>
    );
  if (error)
    return (
      <Alert
        type="error"
        showIcon
        message={errorText(error)}
        role="alert"
        action={
          retry && (
            <Button disabled={waiting} onClick={retry}>
              {m.retry}
            </Button>
          )
        }
      />
    );
  return null;
}
