# FuelWatch API worker

Validates the WA FuelWatch RSS feed and serves JSON for the Home Assistant integration at `https://fuelwatch.oss.bhodges.me/v1`. The domain is declared in `wrangler.jsonc`; it must be deployed before the integration can fetch prices.

## Develop and verify

Use Node.js 24 or newer and pnpm 11.6.0. Run these commands from `api-worker`:

```sh
pnpm install --frozen-lockfile
pnpm run db:migrate:local
pnpm run dev
```

```sh
pnpm run lint
pnpm run type-check
pnpm test
pnpm run build
```

`type-check` regenerates Cloudflare binding/runtime types before checking the source. `test` bundles the actual worker and runs it in Miniflare, alongside deterministic unit tests for dates, deadlines, validation and cache failures. `build` performs a Wrangler deployment dry run without publishing anything. `pnpm run format` applies Biome formatting and safe lint fixes. CI runs all checks with the committed lockfile.

The test fixture in `tests/fixtures/fuelwatch-v1.json` is checked against worker output and consumed by the Python adapter tests in the repository's `tests/test_api.py`.

From the repository root, `python tools/test_api_adapter.py` runs the real Python adapter tests without importing Home Assistant's platform bootstrap (useful on Windows). Install the repository's development requirements first. This focused check supplements the full `python -m pytest -q` integration suite, which runs on Linux in CI.

## HTTP contract

- `GET /v1`: JSON:API 1.1 service-station resources described below; used by Home Assistant.
- `GET /legacy`: legacy `{ "feed": ... }` representation retaining RSS descriptions and parser fields.
- `GET /`: redirects to `/v1`, retaining query parameters.
- `HEAD`: the same status and headers as GET, without a response body; shares its cache entry.
- `OPTIONS`: public CORS preflight. GET, HEAD and OPTIONS are the only allowed methods.

Both data endpoints accept case-insensitive query names and text values. The standard syntax uses `filter[product]`, `filter[brand]`, `filter[region]`, `filter[suburb]`, `filter[day]` and `filter[surrounding]`. Short filter names in the table below remain compatibility aliases: `PRODUCT=1` and `filter[Product]=1` select the same cached response. Mixing aliases for one parameter is rejected as a duplicate.

JSON:API reserves all-lowercase custom top-level query names. Retaining short aliases and the requested `expand` parameter is an explicit compatibility extension; use `filter[...]` for standard-compliant requests. Success/error document structure and media negotiation follow [JSON:API 1.1](https://jsonapi.org/format/). `/legacy` retains its former RSS-shaped contract, hyphenated keys and `application/json` content type.

| Parameter | Accepted values | Default |
| --- | --- | --- |
| `Product` | One or more of `1`, `2`, `4`, `5`, `6`, `10`, `11`, comma-separated | All seven on `/v1`; `1` on `/legacy` |
| `Day` | `yesterday`, `today`, `tomorrow`, or `DD/MM/YYYY` within those three Perth calendar dates | `today` |
| `Suburb` | Comma-separated suburb names; each nonempty, at most 100 characters and without control characters | All suburbs |
| `Region` | Comma-separated region codes exported in `src/fuelwatch.ts` | All regions |
| `Brand` | Comma-separated brand codes exported in `src/fuelwatch.ts` | All brands |
| `Surrounding` | `yes` or `no` | Origin default |

List values are OR alternatives; different filters combine with AND. Whitespace is trimmed and duplicate list values are removed. Casing, list/query ordering, suburb whitespace and date aliases normalize into shared cache keys. Numeric filters use FuelWatch codes, not display names. `Day` and `Surrounding` each take one value. Unknown or repeated parameter names (including case variants), empty list entries, invalid codes and unsupported dates return HTTP 400 before origin access. Absolute dates translate to upstream relative days.

```sh
curl -g -H 'Accept: application/vnd.api+json' 'https://fuelwatch.oss.bhodges.me/v1?filter[product]=1&filter[day]=today'
curl 'https://fuelwatch.oss.bhodges.me/v1?brand=2,35&product=1,2,6&day=TODAY'
```

`/v1` responds with `Content-Type: application/vnd.api+json` without a charset parameter. Send that type in `Accept`, or omit `Accept`/use a compatible wildcard. Unsupported extension/media parameters yield 406 (`Accept`) or 415 (`Content-Type`) before any cache read. Unknown profiles are ignored. `Vary: Accept` is included; HEAD and conditional requests obey the same negotiation rules.

The document has three top-level members: `jsonapi: {"version":"1.1"}`, `meta` and `data`. `meta.source` identifies the original fuel-price publisher as `fuelwatch.wa.gov.au`. `meta` also retains `sourceDate`, `fetchedAt`, `validFrom`, `validUntil` and `publicationStatus`. A single fuel has numeric `meta.product`; multiple fuels have `meta.products: [1, 2, 6]`. Every resource is `{ "type": "serviceStation", "id": "...", "attributes": { ... } }`. A station appears once, with `price.products` mapping product IDs to numeric prices. Products that station does not sell are omitted, never represented as zero. Even a single-product selection uses this grouped shape. Resource IDs combine source date and a SHA-256 hash of FuelWatch station identity; changing the selected products, rebranding, price corrections and enrichment updates retain the ID. There are no advertised resource URLs that the worker cannot serve.

RSS `title`, `image`, `description`, parser fields and the old `schemaVersion` are absent from `/v1`. Station attributes use camelCase, including `tradingName`, `siteFeatures`, `openHours` and `sourceNotes`. Enrichment field paths use these same names.

All `/v1` JSON timestamps and the `X-FuelWatch-Fetched-At` header are serialized in **AWST (`+08:00`)**, including enrichment timestamps. `sourceDate` is a date-only calendar value. Opening hours are local AWST wall times. Internal D1 expiry/budget accounting remains independent of display formatting; HTTP protocol dates retain their required HTTP-date format.

FuelWatch requires one explicit product ID per RSS request; omitting it upstream selects only unleaded. `/v1` selects all seven products when its product filter is omitted. The worker maintains complete per-product/date extracts in the existing D1 cache. Brand and exact-suburb (`surrounding=no`) filters are evaluated against these extracts, so changing them does not trigger new RSS requests. Brand codes map to the source labels in `src/fuelwatch.ts`; matching is case-insensitive.

RSS records do not include region membership or the surrounding-suburb relationship. Region searches, suburb searches using the origin's default surrounding behavior, and `surrounding=yes` therefore retain source-side filtering and the existing six-hour selection cache. Those searches and `/legacy` expand into at most **24 product/brand/region/suburb combinations**; larger selections return HTTP 400. Catalogue selections need at most seven upstream requests, regardless of brand/exact-suburb combinations.

A cold selection uses at most three concurrent origin requests and a shared eight-second deadline. All components must succeed and validate; errors reject the entire public response. Successfully validated individual product extracts remain available if another product fails. Overlaps deduplicate by station/product before grouping into station resources; ordering is deterministic. Source-filtered combined input is bounded to 16 MiB; each catalogue product is bounded to 4 MiB, with all selections capped at 10,000 quotes.

`publicationStatus` is `available` for a nonempty snapshot, `not_yet_published` for an empty tomorrow snapshot before 14:30 Perth, and `empty` for other valid empty results. Price periods run from 06:00 Perth on the source date to 06:00 the next day. Before 06:00, request yesterday for the currently effective price period. An explicit request for an expired period may return validated historical prices with `no-store`; its metadata retains the actual validity dates.

The integration derives station IDs from FuelWatch address, suburb and numeric coordinates because neighbouring sites can share an address. It continues using its existing selector algorithm rather than switching to JSON:API price-resource IDs, preserving saved selections across this migration.

Example document:

```json
{
    "jsonapi": {
        "version": "1.1"
    },
    "meta": {
        "source": "fuelwatch.wa.gov.au",
        "product": 1,
        "sourceDate": "2026-09-29",
        "fetchedAt": "2026-09-29T16:00:00.000+08:00",
        "validFrom": "2026-09-29T06:00:00.000+08:00",
        "validUntil": "2026-09-30T06:00:00.000+08:00",
        "publicationStatus": "available"
    },
    "data": [
        {
            "type": "serviceStation",
            "id": "2026-09-29:238232d151f5f92bbce32951b828cb7fe4887fdc1ac868628c7ab33d4eda4e3b",
            "attributes": {
                "name": "Example Station",
                "brand": 5,
                "price": {
                    "asAt": "2026-09-29T06:00:00.000+08:00",
                    "products": {
                        "1": 185.9
                    }
                },
                "address": {
                    "street": "1 Test Road",
                    "suburb": "PERTH",
                    "state": "WA",
                    "postcode": null
                },
                "phone": null,
                "latitude": -31.95,
                "longitude": 115.86,
                "is24Hours": null,
                "restrictions": null,
                "tradingName": "Example Station",
                "siteFeatures": []
            }
        }
    ]
}
```

Each value in `price.products` is a JSON **number in Australian cents per litre** (185.9 means AUD 1.859/L). `price.asAt` is the start of the source price period at 06:00 AWST, matching `meta.validFrom`; it is not a retrieval timestamp. Consumers needing decimal arithmetic should parse JSON numbers as decimals, as the Python adapter does. Coordinates are numbers; postcodes stay strings. Google never changes FuelWatch prices, coordinates, names, brands, streets or suburbs. Missing postcodes are `null` until a confident place match supplies one; example data is never used as a lookup database.

Phone parsing uses `libphonenumber-js` with the Australian default region, strict whole-value parsing and validity checks. Invalid/ambiguous numbers produce `phone: null` and retain the original text in `sourceNotes.phone`; an explicitly supplied invalid number blocks Google replacement. Empty fields and FuelWatch's `--EMPTY--` marker permit a fallback. Extensions and lists of numbers are not silently discarded to invent a canonical number.

Opening hours use local Perth wall times: `HH:mm-HH:mm`, comma-separated split shifts, or `Closed`. Closing at `24:00` is allowed; a closing time before the opening time denotes the following day. FuelWatch weekday ranges expand into named days. Google's overnight periods split at midnight. Unknown days are omitted, not inferred closed from a partial FuelWatch schedule. `is24Hours` is `true` for confirmed continuous opening, `false` for a known limited schedule, and `null` when unknown. Confirmed 24-hour stations omit `openHours`. Malformed source schedules remain in `sourceNotes.openHours` and block Google replacement.

`brand`, `siteFeatures` and `restrictions` contain stable numeric codes by default. Features and restrictions retain their deterministic source-normalization ordering; duplicate values are removed. Empty features are `[]`; no known restrictions is `null`. Unknown feature/restriction text is preserved in `sourceNotes.features` or `sourceNotes.restrictions`, never assigned a made-up code. Unmapped brands use reserved code `0` with the original name in `sourceNotes.brand`; their expanded object also retains that original name. Code `15` still means Independent.

### Reference expansion and logos

Use `expand=brand`, `expand=siteFeatures,restrictions`, or `expand=all`. Parameter names and values are case-insensitive; whitespace and duplicate list members are normalized. `all` is equivalent to specifying all three fields, including when combined with another valid field. An omitted parameter keeps every reference compact. Empty values/members, unknown fields and repeated `expand` parameter names return HTTP 400 before cache or upstream access. Expansion applies only to `/v1`; `/legacy` keeps string labels and rejects `expand`.

```sh
curl 'https://fuelwatch.oss.bhodges.me/v1?product=1&expand=brand'
curl 'https://fuelwatch.oss.bhodges.me/v1?product=1,2&expand=brand,siteFeatures'
curl 'https://fuelwatch.oss.bhodges.me/v1?expand=all'
```

For example, `"brand": 5` expands to:

```json
{"code": 5, "name": "BP", "logo": "/static/image/brand/bp.svg"}
```

And `"siteFeatures": [1, 4]` expands to:

```json
[{"code": 1, "name": "Credit Cards"}, {"code": 4, "name": "ATM"}]
```

Restrictions use the same `{code, name}` shape. Other station fields and price product keys retain their existing shape. Expansion changes rendered response cache keys and ETags; it does **not** change D1 snapshot keys or request any additional RSS/Google data. Equivalent expansion sets share a cache entry. Compact and expanded variants retain the same station IDs and original price fetch time.

Resolve root-relative `logo` URLs against the API origin. `GET` and `HEAD /static/image/brand/<filename>.svg` serve the supplied SVGs with ETags, a one-day cache lifetime, public CORS, `nosniff` and a restrictive SVG content security policy. Static image loads support simple CORS; Cloudflare Static Assets rejects other methods. Successful image requests bypass the price Worker entirely. Missing paths return 404; they do not redirect to a home page or contact FuelWatch.

Wrangler's custom build automatically stages the original logos from `../common/assets/brands` into ignored `public/static/image/brand`. Only SVGs are copied, and the build checks every advertised logo exists. Artwork remains in the integration directory as the single source; edits are watched by `wrangler dev`. The generated `_headers` rules come from `src/asset-headers.json`, and the assets binding handles script fallback requests. Deploy from the repository checkout so both the shared registry and source artwork are present.

Ampol (2), BOC (4), Independent (15), OTR (42), OMG Caltex (48), and unknown brands (0) currently use `generic.svg` because no matching brand-specific artwork was supplied. A generic logo never changes the brand code or name.

The shared registry is `../common/reference_data.json`, bundled by the Worker and shipped with Home Assistant. Brand codes match FuelWatch. Feature/restriction codes are explicit API identifiers, **not array positions**: never renumber, recycle or reassign existing codes. Add new records deliberately, update normalization when needed, and ship the matching integration registry. Tests check coverage of every controlled label and real asset delivery for every advertised logo. The adapter accepts compact codes, expanded objects and previous string labels, preserving existing human-readable entity attributes and saved vendor filters.

#### Brand codes

| Code | Name |
| --- | --- |
| 0 | Unknown |
| 2 | Ampol |
| 3 | Better Choice |
| 4 | BOC |
| 5 | BP |
| 6 | Caltex |
| 7 | Gull |
| 10 | Liberty |
| 11 | Mobil |
| 14 | Shell |
| 15 | Independent |
| 23 | United |
| 24 | Eagle |
| 25 | FastFuel 24/7 |
| 26 | Puma |
| 27 | Vibe |
| 29 | 7-Eleven |
| 30 | Metro Petroleum |
| 31 | WA Fuels |
| 32 | Costco |
| 34 | Atlas |
| 35 | EG Ampol |
| 36 | CGL fuel |
| 37 | X Convenience |
| 38 | Phoenix |
| 39 | Burk |
| 40 | Petro Fuels |
| 41 | Astron |
| 42 | OTR |
| 43 | Reddy Express |
| 44 | Dunning's |
| 45 | Perrys |
| 46 | UGO |
| 47 | Maisey Fuels |
| 48 | OMG Caltex |
| 49 | OMG Metro |
| 50 | Solo |
| 52 | Broome Diesel |
| 53 | Fuel Tech |

#### Site feature codes

| Code | Name |
| --- | --- |
| 1 | Credit Cards |
| 2 | Debit Cards |
| 3 | Fuel Cards |
| 4 | ATM |
| 5 | Toilets |
| 6 | Bottled Gas |
| 7 | Trailer Hire |
| 8 | EFTPOS |
| 9 | Restaurant |
| 10 | Carwash |
| 11 | Workshop |
| 12 | Air |
| 13 | Water |
| 14 | Ice |
| 15 | Discount |
| 16 | Voucher |
| 17 | Bottled AdBlue |
| 18 | Pumped AdBlue |
| 19 | Truck Friendly |
| 20 | Convenience Store |
| 21 | Open 24 hours |

#### Restriction codes

| Code | Name |
| --- | --- |
| 1 | Unmanned site (credit card charges may apply) |
| 2 | Entry Permit Required |
| 3 | Membership Required |
| 4 | Low Aromatic Fuel |

Google can add explicitly reported facilities and supply missing phone/postcode/hours. Existing FuelWatch hours win per weekday, including explicit closed days. A station with FuelWatch's `Open 24 hours` cannot acquire a narrower Google schedule. Added fields carry `enrichment` metadata: provider, place ID, fetched timestamp, stale flag, affected field names, Google Maps URL and third-party attributions. Consumers displaying these fields should retain the accompanying attribution. The Home Assistant adapter retains station details and attribution in its saved snapshots, entity attributes and dashboard.

Whole snapshots are rejected for invalid prices, coordinates, dates, missing station identity fields, conflicting records at the same address/coordinates, unsafe or malformed XML, duplicate scalar XML fields, over 5,000 stations or decompressed input over 4 MiB. Identical duplicate records are collapsed.

JSON:API errors use `{ "jsonapi": { "version": "1.1" }, "errors": [{ "status": "400", "code": "invalid_query", "detail": "..." }] }` and `Cache-Control: no-store`. Error documents never include `data`. `/legacy` keeps its previous `error.code`/`error.message` structure. Clients should keep their last good snapshot on failure, as the integration coordinator does.

| HTTP | Meaning |
| --- | --- |
| 400 / 404 / 405 | Invalid query / unknown endpoint / unsupported method |
| 406 / 415 | Unacceptable response media type / unsupported JSON:API Content-Type parameters |
| 502 | Origin denied or redirected the request, or returned an invalid/oversized snapshot |
| 503 | Origin unavailable/rate limited, or another request is still refreshing this selection; check `Retry-After` |
| 504 | The eight-second upstream deadline expired |
| 500 | Unexpected worker/configuration failure |

## Freshness and failure handling

Published selections are cached in **D1 for six hours (21,600 seconds)** from the completed origin fetch. All users and Cloudflare data centers share this snapshot, including `/v1` and `/legacy`. Cache identity includes the configured origin, absolute source date and normalized filters, so casing, parameter order, list order and `filter[...]` aliases reuse the same snapshot. Hits preserve `meta.fetchedAt` and never extend the expiry. The `/v1` catalogue shares one complete extract per product/date across all supported local filters. Source-filtered selections and `/legacy` still have distinct entries. Combined responses report the oldest contributing `fetchedAt` and the earliest expiry.

The local Cache API holds the rendered response for up to the snapshot's remaining six-hour lifetime. HTTP freshness stops earlier at Perth midnight (relative `day` URLs change meaning), price expiry or an enrichment deadline. Rebuilding a response after edge eviction or enrichment expiry still uses D1 without calling FuelWatch. A cached `tomorrow` snapshot can become `today` at midnight because its source date is unchanged. Already published results do not need invalidation at 06:00 or 14:30. Empty results, and multi-product selections missing any requested fuel, are cached for at most **30 seconds**, shortened at publication/day boundaries. This prevents an early request from hiding newly published prices. Browser responses require revalidation (`max-age=0`); shared HTTP caches receive only the remaining `s-maxage`. ETags support conditional GET and HEAD.

On a shared miss, a 60-second SQL lease elects one origin fetcher. Other callers wait up to ten seconds with bounded backoff, then receive `503 cache_refresh_busy` and `Retry-After: 2` if the refresh is still running. Failed fetches release the lease; an abandoned lease expires automatically. Cache publication is awaited before returning success and atomically replaces gzip-compressed chunks of at most 1,000,000 bytes, below D1's per-row limit. Delayed writers cannot overwrite a newer owner's snapshot. Each D1 operation has a two-second caller deadline. Scheduled invocations prune up to 100 expired selections and their chunks, without removing active refreshes.

`X-FuelWatch-Cache: HIT|MISS` describes the local response cache. When it is `MISS`, `X-FuelWatch-Snapshot-Cache: HIT|MISS|BYPASS` distinguishes a shared D1 hit, a newly stored origin fetch, and a storage fallback. On an edge hit, this snapshot header describes how that representation was originally built. `X-FuelWatch-Source-Date` and `X-FuelWatch-Fetched-At` retain origin provenance. Edge writes run under `waitUntil`. Cache failures are logged and fall back to bounded origin fetching; a D1 outage or unapplied migration therefore temporarily loses cross-data-center deduplication. Expired data is never used as an outage fallback. Home Assistant retains its own last good snapshots and displays their age/errors.

One eight-second deadline covers upstream headers, streaming body reads and retry delay. Network failures, 429 and 5xx responses allow at most one retry with jitter. A long `Retry-After` returns immediately rather than holding a worker open. Redirects and validation failures are not retried. Origin cookies, cache headers and XML ETags are not forwarded.

Source-filtered region/surrounding-suburb queries can create many distinct selections. Monitor D1 storage, rows read/written and unique-query traffic before adding Cloudflare rate-limiting rules. The existing 15-minute enrichment discovery cron continues independently of the hourly price refresh.

### Hourly price refresh

The `0 * * * *` cron refreshes all seven unfiltered single-product selections at the start of every hour, every day. Cloudflare evaluates cron in UTC; this expression is also hourly at minute zero in AWST. Before 06:00 AWST it refreshes yesterday and today; from 06:00 until 14:30 it refreshes today; after 14:30 it includes tomorrow. This warms the exact absolute-date cache keys requested by Home Assistant, even when nobody has requested them yet. Every catalogue selection, including all-products requests and brand/exact-suburb changes, reuses these extracts. Source-filtered region/surrounding-suburb combinations are filled on demand.

The job refreshes D1 even while a previous snapshot is fresh, with at most three concurrent origin requests. Public readers continue using the previous valid snapshot during refresh. Scheduled delivery retries reuse snapshots fetched since that event's scheduled time. Failed or unexpectedly empty replacements keep the existing prices and their original expiry; successful refreshes start a new six-hour lifetime. Existing rendered edge responses retain their bounded lifetime and may show older same-period prices until they expire. The cron warms shared D1, not every edge data center.

Price warming runs without Google credentials or enrichment budget. `feeds_warmed` logs the AWST scheduled time, refreshed/reused/empty/failed counts and duration. `feed_warm_failed` identifies each failed product/day; other selections still run, then the cron invocation fails visibly if any refresh failed. Deploy the worker to register the new hourly trigger alongside `*/15 * * * *` for enrichment. The existing D1 migration suffices; no new tables or API keys are needed.

## Deploy and operate

Install the updated Home Assistant integration before deploying this Worker. Its adapter accepts previous string labels, numeric codes and expanded references (as well as the older `fuelPrices` resource). Older integration versions cannot parse compact brand/feature/restriction codes. The new edge-cache namespace prevents cached old response documents from leaking into the new contract after deployment.

Authenticate Wrangler to the Cloudflare account containing the `bhodges.me` zone. `wrangler.jsonc` binds the existing `fuelwatch` D1 database as `FUELWATCH_DB`. Apply the migration before deploying:

```sh
pnpm run db:migrate:remote
pnpm exec wrangler secret put GOOGLE_MAPS_API_KEY
pnpm run deploy
```

The six-hour shared cache requires `migrations/0002_feed_cache.sql`, applied by the migration command above. For local development run `pnpm run db:migrate:local`; local and remote D1 are separate. To inspect the live cache, run `SELECT COUNT(*) AS snapshots, SUM(expires_at > unixepoch() * 1000) AS fresh FROM feed_cache;` in the remote D1 console. The existing station enrichment tables are unchanged.

The key must belong to a billing-enabled Google project with **Places API (New)** enabled. Restrict it to that API and set Google Cloud quotas/budget alerts. The selected phone, hours and facility fields affect the billed SKU; the worker limits request counts, not currency spend. No separate Geocoding API call is made. Local development reads the ignored `.dev.vars` file; never commit it or print the key. Setting a local environment variable does not install the production Worker secret. For FuelWatch-only operation set `GOOGLE_DAILY_REQUEST_LIMIT` to `0`; public requests also work when enrichment is unavailable.

Wrangler's Custom Domain configuration provisions the hostname; `workers.dev` is disabled. `FUELWATCH_URL` must remain an HTTPS origin URL without credentials. Clients of the public read-only endpoint need no API key.

This changes the `/v1` document contract: deploy the worker and matching integration update together. After deployment, verify a real `/v1?filter[product]=1&filter[day]=today` response, a subsequent cache hit, a HEAD request and a rejected invalid query. Distribute the updated Home Assistant integration before deploying this breaking response change. A deployment dry run does not verify DNS, account permissions or live Cloudflare behaviour.

Structured Workers logs include `feed_response` (products, `snapshotCache`, upstream selection count, date, quote count, elapsed time and HTTP TTL), `snapshot_cache_unavailable` (operation), `snapshot_cache_corrupt`, `upstream_http_error` (HTTP status and attempt), `request_failed`, `cache_read_failed` and `cache_write_failed`. A shared hit logs zero upstream requests; transport retries are logged separately. Observability currently samples every invocation; review retention and sampling as traffic grows. Alert on sustained 502/503/504 rates, repeated cache failures and unexpectedly empty current-period feeds. `pnpm exec wrangler tail` streams logs.

XML parsing is CPU work on cold requests. Measure production CPU usage and select a Workers plan/CPU limit that accommodates whole-state feeds; local tests do not establish production capacity.

## D1 enrichment lifecycle and cost controls

Public requests **never contact Google**. On an edge-cache miss, `/v1` reads the requested stations from D1 in indexed batches of 80 keys with a total 1.5-second read budget. Missing enrichment tables, corrupt records and D1 outages degrade to FuelWatch-only output. New enrichment becomes visible when the response cache expires (up to six hours). Existing profiles' refresh/retention deadlines can shorten the response lifetime without discarding the separately cached FuelWatch snapshot.

The scheduled handler runs every 15 minutes. It rotates through all seven fuel products, discovers identities from validated current FuelWatch RSS, and refreshes due stations. Names/brands are part of the match fingerprint, while the storage key excludes product, day and price; one lookup serves multiple fuel types and dates. Identity changes invalidate the provider association. Repeated discovery updates `last_seen_at` at most once daily to reduce D1 writes. A 120-second database lease prevents overlapping refreshes, conditional writes fence stale invocations, and the worker stops starting work after 60 seconds. A small batch may therefore finish with fewer stations than its configured maximum.

| Setting | Checked-in value | Accepted range / effect |
| --- | --- | --- |
| `GOOGLE_DAILY_REQUEST_LIMIT` | `1000` | `0–10000`; `0` disables refresh. Atomic D1 reservations count failures/timeouts too. UTC day resets at 08:00 Perth. |
| `ENRICHMENT_BATCH_SIZE` | `100` | `1–500`; maximum stations per cron invocation, also subject to time and daily request limits. Each station can use two requests. |
| `ENRICHMENT_REFRESH_DAYS` | `30` | `1–30`; successful records become due after this interval. |

If omitted, the code uses conservative fallbacks of 100 requests/day, 10 stations/batch and 7 days. Invalid settings fail the scheduled invocation rather than removing limits. Allow enough capacity for initial discovery, refreshes and negative matches; approximate ongoing successful refresh demand is station count divided by refresh days. The cap is shared only by invocations using this D1 database; other projects using the key need their own controls. Never delete the daily budget table to force a refresh.

Initial discovery starts with a name/address Text Search. If there is no accepted match, one additional address search looks for petrol stations without the FuelWatch trading name in the query. Stored place IDs use one Place Details request. Ambiguous results and provider errors do not trigger a fallback; every request, including the address fallback, reserves its own unit of the daily budget. A station lookup makes at most two requests, so a batch can use more requests than stations. The fallback is another search strategy, not a retry of a failed HTTP request.

Matching requires a unique nearby operational WA petrol station and rejects conflicting known brands. Exact distinctive names within 50 metres tolerate alternative street addresses: rural lot notation, highway aliases and different roads at a corner otherwise reject correct businesses. For example, Google lists Billabong Roadhouse on Tourist Drive 354 while FuelWatch lists North West Coastal Highway. Generic brand/locality names still require compatible addresses. Other name matches require compatible addresses within 250 metres; locality alone never proves identity. Address-only matching requires an exact normalized street number and road within 50 metres. Unknown street numbers, different roads, nearby competitors and multiple accepted candidates cannot qualify by address alone. Google addresses are matching evidence and a postcode source; FuelWatch's public street/suburb remain unchanged.

Unmatched results wait one day before another attempt. Network, malformed-response and provider failures keep previous data and back off from one hour up to one day. HTTP 400/401/403 pause all refreshes for a day; 429 pauses for an hour. No automatic HTTP retries occur. Each Google request has a five-second deadline and a 256 KiB response limit; a two-search station lookup can take up to ten seconds of HTTP time. Credentials travel only in request headers.

Cached provider data can be served after its refresh deadline with `enrichment.stale: true`, but never once it reaches **30 days old**, regardless of the configured refresh interval. With the checked-in 30-day interval there is no stale grace period: fields may temporarily disappear until cron refreshes them. Stations absent from discovery for 90 days and request counters older than 35 days are pruned. Retained-but-expired records may still hold the place ID for the next refresh. Persistent provider caching is an explicit deployment choice; the [Places policies](https://developers.google.com/maps/documentation/places/web-service/policies) describe Google's storage and attribution requirements.

For local scheduled testing, run `pnpm exec wrangler dev --test-scheduled` after applying local migrations, then visit `http://localhost:8787/__scheduled`. This **can make paid Google calls** when your local key is configured; the local D1 budget is separate from production. Automated tests use mock Google responses and real local D1 migrations instead.

Operational queries (run with `pnpm exec wrangler d1 execute FUELWATCH_DB --remote --command '<SQL>'`, or use the D1 console):

```sql
SELECT utc_day, requests FROM google_request_budget ORDER BY utc_day DESC LIMIT 7;
SELECT COUNT(*) AS discovered, COUNT(enrichment_json) AS cached FROM station_enrichment;
SELECT
  SUM(enrichment_json IS NULL AND next_attempt_at = 0) AS pending,
  SUM(enrichment_json IS NULL AND next_attempt_at > 0 AND failure_count = 0) AS unmatched,
  SUM(enrichment_json IS NULL AND failure_count > 0) AS failed
FROM station_enrichment;
SELECT owner, lease_until, blocked_until, next_product FROM enrichment_refresh;
SELECT station_key, next_attempt_at, failure_count FROM station_enrichment
ORDER BY next_attempt_at LIMIT 20;
```

`enrichment_refreshed` logs `discovered` (rows in this product's feed, not newly inserted stations), `matched` (enrichments actually saved), `unmatched`, `failed`, `writeSkipped`, `requestsReserved`, `stopReason` and duration. `cache` reports database-wide `stations`, `enriched` (stored profiles, including those due for refresh) and `pending` (no recorded result yet). These replace the ambiguous old `completed` counter, which included no-match results. A run can process more stations than its product feed contains because the due queue includes previously discovered products. A zero-row lease-fenced write is never counted as a saved match.

`enrichment_lookup_failed` includes a safe classification: configuration, rate_limited, upstream, invalid_response, timeout or budget_exhausted. `enrichment_cache_read_failed` means public output continued without some or all enrichment. Missing configuration logs `enrichment_not_configured`. D1 write failures fail the cron invocation so Workers observability records the failure. After correcting credentials, a deliberate `UPDATE enrichment_refresh SET blocked_until = 0 WHERE id = 1` clears the global cooldown; individual retry times still apply. Do not expose database maintenance through the public endpoint.

## Developer map

| Module | Responsibility |
| --- | --- |
| `src/index.ts` | HTTP/scheduled entrypoints, representation selection, ETags and cache publication. |
| `src/jsonapi.ts` | JSON:API resource IDs, document/error shaping and media negotiation. |
| `src/snapshot.ts` | Bounded multi-filter fetches, whole-selection validation and station/product deduplication. |
| `src/feed.ts`, `src/fuelwatch.ts` | XML validation, raw source types and price-period metadata. |
| `src/station.ts` | Public DTOs, controlled vocabularies, phone/hours parsing and source-priority merge. |
| `src/google.ts` | Bounded Places HTTP boundary, confidence matching, hours/facility conversion. |
| `src/enrichment.ts` | D1 trust boundary, read deadline, discovery, lease, budget and retry state. |
| `src/cache.ts`, `src/query.ts`, `src/upstream.ts` | Edge freshness, request validation and bounded origin transport. |
| `src/snapshot-cache.ts` | Shared six-hour snapshots, D1 fill leases, compressed chunk publication and expiry cleanup. |
| `src/warm.ts` | Hourly warming of all integration product/period selections, with isolated failures and bounded concurrency. |
| `migrations/0001_station_enrichment.sql` | Station cache, scheduler lease and daily request-counter tables. |
| `migrations/0002_feed_cache.sql` | Shared feed snapshots and cascading compressed payload chunks. |

Exported utilities and domain boundaries carry JSDoc; dependency injection of clocks/fetchers permits deterministic failure tests. Update normalization tests before extending the controlled vocabularies or source grammar. A DTO change must update `tests/fixtures/fuelwatch-v1.json`, the worker runtime assertions and the Python adapter contract tests together. Do not weaken source validation to accommodate missing enrichment.

Relevant documentation: [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/), [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/), [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [Workers logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/), [Places Text Search](https://developers.google.com/maps/documentation/places/web-service/text-search).
