import { Button, Empty, Result, Spin } from 'antd';
import { Component, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ApiError } from './client.js';
import { ui } from './messages.js';

export function PageState({
  kind,
  error,
  retry,
  refresh,
}: {
  kind: 'loading' | 'empty' | 'forbidden' | 'not-found' | 'error' | 'login';
  error?: unknown;
  retry?: () => void;
  /** 整页无权限时重新获取权限；抽屉等局部无权限不传。 */
  refresh?: () => void;
}) {
  if (kind === 'loading')
    return (
      <div className="page-state" role="status">
        <Spin />
        <p>{ui.loading}</p>
      </div>
    );
  if (kind === 'empty') return <Empty className="page-state" description={ui.empty} />;
  const status = { 'not-found': '404', forbidden: '403', login: 'info', error: 'error' } as const;
  const title = { 'not-found': ui.missing, forbidden: ui.denied, login: ui.login, error: ui.failed };
  // 原站无权限页在标题下提示联系管理员；有后端错误信息时以后端为准。
  const hint = kind === 'forbidden' ? ui.deniedHint : undefined;
  return (
    <div role={kind === 'error' ? 'alert' : 'status'}>
      <Result
        status={status[kind]}
        title={title[kind]}
        subTitle={error instanceof ApiError ? error.message : hint}
        extra={stateAction(kind, retry, refresh)}
      />
    </div>
  );
}
// 原站整页无权限在提示下给“刷新页面”主按钮（12_无权限页）；未找到页回首页；加载失败可重试。
function stateAction(kind: string, retry?: () => void, refresh?: () => void) {
  if (kind === 'not-found') return <Link to="/">{ui.home}</Link>;
  if (kind === 'forbidden' && refresh)
    return (
      <Button type="primary" onClick={refresh}>
        {ui.refreshPage}
      </Button>
    );
  return retry && <Button onClick={retry}>{ui.retry}</Button>;
}
export class PageErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <PageState kind="error" retry={() => this.setState({ failed: false })} />
    ) : (
      this.props.children
    );
  }
}
