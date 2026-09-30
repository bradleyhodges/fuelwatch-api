<div align="center">
<br /><br />
<img src="https://github.com/bradleyhodges/fuelwatch-api/raw/refs/heads/main/docs/src/app/assets/fuelwatch-api.svg" 
alt="fuelwatch-api" height="50"/>  
<br /><br />

<h1>FuelWatch API</h1>
<h3>A comprehensive, enriched-data, JSON:API-compliant API for <a href="https://fuelwatch.wa.gov.au">FuelWatch</a> data</h3>

<p align="center">
    <a href="https://docs.fuelwatch.oss.bhodges.me"><img alt="Documentation site" src="https://img.shields.io/badge/fuelwatch--api-docs-513384.svg" /></a> 
    <a href="https://github.com/bradleyhodges/fuelwatch-api/tree/main/api"><img alt="API version" src="https://img.shields.io/github/package-json/v/bradleyhodges/fuelwatch-api?filename=api%2Fpackage.json&color=007f84" /></a> 
    <a href="https://github.com/bradleyhodges/fuelwatch-api"><img src="https://img.shields.io/badge/github-repo-blue?logo=github" alt="GitHub repo" /></a> 
    <a href="https://github.com/bradleyhodges/fuelwatch-api/blob/stable/LICENSE"><img src="https://img.shields.io/badge/license-MIT-lightgrey.svg" alt="License: MIT" /></a>
</p>

<p align="center"><b>fuelwatch-api</b> is a high-performance REST-based API for consuming Western Australian fuel price data from <a href="https://fuelwatch.wa.gov.au">FuelWatch</a>. The API uses the JSON:API v1.1 specification and provides additional functionality, including automatic data conditioning, standardised objects and response models, and service station data enrichment.</p>

<p align="center">
  <a href="https://docs.fuelwatch.oss.bhodges.me">📃 Documentation</a>
  • <a href="#-getting-started">🚀 Getting started</a>
  • <a href="#freshness-and-failure-handling">Data freshness</a>
  • <a href="#self-hosting">Self-hosting</a>
  • <a href="https://github.com/bradleyhodges/fuelwatch-api/issues">Issues</a>
  • <a href="https://github.com/bradleyhodges/fuelwatch-api/pulls">Pull Requests</a>
</p>
</div>

<p align="center"><a href="https://www.buymeacoffee.com/bradleyhodges" target="_blank"><img src="https://www.buymeacoffee.com/assets/img/custom_images/white_img.png" alt="Buy Me A Coffee" style="height: auto !important;width: auto !important;" ></a></p>


## 👏 Key Features

- Fully typed TypeScript API.
- No account or API keys required. 
- Read grouped product prices in Australian cents per litre, with explicit AWST price periods.
- Stable brand, feature, and restriction codes. Expand the fields you need into named objects.
- Service methods return `{ data, error }` results for straightforward script ergonomics.
- Hourly source refreshes and bounded caching reduce repeated requests to FuelWatch.
- JSON:API resources, conditional requests, and a downloadable OpenAPI specification.

## 🚀 Getting started

fuelwatch-api supports all of the same parameters as the [FuelWatch RSS Feed](https://www.fuelwatch.wa.gov.au/tools/rss). By default, calling the v1 API with no parameters will return the current-day prices for all [product (fuel) types](https://docs.fuelwatch.oss.bhodges.me/docs/api-reference/codes#products) for all service stations in Western Australia. 

All fuel pricing is returned in AUD cents per litre (eg. `185.9` means AUD $1.859 per litre).

See [the full API specification docs](https://docs.fuelwatch.oss.bhodges.me/docs/api-reference/service-stations) for information about query parameters and their response models. The following url parameters can be supplied to the v1 endpoint:

| Parameter | Accepted values | Default |
| --- | --- | --- |
| `product` | One or more of `1`, `2`, `4`, `5`, `6`, `10`, `11`, comma-separated | All seven on `/v1`; `1` on `/legacy` |
| `day` | `yesterday`, `today`, `tomorrow`, or `DD/MM/YYYY` within those three Perth calendar dates | `today` |
| `suburb` | Comma-separated suburb names; each nonempty, at most 100 characters and without control characters | All suburbs |
| `region` | Comma-separated region codes exported in `src/fuelwatch.ts` | All regions |
| `brand` | Comma-separated brand codes exported in `src/fuelwatch.ts` | All brands |
| `surrounding` | `yes` or `no` | Origin default |
| `expand` | `all`, **OR** one or more of `brand`, `siteFeatures`, `restrictions`, `product`, comma-separated | None |

For example, you can expand all of the reference codes using the `?expand=all` parameter:

```bash
curl 'https://fuelwatch.oss.bhodges.me/v1?expand=all' \
  -H 'Accept: application/vnd.api+json'
```

which would provide a response similar to this:

```json
{
  "jsonapi": {
    "version": "1.1"
  },
  "meta": {
    "source": "fuelwatch.wa.gov.au",
    "products": [1, 2, 4, 5, 6, 10, 11],
    "sourceDate": "2026-09-30",
    "fetchedAt": "2026-09-30T10:01:27.209+08:00",
    "validFrom": "2026-09-30T06:00:00.000+08:00",
    "validUntil": "2026-10-01T06:00:00.000+08:00",
    "publicationStatus": "available",
    "copyright": "Copyright 2025 Department of Local Government, Industry Regulation and Safety (source data); Copyright 2026 Bradley Hodges (api). All rights reserved.",
    "documentation": "https://docs.fuelwatch.oss.bhodges.me",
    "issues": "https://github.com/bradleyhodges/hacs-fuelwatch/issues"
  },
  "data": [
    {
      "type": "serviceStation",
      "id": "2026-09-30:294ed847a15de8a8305c548cece119542e625a89897cd82290470f7df5ec0a8e",
      "attributes": {
        "name": "Meekatharra Corner Store",
        "tradingName": "Meekatharra Corner Store",
        "brand": {
          "code": 5,
          "name": "BP",
          "logo": "/static/image/brand/bp.svg"
        },
        "price": {
          "asAt": "2026-09-30T06:00:00.000+08:00",
          "products": {
            "1": {
              "name": "Unleaded Petrol",
              "amount": 212.9
            },
            "4": {
              "name": "Diesel",
              "amount": 266.9
            }
          }
        },
        "address": {
          "street": "16 Main St",
          "suburb": "MEEKATHARRA",
          "state": "WA",
          "postcode": "6642"
        },
        "is24Hours": null,
        "phone": "+61899811151",
        "latitude": -26.591283,
        "longitude": 118.496475,
        "siteFeatures": [
          {
            "code": 1,
            "name": "Credit Cards"
          },
          {
            "code": 2,
            "name": "Debit Cards"
          }
        ],
        "restrictions": null,
        "enrichment": {
          "provider": "Google Maps",
          "placeId": "ChIJoc_kt3GawCsRwS1ae7Uraak",
          "fetchedAt": "2026-09-29T18:36:33.091+08:00",
          "stale": false,
          "fields": [
            "address.postcode",
            "siteFeatures"
          ],
          "googleMapsUri": "https://www.google.com/maps/search/?api=1&query=Meekatharra%20Corner%20Store&query_place_id=ChIJoc_kt3GawCsRwS1ae7Uraak",
          "attributions": []
        }
      }
    },
    ...
  ]
}
```

### Filtering

List values are OR alternatives; different filters combine with AND. Whitespace is trimmed and duplicate list values are removed. Casing, list/query ordering, suburb whitespace and date aliases normalize into shared cache keys. Numeric filters use FuelWatch codes, not display names. `Day` and `Surrounding` each take one value. Unknown or repeated parameter names (including case variants), empty list entries, invalid codes and unsupported dates return HTTP 400 before origin access. Absolute dates translate to upstream relative days.

```sh
curl -g -H 'Accept: application/vnd.api+json' 'https://fuelwatch.oss.bhodges.me/v1?filter[product]=1&filter[day]=today'
curl 'https://fuelwatch.oss.bhodges.me/v1?brand=2,35&product=1,2,6&day=TODAY'
```

### Reference codes
Full documentation for all reference provided by the API are available in the [Reference codes specification docs](https://docs.fuelwatch.oss.bhodges.me/docs/api-reference/codes).

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

## Self-hosting
The API is open source and can be self-hosted. If you'd prefer to self-host the API, you'll need a Cloudflare account with access to Cloudflare Workers and D1. More information about how to deploy the API is available [here](https://github.com/bradleyhodges/fuelwatch-api/tree/main/api).