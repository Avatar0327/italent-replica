import { Button, Input, Select } from 'antd';
import { useState } from 'react';
import { FilterDrawer } from '../foundation/index.js';
import { pageText as m } from './messages.js';
interface Filters {
  name: string;
  status: string;
}
export function CatalogFilters({
  value,
  statuses,
  clearStatus,
  onApply,
}: {
  value: Filters;
  statuses: { value: string; label: string }[];
  clearStatus: string;
  onApply(value: Filters): void;
}) {
  const [draft, setDraft] = useState<Filters>();
  const close = () => setDraft(undefined);
  return (
    <>
      <Button type="link" onClick={() => setDraft({ ...value })}>
        {m.advanced}
      </Button>
      <FilterDrawer
        open={!!draft}
        onClose={close}
        onClear={() => setDraft({ name: '', status: clearStatus })}
        onApply={() => {
          if (draft) onApply(draft);
          close();
        }}
      >
        {draft && (
          <>
            <h2 className="form-group-title">{m.customSearch}</h2>
            <label className="r1-filter-field">
              <span>{m.filterName}</span>
              <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </label>
            <label className="r1-filter-field">
              <span>{m.status}</span>
              <Select
                aria-label={m.status}
                value={draft.status}
                options={statuses}
                onChange={(status) => setDraft({ ...draft, status })}
              />
            </label>
          </>
        )}
      </FilterDrawer>
    </>
  );
}
