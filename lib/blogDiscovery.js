// Discovery transitions shared by every article/org/collection mutation.
// Eligibility is owned by lib/indexability.js and canonical paths by
// lib/sitemapData.js; this module only snapshots those URLs and forwards the
// deduplicated union to the existing search-discovery transport.
import { isIndexableBlog } from './indexability';
import { notifySearchDiscovery } from './searchDiscovery';
import { publicBlogPath, SITE_URL } from './sitemapData';

// IndexNow accepts at most 10,000 URLs per request; each chunk is its own
// detached request so a bulk transition never silently truncates.
export const DISCOVERY_BATCH_LIMIT = 10000;
const ID_CHUNK = 50;

const BLOG_DISCOVERY_SELECT = `
  SELECT b.id, b.slug, b.status, b.secret, b.deleted_at, b.published_as,
         au.username AS author_username,
         o.id AS org_id, o.visibility AS org_visibility, o.slug AS org_slug,
         col.slug AS collection_slug
  FROM blogs b
  JOIN users au ON au.id = b.author_id
  LEFT JOIN orgs o ON b.published_as LIKE 'org:%' AND o.id = substr(b.published_as, 5)
  LEFT JOIN collections col ON col.id = b.collection_id AND col.org_id = o.id
`;

function discoveryUrl(row) {
  if (!row) return null;
  const org = row.org_id ? { id: row.org_id, visibility: row.org_visibility } : null;
  if (!isIndexableBlog(row, { org })) return null;
  const path = publicBlogPath(row);
  return path ? `${SITE_URL}${path}` : null;
}

// Current eligible URL for one article, or null. Best-effort: a failed lookup
// never turns a successful mutation into an error.
export async function getIndexableBlogUrl(db, blogId) {
  if (!blogId) return null;
  const urls = await getIndexableBlogUrlsForBlogIds(db, [blogId]);
  return urls[0] ?? null;
}

// Eligible URLs for the given article ids, in the caller's order. Capturing ids
// before a bulk write and mapping after it keeps collection-delete URLs that
// fall back to the org path exact.
export async function getIndexableBlogUrlsForBlogIds(db, blogIds) {
  const ids = [...new Set((Array.isArray(blogIds) ? blogIds : []).filter(Boolean))];
  if (!ids.length) return [];
  try {
    const rows = [];
    for (let index = 0; index < ids.length; index += ID_CHUNK) {
      const chunk = ids.slice(index, index + ID_CHUNK);
      const result = await db.prepare(
        `${BLOG_DISCOVERY_SELECT} WHERE b.id IN (${chunk.map(() => '?').join(',')})`,
      ).bind(...chunk).all();
      rows.push(...(result?.results || []));
    }
    const byId = new Map(rows.map((row) => [row.id, discoveryUrl(row)]));
    return [...new Set(ids.map((id) => byId.get(id)).filter(Boolean))];
  } catch {
    return [];
  }
}

// Article ids currently published to an organization, captured before a bulk
// org mutation so the post-write URLs can be recomputed from committed rows.
export async function getOrgBlogIds(db, orgId) {
  if (!orgId) return [];
  try {
    const result = await db.prepare("SELECT id FROM blogs WHERE published_as = ('org:' || ?) ORDER BY id")
      .bind(orgId).all();
    return (result?.results || []).map((row) => row.id);
  } catch {
    return [];
  }
}

// Article ids filed under one organization collection.
export async function getCollectionBlogIds(db, collectionId) {
  if (!collectionId) return [];
  try {
    const result = await db.prepare('SELECT id FROM blogs WHERE collection_id = ? ORDER BY id')
      .bind(collectionId).all();
    return (result?.results || []).map((row) => row.id);
  } catch {
    return [];
  }
}

// Advisory: never awaited by the mutation response path and never throws.
export function notifyBlogDiscoveryChange(before, after) {
  const values = [
    ...(Array.isArray(before) ? before : [before]),
    ...(Array.isArray(after) ? after : [after]),
  ].filter(Boolean);
  const urls = [...new Set(values)];
  for (let index = 0; index < urls.length; index += DISCOVERY_BATCH_LIMIT) {
    notifySearchDiscovery(urls.slice(index, index + DISCOVERY_BATCH_LIMIT));
  }
}
