import { useEffect, useState } from 'react';
import { demoText } from './messages.js';
import './demo.css';

interface Persona {
  readonly userId: string;
  readonly name: string;
  readonly role: string;
  readonly entry: string;
  readonly entryLabel?: string;
}
interface Manifest {
  readonly tenantId: string | null;
  readonly personas: readonly Persona[];
  readonly current: string | null;
}

// Cookie 名与 apps/web/dev/demo-identity.ts 一致：浏览器只记选择，签名由 vite 开发代理完成
const USER_COOKIE = 'italent_demo_user';
const TENANT_COOKIE = 'italent_demo_tenant';

function setCookie(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; SameSite=Strict`;
}

/** 开发模式“切换演示身份”工具条（F-025）：选人后刷新页面，后续 /api 请求由开发代理按所选用户签名。 */
export function DemoIdentitySwitcher() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void fetch('/__demo/personas')
      .then((response) => response.json() as Promise<Manifest>)
      .then(setManifest)
      .catch(() => setError(demoText.failed));
  }, []);
  if (error) return <aside className="demo-bar">{error}</aside>;
  if (!manifest) return null;
  const current = manifest.personas.find((persona) => persona.userId === manifest.current);
  function choose(userId: string) {
    setCookie(USER_COOKIE, userId);
    if (manifest?.tenantId) setCookie(TENANT_COOKIE, manifest.tenantId);
    const persona = manifest?.personas.find((item) => item.userId === userId);
    window.location.assign(persona?.entry ?? '/');
  }
  return (
    <aside className="demo-bar" aria-label={demoText.badge}>
      <strong>{demoText.badge}</strong>
      {manifest.personas.length === 0 ? (
        <span>{demoText.missing}</span>
      ) : (
        <>
          <label>
            {demoText.switch}
            <select value={current?.userId ?? ''} onChange={(event) => choose(event.target.value)}>
              <option value="" disabled>
                {demoText.none}
              </option>
              {manifest.personas.map((persona) => (
                <option key={persona.userId} value={persona.userId}>
                  {persona.name}（{persona.role}）
                </option>
              ))}
            </select>
          </label>
          {current && (
            <a href={current.entry}>
              {demoText.entries}：{current.entryLabel ?? current.entry}
            </a>
          )}
          <span className="demo-tenant">
            {demoText.tenant}：<code>{manifest.tenantId}</code>
          </span>
        </>
      )}
    </aside>
  );
}
