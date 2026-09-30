import type {DevelopmentRecord as R} from './development';
export function latestPublishedReviews(records:R[]){const replaced=new Set(records.filter(r=>r.kind==='review'&&r.status==='published').map(r=>r.payload.supersedes));return records.filter(r=>r.kind==='review'&&r.status==='published'&&!replaced.has(r.id));}
