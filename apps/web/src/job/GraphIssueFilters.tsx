import { Button, Input, Select } from 'antd';
import { useState } from 'react';
import { FilterDrawer } from '../foundation/index.js';
import { ui } from '../foundation/messages.js';
import { graphText as t } from './messages.js';

export interface IssueFilters {
  kind: string;
  name: string;
}
const cleared: IssueFilters = { kind: '', name: '' };

/** 待确认记录的高级筛选（设计 §5：类型、名称）：抽屉里编辑草稿，确认才应用，取消不应用。 */
export function GraphIssueFilters({ value, onApply }: { value: IssueFilters; onApply(value: IssueFilters): void }) {
  const [draft, setDraft] = useState<IssueFilters>();
  const close = () => setDraft(undefined);
  return (
    <>
      <Button type="link" onClick={() => setDraft({ ...value })}>
        {ui.advancedFilter}
      </Button>
      <FilterDrawer
        open={!!draft}
        onClose={close}
        onClear={() => setDraft(cleared)}
        onApply={() => {
          if (draft) onApply({ kind: draft.kind, name: draft.name.trim() });
          close();
        }}
      >
        {draft && (
          <>
            <label className="r1-filter-field">
              <span>{t.kind}</span>
              <Select
                aria-label={t.kind}
                value={draft.kind}
                onChange={(kind) => setDraft({ ...draft, kind })}
                options={[
                  { value: '', label: t.allKinds },
                  { value: 'level', label: t.kinds.level },
                  { value: 'post', label: t.kinds.post },
                ]}
              />
            </label>
            <label className="r1-filter-field">
              <span>{t.name}</span>
              <Input
                aria-label={t.name}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
          </>
        )}
      </FilterDrawer>
    </>
  );
}
