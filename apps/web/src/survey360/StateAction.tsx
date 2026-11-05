import { Button } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useApiClient } from '../foundation/Session.js';
import { usePermissions } from '../foundation/Permissions.js';
import { FormOverlay } from '../foundation/FormOverlay.js';
import { useConflictCommand } from '../foundation/forms/ConflictCommands.js';
import { surveyReceipt } from './useSurveyForm.js';
import type { Row } from '../evaluation/model.js';
import { m } from './messages.js';
import { surveyPath, type SurveyKind } from './model.js';

/** 列表与详情共用原单恢复槽；启停不是字段编辑，不提交展示字段。 */
export function StateAction({ row, kind, saved }: { row: Row; kind: SurveyKind; saved(): void }) {
  const permission = usePermissions(kind === 'activities' ? 'Survey360.Activity' : 'Survey360.Questionnaire');
  const api = useApiClient();
  const [open, setOpen] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const path = `/api/tenant/survey360${surveyPath(kind)}`;
  const action = kind === 'activities' && row.status === 'enabled' ? 'disable' : 'enable';
  const writer = useConflictCommand(
    path,
    { id: row.id, revision: row.revision, values: row },
    async () => {
      const latest = await api.request<Row>(`${path}/${row.id}`);
      return { id: latest.id, revision: latest.revision, values: latest };
    },
    { action },
  );
  const allowed =
    permission.field('status').visible &&
    permission.can(action) &&
    permission.snapshot.objects[kind === 'activities' ? 'Survey360.Activity' : 'Survey360.Questionnaire']
      ?.dataOperations.update &&
    (kind === 'activities'
      ? ['draft', 'enabled', 'disabled'].includes(row.status ?? '')
      : kind === 'questionnaires' && row.status === 'draft');
  if (!allowed) return null;
  return (
    <>
      <Button type="link" disabled={writer.invalid} onClick={() => setOpen(true)}>
        {m[action]}
      </Button>
      {open && (
        <FormOverlay
          open
          mode="modal"
          recordKey={row.id}
          title={m[action]}
          submission={writer.form}
          groups={[{ title: m.confirmBody, fields: [] }]}
          onClose={() => {
            setOpen(false);
            if (writer.stale) saved();
          }}
          onSubmit={async () => {
            await writer.run({
              values: {},
              editableFields: [],
              send: async ({ command }) => {
                const result = await api.request<Row>(`${path}/${row.id}/${action}`, { method: 'POST', command });
                return surveyReceipt(result, command.revision ?? 0, row.id);
              },
            });
            if (alive.current) {
              saved();
              setOpen(false);
            }
          }}
        />
      )}
    </>
  );
}
