# SEO audit CLI (local, audit-only)

`scripts/audit-seo.mjs` runs a bounded technical audit against an explicit article sitemap. It is audit tooling only: it does not submit URLs to Google, does not change Search Console, and does not prove that Google has indexed anything. An explicit `--inspect` opt-in adds read-only URL Inspection; that result describes the version in Google's index, not a live page test.

## Requirements

- Node 22
- `npm ci` from the repository root

## Usage

```bash
node scripts/audit-seo.mjs --sitemap <url> [--limit <1..100>] [--inspect] [--json <path>] [--markdown <path>]
```

`--help` prints usage and exits 0 without making a request. An explicit `--sitemap` URL is required; the CLI never guesses a feed.

| Option | Meaning |
| --- | --- |
| `--sitemap <url>` | Explicit sitemap URL. HTTPS is required except for loopback HTTP (`localhost`, `127.0.0.1`, `[::1]`) used by local fixtures. Credentials, query strings and fragments are rejected. |
| `--limit <1..100>` | Sample size. Default 25, maximum 100. |
| `--inspect` | Opt in to read-only Google URL Inspection for the sampled URLs. Requires both environment variables below; otherwise inspection is skipped. |
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
| 0 | Technically clean run; optional inspection skipped, completed or unavailable |
| 1 | Technical audit failure, including an empty feed or an output-file write failure |
| 2 | Invalid core configuration before any request, or opted-in inspection configuration invalid after the technical report is written |

Failed URLs, check names and bounded static reasons are reported. Fetched page bodies, raw network errors, response headers and credentials are never printed. Rendered URLs are length-bounded and escaped.

A technical pass only means these checks passed. Google indexing status is separate: a default run reports `inspection: { status: 'skipped', reason: 'inspection not requested' }`.

## Local example

Run against a synthetic loopback fixture; do not run a live production crawl from this documentation:

```bash
node scripts/audit-seo.mjs --sitemap http://127.0.0.1:8787/blog-sitemap.xml --limit 25
```

## Optional Google URL Inspection

URL Inspection is disabled unless all three are true: `--inspect` is passed, `SEO_SEARCH_CONSOLE_CREDENTIALS` contains a nonblank service-account JSON string, and `SEO_SEARCH_CONSOLE_PROPERTY` is a valid property the account can read. Default runs never read those variables, even when set.

### Configuration

| Variable | Meaning |
| --- | --- |
| `SEO_SEARCH_CONSOLE_CREDENTIALS` | The service-account JSON as one string. Only `type: "service_account"`, `client_email` and `private_key` are used. `token_uri`, `universe_domain`, impersonation fields and other keys are ignored. |
| `SEO_SEARCH_CONSOLE_PROPERTY` | Exact property from Search Console: `sc-domain:example.com` or an `http(s)://` URL prefix ending in `/`. It is never inferred from a hostname and never inserted into an endpoint. |

Keep the JSON in the environment or a local secret store. Do not commit it, paste it into a report, or create a key file for this CLI; there is no key-path option and no ambient-credential fallback.

### Outcomes

| `report.inspection.status` | Meaning | Exit effect |
| --- | --- | --- |
| `skipped` | Not requested or no nonblank secret: skip before property validation or auth. Valid configuration with no sampled URLs also skips auth and inspection. | None; technical 0/1 applies. |
| `invalid-configuration` | Explicit opt-in with a nonblank secret but an invalid credential shape, property, or sampled URL outside the property. | `2`, after the independent technical report is written. |
| `completed` | Every sampled URL was inspected successfully. A `FAIL`/`NEUTRAL`/unknown verdict is normal inspection data. | None; technical 0/1 applies. |
| `partial` / `unavailable` | Some or all inspections failed due to auth, quota, transport or unusable responses. Auth/quota denial stops further requests and lists remaining URLs as not inspected. | None; technical 0/1 applies. |

Google lag, a negative verdict, a missing Google record, an API error or quota denial never changes `technicalStatus`, per-URL technical issues or the ordinary exit code. Do not treat any inspection verdict as a release or deployment gate.

### Bounds and privacy

- One token request and at most one inspection per sampled URL, sequentially, at least one second apart; no automatic retries.
- Token exchange timeout is 10 seconds with retries disabled and redirects blocked. Inspection requests use the fixed `https://searchconsole.googleapis.com/v1/urlInspection/index:inspect` endpoint, `POST` JSON `{inspectionUrl, siteUrl}`, `redirect: 'manual'`, `credentials: 'omit'`, a 10-second timeout including body read, and a 256 KiB decoded-body cap.
- Only the readonly scope `https://www.googleapis.com/auth/webmasters.readonly` is requested. There is no write scope, Indexing API call, sitemap submission or indexing request.
- Per-URL output is a whitelist: `verdict`, `robotsTxtState`, `indexingState`, `pageFetchState` and a validated `lastCrawlTime`. Unknown enums become `UNKNOWN`. Freeform provider text, `inspectionResultLink`, canonical URLs, headers, tokens and raw SDK/provider errors are omitted.
- Authentication denial or quota exhaustion stops further requests; the remaining sampled URLs are reported as not inspected rather than silently treated as complete.

### Setup (owner-operated, not done by this repository)

This repository does not create credentials, configure Search Console or verify property ownership. A maintainer who wants the opt-in must:

1. Confirm the exact property and ownership in Search Console ([property types](https://support.google.com/webmasters/answer/34592), [verification](https://support.google.com/webmasters/answer/9008080)).
2. Create a service account, enable the Search Console API for its project, and grant that account read access to the property.
3. Export the service-account JSON into `SEO_SEARCH_CONSOLE_CREDENTIALS` in the maintainer's own environment and set `SEO_SEARCH_CONSOLE_PROPERTY`.
4. Run the CLI locally or in an authorized trusted context, then review the separate inspection section.

These steps are manual future work. No secret, credential file or live API call is part of the repository or its workflows.

Primary references: [URL Inspection method](https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect), [result fields and enums](https://developers.google.com/webmaster-tools/v1/urlInspection.index/UrlInspectionResult), [authorization scopes](https://developers.google.com/webmaster-tools/v1/how-tos/authorizing), [usage limits](https://developers.google.com/webmaster-tools/limits).

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
- Permissions are `contents: read`. There are no secrets, deployment environment or Google credentials. The workflow never passes `--inspect` and has no inspection inputs or secret bindings; optional inspection is owner-run only (see above).
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

A non-zero exit fails the job; there is no `continue-on-error` or swallowed status. The summary and artifact steps use `if: always()`. The job summary includes the Markdown report when it exists and otherwise states that no report was produced. It never reports a technical pass for a run that wrote nothing. This workflow never passes `--inspect`, so exit 2 here still means a core configuration error before any request.

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

### Search Console property and sitemaps (manual)

The CLI's optional URL Inspection is implemented and documented above; it is not configured by this repository, and the scheduled workflow does not call it. Without `--inspect`, reports contain `inspection: { status: 'skipped', reason: 'inspection not requested' }`. With `--inspect` but no nonblank credential, the skipped reason is `credentials not configured`; a present credential with an invalid property is a separate configuration error.

If a maintainer chooses to register the property, do it manually:

1. Confirm which property the maintainer actually owns; do not guess between a Domain property and a URL-prefix property ([property types](https://support.google.com/webmasters/answer/34592)). Verify ownership ([verification](https://support.google.com/webmasters/answer/9008080)).
2. In the [Sitemaps report](https://support.google.com/webmasters/answer/7451001), submit both `https://blogs.elixpo.com/sitemap.xml` and `https://blogs.elixpo.com/blog-sitemap.xml`. Submission requests crawling; it does not guarantee that URLs are crawled or indexed.
3. To use URL Inspection, follow the owner-operated setup above. It requests only the read-only `https://www.googleapis.com/auth/webmasters.readonly` scope and stays inside the published [usage limits](https://developers.google.com/webmaster-tools/limits). No credentials, secret entries or inspection configuration exist in this repository or its workflows.
