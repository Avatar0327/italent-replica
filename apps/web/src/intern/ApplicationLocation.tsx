import { Alert, Button } from 'antd';
import { useEffect, useLayoutEffect, useState } from 'react';
import { useLocation, useNavigationType } from 'react-router';
import { useApiClient } from '../foundation/Session.js';
import { m } from './messages.js';
import { listPath, pageSize, type ApplicationDestination, type InternView, type ListResult } from './model.js';

/** 定位属于本次导航；历史返回不能恢复已取消的任务（P2-R2-1）。 */
export function useApplicationLocation(view: InternView) {
  const route = useLocation();
  const navigationType = useNavigationType();
  const [destination, locate] = useState<ApplicationDestination>();
  useLayoutEffect(() => {
    // 提交成功以 PUSH 切到目标视图并新建任务，同次更新要保留；POP 或离开视图则作废父级目标。
    locate((current) => (navigationType === 'POP' || current?.view !== view ? undefined : current));
  }, [route.key, navigationType, view]);
  return [destination, locate] as const;
}

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
    // 切换视图、筛选、手动翻页或打开详情后取消定位；迟到的读取不得覆盖用户的新选择。
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
