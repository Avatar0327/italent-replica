import { Alert, Tag } from 'antd';
import { Link, Route, Routes } from 'react-router';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { PageState } from '../foundation/PageState.js';
import { OfferList } from './OfferList.js';
import { OfferMailPage } from './OfferMailPage.js';
import { OfferSettings } from './OfferSettings.js';
import { m } from './messages.js';
import './offers.css';

export function OffersPage() {
  return (
    <Routes>
      <Route path=":id/mail" element={<OfferMailPage />} />
      <Route path="*" element={<OfferReadPage />} />
    </Routes>
  );
}
function OfferReadPage() {
  return (
    <div className="offers-page">
      <nav className="offer-links">
        <Link to="/offers">{m.back}</Link>
        <Link to="/offers/settings">{m.settings}</Link>
      </nav>
      <Routes>
        <Route index element={<OfferList />} />
        <Route
          path="settings"
          element={
            <>
              <Alert showIcon type="info" message={<Tag color="gold">{m.demo}</Tag>} />
              <DecisionNote id="offers" />
              <OfferSettings />
            </>
          }
        />
        <Route path="*" element={<PageState kind="not-found" />} />
      </Routes>
    </div>
  );
}
