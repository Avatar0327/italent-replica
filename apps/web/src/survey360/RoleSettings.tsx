import { Alert, Button, Modal, Radio, Space } from 'antd';
import { useState } from 'react';
import { usePermissions } from '../foundation/Permissions.js';
import { PageState } from '../foundation/PageState.js';
import { useRead } from '../evaluation/runtime.js';
import type { Row } from '../evaluation/model.js';
import { m as common } from '../evaluation/messages.js';
import { m } from './messages.js';
import { ui } from './alignment.js';
import { alignedColumns, Filters, PendingButtons, SurveyTable, Unverified } from './Presentation.js';

export function RoleSettings() {
  const permission = usePermissions('Survey360.Settings');
  const allowed = !!permission.snapshot.objects['Survey360.Settings'];
  const list = useRead<{ items: Row[] }>(allowed ? '/api/tenant/survey360/roles' : undefined);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(true);
  if (!allowed) return <PageState kind="forbidden" />;
  return (
    <section className="survey-panel">
      <header>
        <h1>{ui.roleSettings}</h1>
        <Space>
          {permission.can('create', 'list') && <PendingButtons labels={[ui.addRole]} />}
          <Button onClick={() => setOpen(true)}>{ui.defaultDisplay}</Button>
        </Space>
      </header>
      <Alert
        type="info"
        showIcon
        message={expanded ? ui.roleHint : ui.roleSettings}
        action={
          <Button type="text" onClick={() => setExpanded(!expanded)}>
            {expanded ? ui.collapse : ui.expand}
          </Button>
        }
      />
      <div className="survey-toolbar">
        <Filters fields={permission.field('name').visible ? [ui.roleName] : []} />
        <Button onClick={list.reload}>{common.refresh}</Button>
      </div>
      <SurveyTable
        rows={list.data?.items ?? []}
        loading={list.loading}
        error={list.error}
        reload={list.reload}
        columns={alignedColumns(
          'roles',
          (field) => permission.field(field).visible,
          {},
          {
            width: 180,
            render: () => (permission.can('update') ? <PendingButtons labels={[m.edit]} /> : null),
          },
        )}
      />
      <Modal
        open={open}
        title={ui.defaultDisplay}
        width={750}
        onCancel={() => setOpen(false)}
        footer={
          <Space>
            <Button onClick={() => setOpen(false)}>{ui.cancel}</Button>
            <Button type="primary" disabled>
              {ui.confirm}
            </Button>
          </Space>
        }
      >
        <Alert type="info" showIcon message={ui.defaultHint} />
        <p>{ui.roleDisplay}</p>
        <Radio.Group disabled options={ui.roleOptions.map((label) => ({ value: label, label }))} />
        <Unverified missingContract />
      </Modal>
    </section>
  );
}
