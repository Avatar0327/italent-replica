import { useState } from 'react';
import { MODEL_IMAGE_ACCEPT, modelImageFileError, modelImagePath } from './model-image-api.js';
import { modelImageText as text } from './model-image-messages.js';
import { useModelImageReader } from './useModelImageReader.js';
import { useModelImageWriter } from './useModelImageWriter.js';

interface Props {
  readonly tenantId: string;
  readonly criterionId: string;
  readonly locked?: boolean;
}

/** 租户 / 标准切换重新创建会话，旧异步请求不能向新详情填入图片或待重放命令。 */
export function PotentialModelImage(props: Props) {
  return <ModelImageSession key={`${props.tenantId}:${props.criterionId}`} {...props} />;
}

function ModelImageSession({ tenantId, criterionId, locked = false }: Props) {
  const [editing, setEditing] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState('');
  const reader = useModelImageReader(tenantId, modelImagePath(criterionId));
  const writer = useModelImageWriter(tenantId, modelImagePath(criterionId), reader, () => {
    setEditing(false);
    setFile(null);
    setFileError('');
  });
  const busy = reader.reading || writer.busy;
  const blocked = locked || busy || !!writer.unknown || !reader.view?.canEdit;
  const error = reader.error || fileError || writer.error;
  return (
    <section aria-label={text.overview} aria-busy={busy}>
      <p>{text.explanation}</p>
      <h3>{text.overview}</h3>
      {reader.preview ? (
        <img src={reader.preview} alt={text.alt} style={{ maxWidth: '100%', height: 'auto' }} />
      ) : (
        !reader.reading && <p>{text.empty}</p>
      )}
      <ModelImageControls
        hasImage={!!reader.view?.modelImage}
        canEdit={!!reader.view?.canEdit}
        blocked={blocked}
        onEdit={() => {
          setFile(null);
          setFileError('');
          setEditing(true);
        }}
        onDelete={writer.remove}
      />
      {editing && reader.view?.canEdit && (
        <ModelImageEditor
          blocked={blocked}
          file={file}
          onFile={(next) => {
            const problem = next ? modelImageFileError(next) : null;
            setFileError(problem ?? '');
            setFile(problem ? null : next);
          }}
          onSave={() => file && void writer.save(file)}
          onCancel={() => setEditing(false)}
        />
      )}
      {error && <p role="alert">{error}</p>}
      {writer.notice && <p role="status">{writer.notice}</p>}
      <button disabled={busy || locked} onClick={() => void writer.refresh()}>
        {text.refresh}
      </button>
      {writer.unknown && (
        <button disabled={busy || locked || !writer.checked || !reader.view?.canEdit} onClick={writer.retry}>
          {text.retry}
        </button>
      )}
    </section>
  );
}

function ModelImageControls({
  hasImage,
  canEdit,
  blocked,
  onEdit,
  onDelete,
}: {
  hasImage: boolean;
  canEdit: boolean;
  blocked: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  if (!canEdit) return <p role="note">{text.readOnly}</p>;
  return (
    <>
      <button disabled={blocked} onClick={onEdit}>
        {hasImage ? text.replace : text.settings}
      </button>
      {hasImage && (
        <button disabled={blocked} onClick={onDelete}>
          {text.delete}
        </button>
      )}
    </>
  );
}

function ModelImageEditor({
  blocked,
  file,
  onFile,
  onSave,
  onCancel,
}: {
  blocked: boolean;
  file: File | null;
  onFile: (file: File | null) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!blocked && file) onSave();
      }}
    >
      <label>
        {text.label}
        <input
          type="file"
          accept={MODEL_IMAGE_ACCEPT}
          disabled={blocked}
          onChange={(event) => onFile(event.target.files?.[0] ?? null)}
        />
      </label>
      <button type="submit" disabled={blocked || !file}>
        {text.save}
      </button>
      <button type="button" disabled={blocked} onClick={onCancel}>
        {text.cancel}
      </button>
    </form>
  );
}
