import { Alert, Button, Spin } from 'antd';
import { useEffect, useState } from 'react';
import { ApiError } from '../foundation/client.js';
import { m as report } from '../hr-reports/messages.js';
import { boardErrorText } from './model.js';

export function useReadCooldown(error: unknown) {
  const limited = error instanceof ApiError && error.status === 429 && (error.retryAfter ?? 0) > 0 ? error : undefined;
  const [limit, setLimit] = useState<{ error: ApiError; until: number }>();
  const [released, setReleased] = useState<ApiError>();
  useEffect(() => {
    if (limited) setLimit({ error: limited, until: Date.now() + limited.retryAfter! * 1000 });
  }, [limited]);
  useEffect(() => {
    if (!limit) return;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const remaining = limit.until - Date.now();
      if (remaining <= 0) setReleased(limit.error);
      else timer = setTimeout(check, Math.min(remaining, 2_147_483_647));
    };
    check();
    return () => clearTimeout(timer);
  }, [limit]);
  // 抽屉关闭时仍须遵守已经收到的 Retry-After。
  return Boolean((limited && limited !== limit?.error) || (limit && limit.error !== released));
}

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
