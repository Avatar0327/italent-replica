import { Menu } from 'antd';
import { useSearchParams } from 'react-router';
import { PageState } from '../../foundation/PageState.js';
import { ResourcePage } from './ResourcePage.js';
import { usePermissions } from '../../foundation/Permissions.js';
import { useEffect, useState } from 'react';
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
  const permissions = usePermissions();
  const [ready, setReady] = useState(false);
  const objectKey = entries.map((item) => item.object).join(',');
  useEffect(() => {
    setReady(false);
    if (permissions.loading) return;
    const controller = new AbortController();
    void Promise.all(objectKey.split(',').map((object) => permissions.ensure(object, controller.signal))).then(() => {
      if (!controller.signal.aborted) setReady(true);
    });
    return () => controller.abort();
  }, [objectKey, permissions.loading, permissions.ensure]);
  if (permissions.error) return <PageState kind="error" error={permissions.error} />;
  if (!ready) return <PageState kind="loading" />;
  const allowed = entries.filter((item) => permissions.snapshot.objects[item.object]);
  const key = query.get('view') ?? allowed[0]?.key;
  const active = resources.find((item) => item.key === key);
  const object = entries.find((item) => item.key === key)?.object;
  const access = object ? permissions.snapshot.objects[object] : undefined;
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
