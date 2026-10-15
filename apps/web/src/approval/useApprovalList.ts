import { useEffect, useState } from 'react';
import { useApiClient, useSession, type PageRequest } from '../foundation/index.js';
import { approvalList } from './api.js';
import type { ApprovalList, ApprovalRow, ApprovalView } from './types.js';

const firstPage: PageRequest = { page: 1, pageSize: 15 };

/**
 * 待办卡片与我的申请共用：按视图读取一页，切换租户 / 身份即重读；原站每页 15 条。
 * 页码记在所属视图名下：切换分类（含切回原分类）时回到第 1 页，不把之前的页码带过去。
 */
export function useApprovalList(view: ApprovalView) {
  const api = useApiClient();
  const { timezone, tenantId, identityKey } = useSession();
  const [paging, setPaging] = useState<{ view: ApprovalView; request: PageRequest }>({ view, request: firstPage });
  // 渲染期按视图变化重置（React 推荐的“随 props 调整 state”写法），本次渲染即用第 1 页，不多发一次旧页请求。
  if (paging.view !== view) setPaging({ view, request: firstPage });
  const page = paging.view === view ? paging.request : firstPage;
  const setPage = (request: PageRequest) => setPaging({ view, request });
  const [data, setData] = useState<ApprovalList>({ items: [] });
  const [selected, setSelected] = useState<ApprovalRow>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [generation, setGeneration] = useState(0);
  const refresh = () => setGeneration((current) => current + 1);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    setData({ items: [] });
    void approvalList(api, view, page, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, view, page, generation, tenantId, identityKey]);
  return { data, selected, page, loading, error, timezone, refresh, setPage, setSelected };
}
export type ApprovalListState = ReturnType<typeof useApprovalList>;
