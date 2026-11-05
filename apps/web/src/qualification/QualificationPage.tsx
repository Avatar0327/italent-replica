import { CatalogModule } from '../talent/catalog/CatalogModule.js';
import { qualificationResources } from './resources.js';
import { DevelopmentChannel } from './DevelopmentChannel.js';
import { Alert, Descriptions } from 'antd';
import { q } from './messages.js';
export function QualificationPage() {
  return (
    <CatalogModule
      resources={qualificationResources}
      extras={[
        {
          key: 'channel-display',
          title: q.displaySettings,
          objects: ['Qualification.DevelopmentChannel'],
          content: (
            <section>
              <h1>{q.displaySettings}</h1>
              <Alert type="info" message={q.displayUnavailable} />
              <Descriptions column={1} items={q.displayFields.map((label) => ({ key: label, label, children: '—' }))} />
            </section>
          ),
        },
      ]}
      extra={{
        key: 'channels',
        title: q.channels,
        objects: ['Qualification.DevelopmentChannel'],
        content: <DevelopmentChannel />,
      }}
    />
  );
}
