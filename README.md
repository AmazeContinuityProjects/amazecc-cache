# amazecc-cache

Cloudflare Worker that is the single cached source for AmazeCC's *public* data:
VITFAC reviews (Supabase) + the VIT Chennai faculty roster (chennai.vit.ac.in
WordPress REST, ~1,150 entries) + directorycc faculty profiles (when healthy),
including cached base64 images. Served from `cache.amazecc.com`.

## Endpoints (all GET, CORS-enabled)

### Faculty

- `/faculty` — vitfac catalog (legacy, kept for back-compat)
- `/profile/{id}` — vitfac profile bundle (legacy, kept)
- `/faculty/roster` — cached VIT faculty roster (`{ data: { faculty: [...] } }`)
- `/faculty/schools` — distinct school list derived from the roster
- `/faculty/search?q=&school=` — filtered roster
- `/faculty/profile/{id}` — combined shape: vitfac review aggregates + directorycc
  profile (name, designation, email, intercom, image, research areas, education,
  publications, awards, metrics, links, ...) + `directoryAvailable` flag

### Public data proxies

These were added so the app stops fetching third-party origins from the
browser. Each passes the upstream body through untouched, so the client's
parsing is unchanged apart from the URL it requests.

- `/transport/buses` — public VTOP bus routes (proxied from
  `api.amazecc.com/api/buses`)
- `/fresher/resources` — dashboard fresher links (proxied from
  `api.amazecc.com/api/fresher-resources`)
- `/unmessify/{file}.json` — mess menus + laundry slots. Filename is matched
  against a fixed allowlist of 13 files, so this cannot be used as a general
  proxy.
- `/github/commits?per_page=` — this repo's changelog. Unauthenticated GitHub
  allows 60 requests/hour *per IP*, which a campus behind a shared NAT would
  exhaust in seconds; here it is one cached copy for everyone.
- `/wp-media/{id}` — VIT Chennai WordPress media lookup (numeric id only)

Every proxy responds with an `X-AmazeCC-Source` header: `kv-cache`,
`upstream-fresh`, or `kv-stale`.

#### Caching model

Each proxy keeps two KV keys — the body under a long TTL, and a `:fresh`
marker under a short one. A hit on the marker answers straight from KV. A miss
refetches, and if the upstream is down it serves the stale body rather than an
error, so an origin outage degrades to slightly-old data.

| Route | Fresh | Stale grace |
| --- | --- | --- |
| `/transport/buses` | 6h | 30d |
| `/fresher/resources` | 1d | 30d |
| `/unmessify/*` | 6h | 30d |
| `/github/commits` | 5m | 30d |
| `/wp-media/{id}` | 7d | 30d |

There is deliberately no generic `?url=` passthrough. An open proxy on this
worker would be free bandwidth on our account, our IP reputation attached to
whatever anyone fetched, and an SSRF path into our own network.

### Note on `/wp-media`

chennai.vit.ac.in serves an **incomplete certificate chain** (`openssl` reports
`Verify return code: 21`). Browsers repair this via AIA fetching, but workerd
verifies strictly, so this route fails more often than a browser fetch would.
The app therefore falls back to fetching chennai directly when this route
errors — see `resolveChennaiImageUrl` in `AmazeCC/src/lib/vitfacService.ts`.
That fallback is load-bearing; do not remove it.

## Deploy

```sh
cd /home/sugeethjsa/GitHub/vitfac-amazecc-wrangler
npm install          # must run on the target (Linux) platform
npx wrangler kv namespace create CACHE   # paste id into wrangler.toml if new
npx wrangler deploy
```

Optional, only to raise the GitHub rate ceiling (not required — the 5-minute
cache already keeps us under the unauthenticated limit):

```sh
npx wrangler secret put GITHUB_TOKEN
```

## Wire into AmazeCC

The app reads the worker base from `src/lib/workerBase.ts`
(`https://cache.amazecc.com`), overridable at build time with
`NEXT_PUBLIC_WORKER_BASE`.

`src/lib/vitfacService.ts` uses it for faculty data and photo resolution.
`resolveApiRoute()` in the same file diverts the two credentialed-free API
routes (`buses`, `fresher-resources`) to the worker. Mess menus, laundry slots
and the changelog point at it directly.

The static roster fallback ships at `public/data/vit-faculty/roster.json`
(regenerate with `node scripts/fetch-vit-faculty.mjs --list-only`).
