import { Button } from 'antd';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSession } from '../foundation/Session.js';
import { xi } from './messages.js';
import { importPath } from './exit-import-model.js';

/** F-493 §9.2 / §9.5 共用下载入口，服务端重新验权与判断保留期。 */
export function ImportFileDownload({ businessId, children }: { businessId: string; children: ReactNode }) {
  const { tenantId, identityKey } = useSession();
  const running = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setBusy(false);
    setError('');
    return () => running.current?.abort();
  }, [tenantId, identityKey, businessId]);
  const download = async () => {
    if (running.current && !running.current.signal.aborted) return;
    const controller = new AbortController();
    running.current = controller;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${importPath}/batches/${encodeURIComponent(businessId)}/error-file`, {
        credentials: 'same-origin',
        headers: { 'x-tenant-id': tenantId },
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { code?: string; details?: { reason?: string } };
        } | null;
        if (!controller.signal.aborted)
          setError(
            response.status === 404 &&
              payload?.error?.code === 'NOT_FOUND' &&
              payload.error.details?.reason === 'EXIT_IMPORT_FILE_EXPIRED'
              ? xi.fileExpired
              : xi.fileDownloadFailed,
          );
        return;
      }
      if (!response.headers.get('content-type')?.includes('spreadsheetml.sheet')) throw new Error();
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      const disposition = response.headers.get('content-disposition') ?? '';
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
      const filename = encoded ? decodeURIComponent(encoded) : /filename="([^"]+)"/i.exec(disposition)?.[1];
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename ?? xi.errorFileName;
        anchor.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    } catch {
      if (!controller.signal.aborted) setError(xi.fileDownloadFailed);
    } finally {
      if (!controller.signal.aborted) {
        running.current = null;
        setBusy(false);
      }
    }
  };
  return (
    <>
      <Button type="link" loading={busy} disabled={busy} onClick={() => void download()}>
        {children}
      </Button>
      {error && <span role="alert">{error}</span>}
    </>
  );
}
