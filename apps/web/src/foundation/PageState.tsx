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
  return (
    <div role={kind === 'error' ? 'alert' : 'status'}>
      <Result
        status={kind === 'not-found' ? '404' : kind === 'forbidden' ? '403' : kind === 'login' ? 'info' : 'error'}
        title={
          kind === 'not-found' ? ui.missing : kind === 'forbidden' ? ui.denied : kind === 'login' ? ui.login : ui.failed
        }
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
