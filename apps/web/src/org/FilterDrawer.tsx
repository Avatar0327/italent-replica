import { Button, Drawer, Input, Select, Space } from 'antd';
import { useState } from 'react';
import { pageText as m } from './messages.js';
interface Filters {
  name: string;
  status: string;
}
export function FilterDrawer({
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
      <Drawer
        open={!!draft}
        width={500}
        title={m.advanced}
        onClose={close}
        rootClassName="r1-filter-drawer"
        footer={
          <div className="r1-filter-footer">
            <Button type="text" onClick={() => setDraft({ name: '', status: clearStatus })}>
              {m.clear}
            </Button>
            <Space>
              <Button onClick={close}>{m.cancel}</Button>
              <Button
                type="primary"
                onClick={() => {
                  if (draft) onApply(draft);
                  close();
                }}
              >
                {m.filterConfirm}
              </Button>
            </Space>
          </div>
        }
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
      </Drawer>
    </>
  );
}
