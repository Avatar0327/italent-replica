import { Button, Dropdown } from 'antd';
import { useEffect, useRef, useState } from 'react';
import type { PersonnelReport } from '@italent/domain';
import { useSession } from '../foundation/Session.js';
import { m } from './messages.js';
import { reportUrl, type ExportMode, type Filters } from './model.js';

const XLSX = 'spreadsheetml.sheet';
class ExportFailure extends Error {}

/** 服务端文件名走 filename*（UTF-8 百分号编码）；取不到就用报表名，文件名规则 = 报表名.xlsx。 */
function fileNameOf(response: Response, fallback: string) {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('content-disposition') ?? '')?.[1];
  try {
    return encoded ? decodeURIComponent(encoded) : fallback;
  } catch {
    return fallback;
  }
}
const failureOf = (status: number) =>
  (({ 400: m.invalid, 401: m.expired, 403: m.exportDenied, 429: m.rateLimit }) as Record<number, string | undefined>)[
    status
  ] ?? m.exportFailed;

/** GET 下载没有写命令；同步生成，只保存服务端返回的 xlsx，错误响应不能落盘成假成功。 */
async function fetchXlsx(path: string, tenantId: string, signal: AbortSignal, fallbackName: string) {
  const response = await fetch(path, { credentials: 'same-origin', headers: { 'x-tenant-id': tenantId }, signal });
  if (!response.ok) throw new ExportFailure(failureOf(response.status));
  if (!response.headers.get('content-type')?.includes(XLSX)) throw new ExportFailure(m.exportFailed);
  return { blob: await response.blob(), fileName: fileNameOf(response, fallbackName) };
}

/** 三张统计报表的「下载▾」：两项（含公式 / 仅数据），用页面已运行的筛选；不做订阅与打印（DEC-809③）。 */
export function StatExport({ report, filters }: { report: PersonnelReport; filters: Filters }) {
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
  const start = async (mode: ExportMode) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    const active = new AbortController();
    controller.current = active;
    try {
      const url = reportUrl(report, filters, undefined, true, mode);
      const file = await fetchXlsx(url, session.tenantId, active.signal, `${report.name}.xlsx`);
      if (active.signal.aborted) return;
      const objectUrl = URL.createObjectURL(file.blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = file.fileName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (failure) {
      if (!active.signal.aborted) setError(failure instanceof ExportFailure ? failure.message : m.exportFailed);
    } finally {
      if (!active.signal.aborted) {
        running.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <>
      <Dropdown
        trigger={['click']}
        disabled={busy}
        menu={{
          items: [
            { key: 'formula', label: m.downloadFormula },
            { key: 'data', label: m.downloadData },
          ],
          onClick: ({ key }) => void start(key as ExportMode),
        }}
      >
        <Button loading={busy} disabled={busy}>
          {m.download} ▾
        </Button>
      </Dropdown>
      {error && <span role="alert">{error}</span>}
    </>
  );
}
