import { useState } from 'react';
import { PersonAvatar } from '../shared/PersonAvatar.js';
import { AVATAR_ACCEPT, avatarFileError } from './avatar-api.js';
import { accountText as text } from './messages.js';
import { useAvatarReader } from './useAvatarReader.js';
import { useAvatarWriter } from './useAvatarWriter.js';
import './account.css';

export function AvatarSettings({ tenantId }: { readonly tenantId: string }) {
  return <AvatarSettingsSession key={tenantId} tenantId={tenantId} />;
}

function AvatarSettingsSession({ tenantId }: { readonly tenantId: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState('');
  const [inputKey, setInputKey] = useState(0);
  const reader = useAvatarReader(tenantId);
  const writer = useAvatarWriter(tenantId, reader, () => {
    setFile(null);
    setFileError('');
    setInputKey((value) => value + 1);
  });
  const busy = reader.reading || writer.busy;
  const blocked = busy || writer.blocked || !reader.view;
  const error = reader.error || fileError || writer.error;
  return (
    <section className="transfer-content account-settings" aria-label={text.account} aria-busy={busy}>
      <h2>{text.account}</h2>
      <div className="account-avatar-summary">
        {reader.view && (
          <PersonAvatar tenantId={tenantId} name={reader.view.name} avatar={reader.view.avatar} size={80} />
        )}
        <div>
          <h3>{reader.view?.name ?? text.avatar}</h3>
          <p>{text.explanation}</p>
        </div>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (file && !blocked) writer.save(file);
        }}
      >
        <label>
          {text.select}
          <input
            key={inputKey}
            type="file"
            accept={AVATAR_ACCEPT}
            disabled={blocked}
            onChange={(event) => {
              const next = event.target.files?.[0] ?? null;
              const problem = next ? avatarFileError(next) : null;
              setFileError(problem ?? '');
              setFile(problem ? null : next);
            }}
          />
        </label>
        <p className="account-avatar-hint">{text.hint}</p>
        <div className="transfer-actions">
          <button type="submit" disabled={blocked || !file}>
            {text.save}
          </button>
          {reader.view?.avatar && (
            <button type="button" disabled={blocked} onClick={writer.remove}>
              {text.delete}
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => void writer.refresh()}>
            {text.refresh}
          </button>
        </div>
      </form>
      {busy && <p role="status">{text.loading}</p>}
      {error && (
        <p role="alert" className="transfer-error">
          {error}
        </p>
      )}
      {writer.notice && (
        <p role="status" className="transfer-notice">
          {writer.notice}
        </p>
      )}
    </section>
  );
}
