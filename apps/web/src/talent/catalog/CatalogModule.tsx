import { Menu } from 'antd';
import { useSearchParams } from 'react-router';
import { PageState } from '../../foundation/PageState.js';
import { ResourcePage } from './ResourcePage.js';
import { readPermission, useRemote } from './hooks.js';
import type { Resource } from './types.js';
import type { ReactNode } from 'react';
import './catalog.css';

export function CatalogModule({
  resources,
  extra,
}: {
  resources: Resource[];
  extra?: { key: string; title: string; object: string; content: ReactNode };
}) {
  const [query, setQuery] = useSearchParams();
  const entries = [...resources, ...(extra ? [extra] : [])];
  const permissions = useRemote(`navigation:${entries.map((item) => item.object).join(',')}`, async (api, signal) =>
    Object.fromEntries(
      await Promise.all(
        entries.map(async (resource) => [resource.key, await readPermission(api, resource.object, signal)] as const),
      ),
    ),
  );
  if (permissions.error) return <PageState kind="error" error={permissions.error} />;
  if (!permissions.data) return <PageState kind="loading" />;
  const allowed = entries.filter((item) => permissions.data?.[item.key]);
  const key = query.get('view') ?? allowed[0]?.key;
  const active = resources.find((item) => item.key === key);
  const access = key ? permissions.data[key] : null;
  return (
    <div className="catalog-layout">
      <aside className="catalog-navigation">
        <Menu
          mode="inline"
          selectedKeys={key ? [key] : []}
          items={allowed.map((item) => ({ key: item.key, label: item.title }))}
          onClick={({ key: next }) => setQuery({ view: next })}
        />
      </aside>
      <div className="catalog-content" key={key}>
        {!access ? (
          <PageState kind="forbidden" />
        ) : active ? (
          <ResourcePage resource={active} permission={access} />
        ) : extra && extra.key === key ? (
          extra.content
        ) : (
          <PageState kind="not-found" />
        )}
      </div>
    </div>
  );
}
