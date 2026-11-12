import { Button, Table } from 'antd';
import { useState } from 'react';
import { PAGE_CATALOG, PAGE_CARRIERS } from '@italent/domain';
import type { ProfileDetail } from './object-dialog-model.js';
import { pageState, profileMenuGroups } from './page-permission-model.js';
import { PagePermissionDialog } from './PagePermissionDialog.js';
import { pageAppName, pm } from './page-messages.js';

export function PagePermissions({
  profile,
  editable,
  refresh,
}: {
  profile: ProfileDetail;
  editable: boolean;
  refresh(): void;
}) {
  const [target, setTarget] = useState<{ objectCode: string; remove?: string }>();
  return (
    <>
      <p>{pm.union}</p>
      {PAGE_CARRIERS.map((carrier) => {
        const pages = PAGE_CATALOG.filter((page) => page.carrierObject === carrier.code);
        const rows = pages
          .map((page) => ({ ...page, ...pageState(profile, page) }))
          .filter((page) => page.granted || page.missingApp);
        return (
          <section key={carrier.code}>
            <h3>{pageAppName(carrier.application)}</h3>
            {editable && <Button onClick={() => setTarget({ objectCode: carrier.code })}>{pm.add}</Button>}
            <Table
              rowKey="pageCode"
              pagination={false}
              dataSource={rows}
              locale={{ emptyText: pm.empty }}
              rowClassName={(row) => (row.missingApp ? 'page-permission-missing' : '')}
              columns={[
                { title: pm.name, dataIndex: 'name' },
                { title: pm.code, dataIndex: 'pageCode' },
                { title: pm.app, render: (_, row) => pageAppName(row.appCode) },
                {
                  title: pm.status,
                  render: (_, row) =>
                    row.missingApp ? (
                      <span>
                        {pm.missing} · {pm.needsApp(pageAppName(row.appCode))}
                      </span>
                    ) : row.implicit ? (
                      pm.defaultGranted
                    ) : (
                      pm.granted
                    ),
                },
                ...(editable
                  ? [
                      {
                        title: pm.operation,
                        render: (_: unknown, row: (typeof rows)[number]) => (
                          <Button
                            disabled={row.missingApp}
                            onClick={() => setTarget({ objectCode: carrier.code, remove: row.pageCode })}
                          >
                            {pm.remove}
                          </Button>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          </section>
        );
      })}
      {target && (
        <PagePermissionDialog
          profile={profile}
          {...target}
          editable={editable}
          close={() => setTarget(undefined)}
          saved={() => {
            setTarget(undefined);
            refresh();
          }}
        />
      )}
    </>
  );
}
export function ProfileMenus({ profile }: { profile: ProfileDetail }) {
  return (
    <>
      <p>{pm.menuHint}</p>
      {profileMenuGroups(profile).map((group) => (
        <section key={group.appCode}>
          <h3>{pageAppName(group.appCode)}</h3>
          {group.objects.length ? (
            <ul>
              {group.objects.map((code) => (
                <li key={code}>{code}</li>
              ))}
            </ul>
          ) : (
            <p>{pm.noEntries}</p>
          )}
        </section>
      ))}
    </>
  );
}
