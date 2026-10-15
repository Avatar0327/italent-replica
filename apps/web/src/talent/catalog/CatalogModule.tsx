import { Menu } from 'antd';
import { useSearchParams } from 'react-router';
import { PageState } from '../../foundation/PageState.js';
import { FormCommands } from '../../foundation/forms/useCommandForm.js';
import { ResourcePage } from './ResourcePage.js';
import { usePermissions } from '../../foundation/Permissions.js';
import { useEffect, useState } from 'react';
import type { Resource } from './types.js';
import type { ReactNode } from 'react';
import './catalog.css';

interface CatalogProps {
  resources: Resource[];
  extra?: { key: string; title: string; objects: readonly string[]; content: ReactNode };
}
/** 页面级提交状态放在最外层：高于页签、权限加载态与表单，关闭重开、切换页签都不会丢掉未确认的命令（F-123）。 */
export function CatalogModule(props: CatalogProps) {
  return (
    <FormCommands>
      <CatalogContent {...props} />
    </FormCommands>
  );
}

function CatalogContent({ resources, extra }: CatalogProps) {
  const [query, setQuery] = useSearchParams();
  const entries = [...resources.map((item) => ({ ...item, objects: [item.object] })), ...(extra ? [extra] : [])];
  const permissions = usePermissions();
  const [ready, setReady] = useState(false);
  const objectKey = [...new Set(entries.flatMap((item) => item.objects))].join(',');
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
  const allowed = entries.filter((item) => item.objects.some((object) => permissions.snapshot.objects[object]));
  const key = query.get('view') ?? allowed[0]?.key;
  const active = resources.find((item) => item.key === key);
  const access = active ? permissions.snapshot.objects[active.object] : undefined;
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
        {!allowed.some((item) => item.key === key) ? (
          <PageState kind="forbidden" />
        ) : active && access ? (
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
