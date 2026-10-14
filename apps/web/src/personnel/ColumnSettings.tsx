import { Button, Checkbox, Input, Modal, Popover } from 'antd';
import { useState } from 'react';
import {
  columnChoices,
  columnGroupState,
  lockedColumn,
  matchColumns,
  moveColumn,
  restoreDefaultColumns,
  toggleColumn,
  toggleColumnGroup,
  visibleColumns,
} from './model.js';
import { m } from './messages.js';

/** 表头右侧齿轮。原站弹层另有“显示图表”“选择间距类型”，复刻未提供（见 PR 后端缺口与未决）。 */
export function ColumnGear({ onOpen }: { onOpen(): void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="bottomRight"
      arrow={false}
      content={
        <Button
          type="text"
          className="staff-gear-item"
          onClick={() => {
            setOpen(false);
            onOpen();
          }}
        >
          {m.columnTitle}
          <span className="staff-gear-chevron" aria-hidden="true" />
        </Button>
      }
    >
      <Button type="text" size="small" className="staff-gear" aria-label={m.columns} icon={<GearIcon />} />
    </Popover>
  );
}

/** 原站“设置显示字段”居中双栏弹窗：左栏勾选、右栏拖拽排序，确定后才应用到列表。 */
export function ColumnSettings({
  value,
  allowed,
  onApply,
  onClose,
}: {
  value: string[];
  allowed: readonly string[];
  onApply(value: string[]): void;
  onClose(): void;
}) {
  const [draft, setDraft] = useState(value);
  const [keyword, setKeyword] = useState('');
  const choices = columnChoices.filter((key) => allowed.includes(key));
  const picked = visibleColumns(draft, allowed);
  return (
    <Modal
      open
      centered
      width={640}
      title={m.columnTitle}
      wrapClassName="staff-columns-modal"
      onCancel={onClose}
      footer={
        <div className="staff-columns-footer">
          <span className="staff-muted">{m.localColumns}</span>
          <Button onClick={onClose}>{m.cancel}</Button>
          <Button
            type="primary"
            onClick={() => {
              onApply(draft);
              onClose();
            }}
          >
            {m.confirm}
          </Button>
        </div>
      }
    >
      <Input
        type="search"
        aria-label={m.searchFields}
        placeholder={m.searchFields}
        value={keyword}
        maxLength={50}
        onChange={(event) => setKeyword(event.target.value)}
      />
      <div className="staff-columns-panes">
        <AllFields draft={draft} choices={matchColumns(choices, keyword)} setDraft={setDraft} />
        <section className="staff-columns-pane">
          <header>
            <span>{m.selectedFields(picked.length, choices.length)}</span>
            <Button type="link" size="small" onClick={() => setDraft(restoreDefaultColumns())}>
              {m.restoreDefault}
            </Button>
          </header>
          <SelectedFields
            keys={picked}
            onMove={(key, target) => setDraft((previous) => moveColumn(previous, key, target))}
          />
        </section>
      </div>
    </Modal>
  );
}

/** 左栏全部字段：搜索只过滤显示，分组勾选作用于当前可见的字段。 */
function AllFields({
  draft,
  choices,
  setDraft,
}: {
  draft: string[];
  choices: string[];
  setDraft(update: (previous: string[]) => string[]): void;
}) {
  const group = columnGroupState(draft, choices);
  return (
    <section className="staff-columns-pane">
      <header>{m.allFields}</header>
      <Checkbox
        checked={group.checked}
        indeterminate={group.indeterminate}
        onChange={(event) => setDraft((previous) => toggleColumnGroup(previous, choices, event.target.checked))}
      >
        {m.listFields}
      </Checkbox>
      <div className="staff-column-options">
        {/* 不用 Checkbox.Group：它把受控 value 镜像进内部 state，连续点击会拿旧 value 覆盖前一次操作（#318）。 */}
        {choices.map((key) => (
          <Checkbox
            key={key}
            value={key}
            disabled={key === lockedColumn}
            checked={draft.includes(key)}
            onChange={(event) => setDraft((previous) => toggleColumn(previous, key, event.target.checked))}
          >
            {m.labels[key]}
          </Checkbox>
        ))}
      </div>
    </section>
  );
}

/** 右栏已选字段：HTML5 拖放，放到目标项即占据其位置；员工姓名不可拖动。 */
function SelectedFields({ keys, onMove }: { keys: string[]; onMove(key: string, target: string): void }) {
  const [dragging, setDragging] = useState<string>();
  return (
    <ul className="staff-columns-selected" aria-label={m.selectedFieldsLabel}>
      {keys.map((key) => (
        <li
          key={key}
          aria-label={m.labels[key]}
          draggable={key !== lockedColumn}
          className={[key === lockedColumn && 'is-locked', key === dragging && 'is-dragging'].filter(Boolean).join(' ')}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', key);
            setDragging(key);
          }}
          onDragOver={(event) => {
            if (dragging) event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            if (dragging) onMove(dragging, key);
            setDragging(undefined);
          }}
          onDragEnd={() => setDragging(undefined)}
        >
          {key === lockedColumn ? <LockIcon /> : <HandleIcon />}
          {m.labels[key]}
        </li>
      ))}
    </ul>
  );
}

function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor">
      <circle cx="8" cy="8" r="2.2" strokeWidth="1.4" />
      <path
        strokeWidth="1.4"
        d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"
      />
    </svg>
  );
}
function HandleIcon() {
  return (
    <svg className="staff-columns-icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2 3h8M2 6h8M2 9h8" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
function LockIcon() {
  return (
    <svg className="staff-columns-icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none">
      <rect x="2.5" y="5.5" width="7" height="5" rx="1" stroke="currentColor" />
      <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" stroke="currentColor" />
    </svg>
  );
}
