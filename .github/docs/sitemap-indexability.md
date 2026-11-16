# Sitemap and index eligibility

Implementation of the blog-only sitemap plus shared indexability policy (#395 package 2).

## Endpoints

- `/sitemap.xml` — existing root sitemap. Keeps static pages, eligible article URLs, profiles, organizations, org collections, curated collections, tags and contests. Category priority is unchanged; at most 50,000 URLs are emitted (duplicates removed, first occurrence wins). Articles keep newest-publication order with an ID tie-breaker. Aggregate categories use stable name/path ordering; tags now select alphabetically rather than by popularity at their 2,000-entry cap.
- `/blog-sitemap.xml` — article-only `urlset` for the discovery auditor. Edge `GET`, `Cache-Control: no-store` on every HTTP response. Same eligible rows and canonical article mapping as the root sitemap.

Neither endpoint is live until this branch is deployed. No workflow or schedule is enabled here.

## Eligibility (`lib/indexability.js`)

One policy owner for the JS predicate and the SQL fragment (real-SQL parity covered by tests):

| State | Indexed |
| --- | --- |
| `status = 'published'`, `secret = 0/false`, `deleted_at IS NULL` | yes |
| Personal publication (`published_as` NULL or `'personal'`) | yes |
| Existing org with visibility other than `private` (case-insensitive; NULL = public) | yes |
| `member_only` | yes (paywall JSON-LD unchanged) |
| draft, unlisted, archived, under_review, trashed, unknown status | no |
| secret, deleted, revision view (`?rev=`) | no |
| private org, dangling/unknown org reference, org id mismatch | no |
| below-threshold reports, `account_status=disabled` | unchanged (no new policy input) |

`indexableBlogSql()` only accepts internally supplied identifier aliases (`/^[A-Za-z_][A-Za-z0-9_]*$/`); data is never interpolated. Join the publication's organization row, using `org.id = substr(blog.published_as, 5)` for an indexed lookup. The predicate still requires the exact `blog.published_as = ('org:' || org.id)` match.

The same predicate drives article `robots` metadata, article `BlogPosting` output and the public-profile post list (filtered before `LIMIT 20`), so the sitemaps, metadata and profile `hasPart` agree.

## Cache

- Key: `v3:public-sitemap-rows` (named row object: `blogs`, `users`, `orgs`, `collections`, `curatedCollections`, `tags`, `contests`).
- 300-second read-through fallback TTL. A valid cache hit does not open D1.
- The previous `v2` array shape is never read.
- KV invalidation is best effort; no global linearizability is claimed.

## Response contract

| Condition | `/blog-sitemap.xml` |
| --- | --- |
| Eligible rows, including zero | `200` XML `urlset` (`Content-Type: application/xml; charset=utf-8`, `no-store`) |
| D1/query failure | `503` sanitized text, `Retry-After: 30`, `Cache-Control: no-store`; no empty fallback is cached |
| KV failure only | `200` feed served directly from D1 |

Root `/sitemap.xml` keeps its separate static-only fallback when D1 is unavailable. `lastmod` comes only from `updated_at`/`published_at`; absent or invalid values are omitted.

## Invalidation hooks (package 3)

Committed mutations that add, remove, rename or re-date a sitemap URL invalidate `v3:public-sitemap-rows` (via `invalidateSitemapCache()` or `invalidateBlogLifecycleCaches()`), after the final relevant write:

- Article lifecycle: web publish/update/unlist/archive/delete; v1 publish/unpublish/trash/restore/delete; moderation dismiss/takedown; report auto-hide (`under_review`); draft autosave for an already-published row (after the tag rewrite, and still on a later tag/media failure).
- Organization: create, update (visibility, slug, other metadata/`updated_at`) and delete. The old article id set is captured before writes, so a slug-write that is followed by a failed update still invalidates.
- Org collections: create, update (name/slug/`updated_at`) and delete; deleting a collection re-files member articles to the org path.
- Curated collections: create, update visibility/name/slug, delete, and entry add/update (order or note)/remove across the web and v1 APIs.
- User purge (`lib/purgeUser.js`) invalidates in a `finally`, so a purge that fails after earlier deletes still refreshes discovery. Profile username changes and account archive keep their existing invalidation.
- Contests: publish, cancel, public edit, results finalize and cron `scheduled → live`/`→ judging` transitions. Draft creation/deletion does not change the sitemap (drafts are excluded) and is not invalidated.

Article/tag commits invalidate before later media or response-building work; autosave and v1 tag rewrites invalidate in `finally`. A subsequent failure preserves the endpoint's error response while invalidating committed discovery changes and announcing their eligible old/new URLs. Partial org deletion recomputes surviving article paths, and cron invalidates committed transitions even if later audit work fails. Updating a curated collection's timestamp invalidates even when its entry edit changes no rows.

KV deletion is best effort and globally eventual; tests prove post-commit invalidation and a fresh refill from the real producer SQL in a controlled cache. No global linearizability is claimed, and there is no queue or whole-site scan.

## Discovery notifications (package 3)

Article/org/collection callers replace unconditional IndexNow/WebSub pings with `notifyBlogDiscoveryChange(before, after)` from `lib/blogDiscovery.js`:

- Eligibility and canonical mapping stay in `lib/indexability.js` and `lib/sitemapData.js`; the transport in `lib/searchDiscovery.js` is unchanged.
- The payload is the deduplicated union of the eligible URL before the mutation and the eligible URL after it. A publish/rename announces old+new; an unpublish/trash/private/delete keeps the formerly public URL as a removal; private-from-birth, secret and unlisted rows are never announced as new URLs.
- Org privacy/slug/delete and org-collection rename/delete capture the affected article ids before the write and recompute URLs from committed rows, so collection deletion announces both the collection path and the org fallback.
- Bulk sets dispatch in chunks of 10,000 URLs (IndexNow request limit). Delivery remains detached/best-effort: a failed lookup or provider call cannot fail or delay the mutation response.

## Known limits

- KV deletion affects the shared key but propagates eventually; other isolates may still serve the previous snapshot within the 300-second fallback TTL.
- Media updates that only change `orgs.updated_at` (logo/banner) are outside the package-3 caller list and rely on the TTL.
- Username changes invalidate the sitemap but do not send IndexNow removal/rename notifications.
- Curated-collection page URLs are invalidated but not sent to IndexNow (the transport notifies article URLs and pings the feed).

## Deferred

Live/deployed scheduling, the production audit run, Search Console (package 5) and #559 are out of scope. The feed and these hooks are not claimed deployed.

