import { text } from './messages.js';
export interface Choice {
  readonly id: string;
  readonly name: string;
}
export interface JobValue {
  readonly name: string;
  readonly sequenceId: string | null;
  readonly effectiveDate: string;
  readonly orgId?: string;
  readonly postId?: string;
}
export function sequenceSyncVisible(editing: boolean, sequenceId: string | null, original: string | null) {
  return editing && !!sequenceId && sequenceId !== original;
}
export function JobForm({
  kind,
  editing,
  originalSequenceId,
  value,
  sequences,
  organizations = [],
  posts = [],
  busy = false,
  onChange,
  onSubmit,
}: {
  kind: 'posts' | 'positions';
  editing: boolean;
  originalSequenceId: string | null;
  value: JobValue;
  sequences: readonly Choice[];
  organizations?: readonly Choice[];
  posts?: readonly Choice[];
  busy?: boolean;
  onChange: (value: JobValue) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <fieldset disabled={busy}>
        <label>
          {text.name}
          <input
            name="name"
            required
            maxLength={200}
            value={value.name}
            onChange={(event) => onChange({ ...value, name: event.target.value })}
          />
        </label>
        <label>
          {text.sequence}
          <select
            name="sequenceId"
            value={value.sequenceId ?? ''}
            onChange={(event) => onChange({ ...value, sequenceId: event.target.value || null })}
          >
            <option value="">{text.empty}</option>
            {sequences.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        {kind === 'positions' && !editing && (
          <PositionReferences value={value} organizations={organizations} posts={posts} onChange={onChange} />
        )}
        {sequenceSyncVisible(editing, value.sequenceId, originalSequenceId) && (
          <label>
            {text.sync}
            <input type="checkbox" name="syncSequenceToAssignments" disabled checked readOnly />
            {text.yes}
          </label>
        )}
        <button type="submit">{text.save}</button>
      </fieldset>
    </form>
  );
}

function PositionReferences({
  value,
  organizations,
  posts,
  onChange,
}: {
  value: JobValue;
  organizations: readonly Choice[];
  posts: readonly Choice[];
  onChange: (value: JobValue) => void;
}) {
  return (
    <>
      {(['orgId', 'postId'] as const).map((field) => (
        <label key={field}>
          {field === 'orgId' ? text.org : text.post}
          <select
            name={field}
            required
            value={value[field] ?? ''}
            onChange={(event) => onChange({ ...value, [field]: event.target.value })}
          >
            <option value="">{text.empty}</option>
            {(field === 'orgId' ? organizations : posts).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      ))}
    </>
  );
}
