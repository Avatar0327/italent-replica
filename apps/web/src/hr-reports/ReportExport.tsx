import { Button } from 'antd';
import { useEffect, useRef, useState } from 'react';
import type { PersonnelReport } from '@italent/domain';
import { useSession } from '../foundation/Session.js';
import { m } from './messages.js';
import { reportUrl, type Filters } from './model.js';
class ExportFailure extends Error {}
/** GET 下载没有写命令；只保存服务端生成的 CSV，未授权/格式错误不能落盘为假成功。 */
async function fetchCsv(path: string, tenantId: string, signal: AbortSignal) {
  const response = await fetch(path, { credentials: 'same-origin', headers: { 'x-tenant-id': tenantId }, signal });
  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as
      { error?: { details?: { reason?: string } } } | undefined;
    const reason = payload?.error?.details?.reason;
    let message: string = m.exportFailed;
    if (reason === 'EXPORT_ROW_LIMIT') message = m.exportLimit;
    if (response.status === 429) message = m.rateLimit;
    if (response.status === 401) message = m.expired;
    if (response.status === 403) message = m.exportDenied;
    throw new ExportFailure(message);
  }
  if (!response.headers.get('content-type')?.includes('text/csv')) throw new ExportFailure(m.exportFailed);
  return response.blob();
}
export function ReportExport({ report, filters }: { report: PersonnelReport; filters: Filters }) {
  const session = useSession();
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  const start = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    const active = new AbortController();
    controller.current = active;
    try {
      const blob = await fetchCsv(reportUrl(report, filters, undefined, true), session.tenantId, active.signal);
      if (active.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `report-${report.code}.csv`;
      link.click();
      // 浏览器开始读取后再释放；不是重新生成 CSV，也不解析服务端给出的文件名。
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      if (!active.signal.aborted) setError(error instanceof ExportFailure ? error.message : m.exportFailed);
    } finally {
      if (!active.signal.aborted) {
        running.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <>
      <Button loading={busy} onClick={() => void start()}>
        {m.export}
      </Button>
      {error && <span role="alert">{error}</span>}
    </>
  );
}
