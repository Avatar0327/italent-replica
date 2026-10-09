import { SelfServiceShell } from '../self-service/shared/SelfServiceShell.js';
import { AvatarSettings } from './AvatarSettings.js';
import { accountText as text } from './messages.js';

export function AccountPage() {
  return (
    <SelfServiceShell title={text.title}>
      {(tenantId) => (
        <>
          <AvatarSettings tenantId={tenantId} />
          <p>
            <a href="/self">{text.selfService}</a>
          </p>
        </>
      )}
    </SelfServiceShell>
  );
}
