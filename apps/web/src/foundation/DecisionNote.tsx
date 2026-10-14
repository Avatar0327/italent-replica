import { Alert, Switch, Tag } from 'antd';
import { createContext, useContext, useState, type ReactNode } from 'react';
import type { DecisionAnnotation } from '../annotations/index.js';
import { notes as foundationNotes } from './annotations.js';
import { ui } from './messages.js';

const NotesContext = createContext({ enabled: false, toggle() {}, notes: foundationNotes });
export function DecisionNotesProvider({
  children,
  notes = {},
}: {
  children: ReactNode;
  notes?: Record<string, DecisionAnnotation>;
}) {
  const [enabled, setEnabled] = useState(false);
  return (
    <NotesContext.Provider
      value={{ enabled, toggle: () => setEnabled((value) => !value), notes: { ...foundationNotes, ...notes } }}
    >
      {children}
    </NotesContext.Provider>
  );
}
export function DecisionNoteToggle() {
  const { enabled, toggle } = useContext(NotesContext);
  return (
    <label className="note-toggle">
      <span>{ui.notes}</span>
      <Switch size="small" aria-label={ui.notes} checked={enabled} onChange={toggle} />
    </label>
  );
}
export function DecisionNote({ id }: { id: string }) {
  const { enabled, notes } = useContext(NotesContext);
  const note = notes[id];
  if (!enabled || !note) return null;
  return (
    <aside className="decision-note" aria-label={ui.notes}>
      <Alert
        type="info"
        showIcon
        message={
          <>
            {note.decisions.map((code) => (
              <Tag key={code}>{code}</Tag>
            ))}
            <Tag>{note.level}</Tag>
          </>
        }
        description={
          <>
            <p>
              <strong>{ui.original}：</strong>
              {note.original}
            </p>
            <p>
              <strong>{ui.decision}：</strong>
              {note.decision}
            </p>
          </>
        }
      />
    </aside>
  );
}
