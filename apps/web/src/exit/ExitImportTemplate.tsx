import { Button } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useSession } from '../foundation/Session.js';
import { ui } from '../foundation/messages.js';
import { importPath } from './exit-import-model.js';
import { xi } from './messages.js';

/** 模板是固定 GET 文件，带租户头读取，服务端 filename* 优先。 */
export function ExitImportTemplate() {
  const session = useSession();
  const running = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(
    () => () => {
      running.current?.abort();
    },
    [session.tenantId, session.identityKey],
  );
  const download = async () => {
    if (running.current && !running.current.signal.aborted) return;
    const controller = new AbortController();
    running.current = controller;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${importPath}/template`, {
        credentials: 'same-origin',
        headers: { 'x-tenant-id': session.tenantId },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(response.status === 403 ? ui.denied : xi.errors.download);
      if (!response.headers.get('content-type')?.includes('spreadsheetml.sheet')) throw new Error(xi.errors.download);
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      const disposition = response.headers.get('content-disposition') ?? '';
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
      const filename = encoded ? decodeURIComponent(encoded) : /filename="([^"]+)"/i.exec(disposition)?.[1];
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename ?? xi.templateName;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error && cause.message === ui.denied ? ui.denied : xi.errors.download);
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
        {xi.template}
      </Button>
      {error && <span role="alert">{error}</span>}
    </>
  );
}
