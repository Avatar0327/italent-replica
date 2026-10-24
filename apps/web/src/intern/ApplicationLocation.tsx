import { Alert, Button } from 'antd';
import { useEffect, useState } from 'react';
import { useApiClient } from '../foundation/Session.js';
import { m } from './messages.js';
import { listPath, pageSize, type ApplicationDestination, type ListResult } from './model.js';

/** 列表定位只有读取状态；每批有预算，继续读取从下一页开始，不影响已确认的写命令。 */
export function ApplicationLocation({
  destination,
  onLocated,
}: {
  destination: ApplicationDestination;
  onLocated(page: number): void;
}) {
  const api = useApiClient();
  const [request, retry] = useState({ page: 1 });
  const [state, setState] = useState<{ status: 'more' | 'failed' | 'missing'; page: number }>();
  useEffect(() => {
    const controller = new AbortController();
    const read = async () => {
      let page = request.page;
      setState(undefined);
      try {
        for (let count = 0; count < 100; count += 1, page += 1) {
          const data = await api.request<ListResult>(listPath(destination.view, page), {
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          if (data.items.some((item) => item.id === destination.id)) {
            onLocated(page);
            return;
          }
          if (data.items.length < pageSize) {
            setState({ status: 'missing', page: 1 });
            return;
          }
        }
        setState({ status: 'more', page });
      } catch {
        if (!controller.signal.aborted) setState({ status: 'failed', page });
      }
    };
    void read();
    // 切换视图、筛选或手动翻页后取消定位；迟到的读取不得覆盖用户的新选择。
    return () => controller.abort();
  }, [api, destination, request, onLocated]);
  const messages = { more: m.locateMore, failed: m.locateFailed, missing: m.locateMissing };
  return (
    <Alert
      type={state?.status === 'failed' ? 'warning' : 'info'}
      message={state ? messages[state.status] : m.locating}
      action={
        state && (
          <Button
            onClick={() => {
              setState(undefined);
              retry({ page: state.page });
            }}
          >
            {state.status === 'more' ? m.continueLocation : m.retryLocation}
          </Button>
        )
      }
    />
  );
}
