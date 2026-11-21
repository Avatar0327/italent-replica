import { Button } from 'antd';
import { useLayoutEffect, useRef, useState } from 'react';
import type { PersonnelReport } from '@italent/domain';
import { ApiError } from '../foundation/client.js';
import { useSession } from '../foundation/Session.js';
import { m } from './messages.js';
import { reportFailure, reportUrl, type Filters, type ReportFailure } from './model.js';

/** GET 下载只保存服务端生成的 CSV；错误回执保留状态、错误码及限流时间。 */
async function fetchCsv(path: string, tenantId: string, signal: AbortSignal) {
  const response = await fetch(path, { credentials: 'same-origin', headers: { 'x-tenant-id': tenantId }, signal });
  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as
      { error?: { code?: string; details?: unknown } } | undefined;
    const retry = response.headers.get('retry-after');
    throw new ApiError(
      response.status,
      payload?.error?.code ?? 'REQUEST_FAILED',
      'unknown',
      m.exportFailed,
      payload?.error,
      retry && /^\d+$/.test(retry) ? Number(retry) : undefined,
    );
  }
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'text/csv') throw new Error(m.exportFailed);
  return response.blob();
}
export function ReportExport({
  report,
  filters,
  disabled,
  onFailure,
}: {
  report: PersonnelReport;
  filters: Filters;
  disabled: boolean;
  onFailure(failure?: ReportFailure): void;
}) {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const urls = useRef(new Set<string>());
  useLayoutEffect(() => {
    const downloads = urls.current;
    return () => {
      controller.current?.abort();
      for (const url of downloads) URL.revokeObjectURL(url);
      downloads.clear();
    };
  }, []);
  const start = async () => {
    if (disabled || controller.current) return;
    setBusy(true);
    onFailure();
    const active = new AbortController();
    controller.current = active;
    try {
      const blob = await fetchCsv(reportUrl(report, filters, undefined, true), session.tenantId, active.signal);
      if (active.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      urls.current.add(url);
      const link = document.createElement('a');
      link.href = url;
      link.download = `report-${report.code}.csv`;
      link.click();
      // 给浏览器时间接管文件；页面离开时立即释放尚存的句柄。
      setTimeout(() => {
        if (urls.current.delete(url)) URL.revokeObjectURL(url);
      }, 1000);
    } catch (error) {
      if (!active.signal.aborted) onFailure(reportFailure(error));
    } finally {
      if (!active.signal.aborted) {
        controller.current = null;
        setBusy(false);
      }
    }
  };
  return (
    <Button loading={busy} disabled={disabled || busy} onClick={() => void start()}>
      {m.export}
    </Button>
  );
}
