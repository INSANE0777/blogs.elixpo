# SEO audit CLI (local, audit-only)

`scripts/audit-seo.mjs` runs a bounded technical audit against an explicit article sitemap. It is audit tooling only: it does not submit URLs to Google, does not read Search Console, and does not prove that Google has indexed anything.

## Requirements

- Node 22
- `npm ci` from the repository root

## Usage

```bash
node scripts/audit-seo.mjs --sitemap <url> [--limit <1..100>] [--json <path>] [--markdown <path>]
```

`--help` prints usage and exits 0 without making a request. An explicit `--sitemap` URL is required; the CLI never guesses a feed.

| Option | Meaning |
| --- | --- |
| `--sitemap <url>` | Explicit sitemap URL. HTTPS is required except for loopback HTTP (`localhost`, `127.0.0.1`, `[::1]`) used by local fixtures. Credentials, query strings and fragments are rejected. |
| `--limit <1..100>` | Sample size. Default 25, maximum 100. |
| `--json <path>` | Write the structured report. |
| `--markdown <path>` | Write the Markdown report. |

Markdown is always written to stdout. Requesting an output file adds that artifact; it does not suppress stdout.

## Feed requirement

The audit reads a **urlset containing article URLs only**. A future `/blog-sitemap.xml` producer is not deployed by this package, so the CLI requires the URL as input. Sitemap indexes, foreign origins and non-article entries are rejected rather than crawled.

## Sampling and coverage

- The audit samples the first 25 unique URLs in producer order by default, up to 100.
- Duplicates are counted in the report and are not sampled twice.
- This is a bounded newest-article audit, not an exhaustive site crawl. The producer intends newest-first order; the audit does not independently verify that intent.
- The report lists `discoveredCount`, `duplicateCount`, the exact `sampledUrls`, and `selection: first-unique-in-producer-order`.

## Fixed bounds

- Request timeout: 10 seconds, including body reading.
- Article concurrency: 3.
- Decoded body caps: 8 MiB sitemap, 2 MiB article HTML, 512 KiB `robots.txt`.
- Redirects are not followed. Every request uses `redirect: 'manual'` and sends no credentials, cookies or authorization headers.
- Off-origin sitemap entries, redirect targets, canonical URLs and JSON-LD URLs are never fetched.

## Checks

- Direct HTTP 200 with an HTML media type. Redirects, other statuses, wrong media types, timeouts, network failures and oversized bodies are reported as failures.
- Exactly one canonical link whose resolved, normalized URL matches the audited sitemap URL.
- `robots`/`googlebot` meta tags and `X-Robots-Tag` restrictions: `noindex`, `nofollow` and `none` fail. Missing tags mean the normal index/follow default. Unrelated user-agent directives do not restrict Googlebot.
- `robots.txt` is fetched once per audit and evaluated for `Googlebot` with `robots-parser`. A 404 means no rules; other unavailable or invalid responses are a visible technical failure. Sitemaps advertised in `robots.txt` are not fetched.
- `BlogPosting` JSON-LD in objects, arrays, `@graph` and `@type` arrays. The article node must identify the audited URL through `url`, `@id` or `mainEntityOfPage`. Related-post nodes do not satisfy the check. JSON-LD is parsed, never executed.
- The named `namespace-collision-543.html` fixture covers the HTTP 200 soft 404: `noindex` body, no canonical, no `BlogPosting`, reported as three independent failures.

## Output and exit codes

| Code | Meaning |
| --- | --- |
| 0 | Technically clean run |
| 1 | Technical audit failure, including an empty feed or an output-file write failure |
| 2 | Invalid configuration, before any request |

Failed URLs, check names and bounded static reasons are reported. Fetched page bodies, raw network errors, response headers and credentials are never printed. Rendered URLs are length-bounded and escaped.

A technical pass only means these checks passed. Google indexing status is separate and is not inspected by this package (`inspection: { status: 'skipped' }`).

## Local example

Run against a synthetic loopback fixture; do not run a live production crawl from this documentation:

```bash
node scripts/audit-seo.mjs --sitemap http://127.0.0.1:8787/blog-sitemap.xml --limit 25
```

## Scheduled production audit

`.github/workflows/seo-audit.yml` defines a daily technical audit and manual dispatch. A local or feature-branch copy is inactive; merging it to the default branch is the activation step. Complete the prerequisites below before merging. These instructions describe the expected behavior, not proof that the production audit has run.

### Activation prerequisites

Do not merge the workflow until all of the following are true:

1. This audit CLI and document are reviewed and merged.
2. The indexing policy and `/blog-sitemap.xml` producer are merged, with any required fixes included.
3. The deployed feed is independently verified: `https://blogs.elixpo.com/blog-sitemap.xml` returns HTTP 200, valid article-only XML, and `robots.txt` advertises it.
4. Eligible article metadata and canonicals have been reviewed on the deployed site.

The schedule starts only when the workflow reaches the default branch; a local or uncommitted file schedules nothing.

### Schedule and manual runs

- Cron `23 3 * * *`: daily target time 03:23 UTC. GitHub can delay or drop scheduled runs under high load ([schedule behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)).
- Manual run: Actions → SEO audit → Run workflow, from `main` only.
- The job requires `github.repository == 'elixpo/blogs.elixpo'`, `github.ref == 'refs/heads/main'`, and a `schedule` or `workflow_dispatch` event. Other refs and repositories are skipped.
- Permissions are `contents: read`. There are no secrets, deployment environment or Google credentials.
- Concurrency group `seo-audit-production` allows one running and at most one pending audit. New requests can replace the pending run; they do not cancel the running audit ([concurrency behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)).
- The job timeout is 10 minutes. This workflow fixes the sample at 25 first-unique URLs in producer order; the standalone CLI supports limits up to 100.

The workflow runs:

```bash
node scripts/audit-seo.mjs \
  --sitemap https://blogs.elixpo.com/blog-sitemap.xml \
  --limit 25 \
  --json seo-audit-reports/report.json \
  --markdown seo-audit-reports/report.md
```

### Reports, artifacts and exit codes

| Code | Meaning | Reports |
| --- | --- | --- |
| 0 | Technically clean run | Both files written |
| 1 | Technical audit failure, including `EMPTY_FEED` | Both files normally written before the failure is returned |
| 2 | Invalid configuration, no request made | No report files |

A non-zero exit fails the job; there is no `continue-on-error` or swallowed status. The summary and artifact steps use `if: always()`. The job summary includes the Markdown report when it exists and otherwise states that no report was produced. It never reports a technical pass for a run that wrote nothing.

The `seo-audit-report` artifact contains only `report.json` and `report.md`, retained for 14 days. If neither exists (install, configuration or CLI failure), the upload warns and the job keeps its original failure. Source, logs, fetched bodies and response headers are not uploaded.

### Incidents

Start from the failed URL, the failed check and the reason in the report, then check eligibility status and recent deploys, namespace changes, privacy changes or renames.

| Check | Failure | Meaning and first checks |
| --- | --- | --- |
| `sitemap` | `EMPTY_FEED` | The feed answered successfully but listed no articles. Check the producer query and cache, not the article pages. |
| `sitemap` | `HTTP_STATUS`, `REDIRECT`, `WRONG_CONTENT_TYPE`, `INVALID_XML` | The feed itself is unavailable or invalid. Check deployment status and the route response. |
| `fetch` | `HTTP_STATUS`, `REDIRECT`, `TIMEOUT`, `TOO_LARGE`, `NETWORK` | The article did not return a direct HTTP 200 HTML response. Check the URL, routing and redirects. |
| `canonical` | `CANONICAL_MISSING`, `CANONICAL_MULTIPLE`, `CANONICAL_EMPTY`, `CANONICAL_MISMATCH` | The page does not identify itself as the audited URL. A `200` soft 404 commonly has no canonical. |
| `robots` | `ROBOTS_NOINDEX`, `ROBOTS_NOFOLLOW`, `ROBOTS_DISALLOWED` | Metadata, an `X-Robots-Tag` header or `robots.txt` blocks Googlebot. Distinguish an intentional exclusion from a regression. |
| `blogposting` | `BLOGPOSTING_MISSING`, `BLOGPOSTING_MALFORMED`, `BLOGPOSTING_UNIDENTIFIED` | No usable `BlogPosting` JSON-LD identifies this article. Check structured-data rendering for the selected template. |

A technical failure is not fixed by deleting author drafts, adding moderation flags or submitting private URLs to search providers. Keep drafts and privacy filters intact. To stop the independent audit without changing content or privacy behavior, remove or disable this workflow on its own.

### Search Console (manual, optional, future)

Package 4 has no Search Console integration, credentials or inspection calls; reports always contain `inspection: { status: 'skipped' }`.

If a maintainer chooses to register the property, do it manually:

1. Confirm which property the maintainer actually owns; do not guess between a Domain property and a URL-prefix property ([property types](https://support.google.com/webmasters/answer/34592)). Verify ownership ([verification](https://support.google.com/webmasters/answer/9008080)).
2. In the [Sitemaps report](https://support.google.com/webmasters/answer/7451001), submit both `https://blogs.elixpo.com/sitemap.xml` and `https://blogs.elixpo.com/blog-sitemap.xml`. Submission requests crawling; it does not guarantee that URLs are crawled or indexed.
3. A future service-account integration would request the read-only `https://www.googleapis.com/auth/webmasters.readonly` scope ([authorization](https://developers.google.com/webmaster-tools/v1/how-tos/authorizing)), call URL Inspection only, and stay inside the published [usage limits](https://developers.google.com/webmaster-tools/limits). That is package 5 work. No credentials, secret entries or inspection configuration exist here.
