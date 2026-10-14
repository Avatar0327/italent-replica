import { Button, Empty, Result, Spin } from 'antd';
import { Component, type ReactNode } from 'react';
import { ApiError } from './client.js';
import { ui } from './messages.js';

export function PageState({
  kind,
  error,
  retry,
}: {
  kind: 'loading' | 'empty' | 'forbidden' | 'not-found' | 'error' | 'login';
  error?: unknown;
  retry?: () => void;
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
  return (
    <div role={kind === 'error' ? 'alert' : 'status'}>
      <Result
        status={status[kind]}
        title={title[kind]}
        subTitle={error instanceof ApiError ? error.message : undefined}
        extra={retry && <Button onClick={retry}>{ui.retry}</Button>}
      />
    </div>
  );
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
