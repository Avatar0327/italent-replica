import { Descriptions, Table } from 'antd';
import { useState } from 'react';
import { m } from './messages.js';
import { settings } from './settings-messages.js';

export function OfferSettings() {
  const [id, setId] = useState(settings[0]!.id);
  const setting = settings.find((s) => s.id === id)!;
  return (
    <>
      <h1>{m.settings}</h1>
      <p>{m.readonly}</p>
      <div className="offer-settings-layout">
        <nav aria-label={m.settingsNav}>
          {(['Offer管理', '入职'] as const).map((group) => (
            <section key={group}>
              <h2>{group}</h2>
              {settings
                .filter((s) => s.group === group)
                .map((s) => (
                  <button key={s.id} onClick={() => setId(s.id)} aria-current={id === s.id ? 'page' : undefined}>
                    {s.title}
                  </button>
                ))}
            </section>
          ))}
        </nav>
        <section className="list-card" role="region" aria-label={m.summary}>
          <p>
            {m.settingsRoot} &gt; {setting.title}
          </p>
          <h2>{setting.title}</h2>
          {setting.values && (
            <Descriptions
              column={1}
              items={setting.values.map(([label, value]) => ({ key: label, label, children: value }))}
            />
          )}
          {setting.note && <p>{setting.note}</p>}
          {setting.columns && (
            <Table
              size="small"
              pagination={false}
              rowKey="key"
              scroll={{ x: 'max-content' }}
              columns={setting.columns.map((label, index) => ({
                title: label,
                key: label,
                width: 170,
                render: (_, row) => row.values[index] ?? m.empty,
              }))}
              dataSource={setting.rows?.map((values, index) => ({ key: index, values })) ?? []}
            />
          )}
        </section>
      </div>
    </>
  );
}
