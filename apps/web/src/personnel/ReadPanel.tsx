import { Empty } from 'antd';
import type { ReactNode } from 'react';
import { PageState } from '../foundation/PageState.js';

/** 页面片统一处理读取状态，避免错误或刷新中残留旧档案。 */
export function ReadPanel({
  loading,
  error,
  refresh,
  empty,
  children,
}: {
  loading: boolean;
  error?: unknown;
  refresh(): void;
  empty?: string | false;
  children: ReactNode;
}) {
  if (loading) return <PageState kind="loading" />;
  if (error) return <PageState kind="error" error={error} retry={refresh} />;
  if (empty) return <Empty description={empty} />;
  return children;
}
