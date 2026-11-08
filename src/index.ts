/**
 * Cloudflare Worker — general cache for AmazeCC.
 *
 * Originally `vitfac-amazecc-cache` (vitfac.amazecc.com) serving only VITFAC
 * faculty/review data from Supabase. Expanded into `cache.amazecc.com`: a single
 * cached source combining
 *   - vitfac reviews + faculty metadata (Supabase `faculty` / `reviews`),
 *   - the VIT Chennai faculty roster (chennai.vit.ac.in WordPress REST, ~1,150
 *     entries across all schools, each linking to a directorycc profile),
 *   - directorycc faculty profiles (directorycc.vit.ac.in, when healthy —
 *     name, designation, email, intercom, image (base64), research areas,
 *     education, publications, metrics, links, ...),
 * behind one KV cache with permissive CORS for the AmazeCC origins.
 *
 * Endpoints (all GET, CORS-enabled):
 *   /faculty                 vitfac catalog (legacy, kept for back-compat)
 *   /profile/{id}            vitfac profile bundle (legacy, kept)
 *   /faculty/roster          cached VIT faculty roster (school, name, employeeId, profileUrl)
 *   /faculty/schools         distinct school list derived from the roster
 *   /faculty/search?q=&school=  filtered roster
 *   /faculty/combined        vitfac + roster merged catalog (compact, ~500 KB)
 *   /faculty/profile/{id}    combined shape: vitfac review aggregates + directorycc profile
 *   /faculty/all-data        complete catalog with ALL shapes merged (vitfac + roster + full directory academic dossier)
 *   /faculty/all-data/{id}   single faculty full profile with all shapes combined
 *
 * directorycc is frequently down (returns HTTP 500). Every profile fetch is
 * best-effort: on failure we still return whatever vitfac/Supabase has and mark
 * `directoryAvailable: false`, so the client degrades gracefully and retries
 * on the next cache expiry.
 *
 * Beyond faculty, the worker also fronts the public, unauthenticated data the
 * AmazeCC app used to fetch from third-party origins in the browser:
 *   /transport/buses        public VTOP bus routes (via api.amazecc.com)
 *   /fresher/resources      dashboard fresher links (via api.amazecc.com)
 *   /unmessify/{file}.json  mess menus + laundry slots (unmessify GitHub Pages)
 *   /github/commits         this repo's changelog (api.github.com)
 *   /wp-media/{id}          VIT Chennai WordPress media lookup
 *
 * Those are documented in more detail next to their handlers below.
 */
import { roster as rosterData } from "./roster";
import { facultyAllData } from "./allData";

interface Env {
  CACHE: KVNamespace;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  CACHE_TTL_SECONDS: string;
  WP_BASE?: string;
  DIRECTORYCC_BASE?: string;
  /** Origin of the AmazeCC API, for the routes the worker proxies upstream. */
  AMAZECC_API_BASE?: string;
  /** Origin of the unmessify JSON host (mess menus + laundry slots). */
  UNMESSIFY_BASE?: string;
  /** Optional GitHub token for /github/commits. Unauthenticated is fine, just 60/hr. */
  GITHUB_TOKEN?: string;
  /** Edge CDN origin for images (defaults to https://cdn.amazecc.com). */
  CDN_BASE?: string;
}

interface VitfacMetrics {
  lecture: number;
  da: number;
  vibe: number;
}

interface VitfacLoreItem {
  text: string;
  count: number;
}

interface VitfacFaculty {
  id: string;
  employeeId: string;
  name: string;
  designation?: string;
  dept?: string;
  courses?: string[];
  wPct: number;
  reviews: number;
  wCount: number;
  lCount: number;
  metrics?: VitfacMetrics;
  lore?: { green?: VitfacLoreItem[]; red?: VitfacLoreItem[] };
  image_url?: string | null;
}

interface RosterEntry {
  employeeId: string;
  name: string;
  school: string;
  wpId: number;
  slug: string;
  profileUrl: string;
  wpUrl: string;
  featuredMedia: number | null;
  imageUrl?: string | null;
}

const SCHOOL_POST_TYPES = [
  "scope", "select", "sense", "mechanical", "vfit", "vitlaw", "sce",
  "sas-che-faculties", "sbst", "ssl", "vitbs", "vsmart", "physics",
  "mathematics", "industrial_design", "multimedia", "cdmm-centers", "cnr-centers",
];

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(data: unknown, status = 200, ttlSeconds = 3600): Response {
  const cacheHeaders: Record<string, string> =
    status === 200 && ttlSeconds > 0
      ? {
          "Cache-Control": `public, max-age=${Math.min(ttlSeconds, 3600)}, s-maxage=${ttlSeconds}, stale-while-revalidate=86400`,
        }
      : status === 404
        ? { "Cache-Control": "public, max-age=60, s-maxage=60" }
        : {};

  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...cacheHeaders,
    },
  });
}

function encodeB64(s: string): string {
  return btoa(s);
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/^(dr|prof|mr|mrs|ms)\.?\s+/i, "").replace(/[^a-z0-9]/g, "");
}

const CDN_BASE_DEFAULT = "https://cdn.amazecc.com";

function toCdnUrl(env: Env, url: string | null | undefined, empId?: string | null): string | null {
  if (!url) return null;
  const cdn = (env.CDN_BASE || CDN_BASE_DEFAULT).replace(/\/+$/, "");
  if (url.startsWith(cdn)) return url;
  if (empId && empId.trim()) {
    return `${cdn}/faculty/${empId.trim()}.webp`;
  }
  const match = url.match(/\/images\/([0-9a-zA-Z_-]+)\.(?:webp|jpg|jpeg|png)$/i);
  if (match) {
    return `${cdn}/faculty/${match[1]}.webp`;
  }
  // Route Supabase storage image URLs through cdn.amazecc.com/images/...
  return url.replace(
    /^https:\/\/[a-z0-9]+\.supabase\.co\/storage\/v1\/object\/public\//i,
    `${cdn}/`
  );
}

async function buildProfile(env: Env, empId: string): Promise<any | null> {
  const cachedList = (await env.CACHE.get("faculty_list_v1", "json")) as VitfacFaculty[] | null;
  const f = cachedList?.find((item) => item.employeeId === empId || item.id === encodeB64(empId));
  if (!f) return null;

  return {
    prof: f,
    courseStats: {
      global: {
        reviews: f.reviews,
        wPct: f.wPct,
        metrics: f.metrics,
        lore: f.lore,
      },
      courses: (f.courses || []).map((code) => ({
        code,
        name: undefined,
        reviews: 0,
        wPct: f.wPct,
        metrics: f.metrics,
        lore: f.lore,
      })),
    },
  };
}

// ---------- directorycc / VIT Chennai roster ----------

const WP_BASE_DEFAULT = "https://chennai.vit.ac.in";
const DIRECTORYCC_BASE_DEFAULT = "https://directorycc.vit.ac.in";

function wpBase(env: Env): string {
  return (env.WP_BASE || WP_BASE_DEFAULT).replace(/\/$/, "");
}

function directoryccBase(env: Env): string {
  return (env.DIRECTORYCC_BASE || DIRECTORYCC_BASE_DEFAULT).replace(/\/$/, "");
}

function extractEmployeeId(linksTo: unknown): string | null {
  const m = String(linksTo || "").match(/\/faculty\/(\d+)/);
  return m ? m[1] : null;
}

async function fetchSchoolRoster(env: Env, school: string): Promise<RosterEntry[]> {
  const entries: RosterEntry[] = [];
  let page = 1;
  while (page <= 50) {
    const url = `${wpBase(env)}/wp-json/wp/v2/${school}?per_page=100&page=${page}&_fields=id,title,slug,link,meta,featured_media`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { "User-Agent": "amazecc-cache/1.0 (+https://amazecc.com)" } });
    } catch {
      break;
    }
    if (!res.ok) break;
    let items: any[];
    try {
      items = await res.json();
    } catch {
      break;
    }
    if (!Array.isArray(items) || items.length === 0) break;

    for (const item of items) {
      const linksTo = item?.meta?._links_to;
      const employeeId = extractEmployeeId(linksTo);
      if (!employeeId) continue;
      const renderedTitle = item?.title?.rendered || item?.title || "";
      const name = String(renderedTitle).replace(/<[^>]+>/g, "").trim();
      entries.push({
        employeeId,
        name,
        school,
        wpId: Number(item?.id) || 0,
        slug: String(item?.slug || ""),
        profileUrl: String(linksTo || ""),
        wpUrl: String(item?.link || ""),
        featuredMedia: item?.featured_media ?? null,
        imageUrl: null,
      });
    }

    if (items.length < 100) break;
    page++;
  }

  // Best-effort: resolve each entry's photo URL from the WP media endpoint.
  // Concurrency-limited so a slow school cannot stall the whole roster build;
  // failures leave imageUrl null and the client resolves it on demand.
  const CONC = 6;
  for (let i = 0; i < entries.length; i += CONC) {
    const batch = entries.slice(i, i + CONC);
    await Promise.all(
      batch.map(async (e) => {
        if (!e.featuredMedia) return;
        try {
          const res = await fetch(`${wpBase(env)}/wp-json/wp/v2/media/${e.featuredMedia}`);
          if (!res.ok) return;
          const data: any = await res.json();
          const src = data?.source_url || data?.guid?.rendered || null;
          if (src) e.imageUrl = src;
        } catch {
          // leave null
        }
      })
    );
  }
  return entries;
}

async function buildRoster(env: Env, ctx?: ExecutionContext): Promise<RosterEntry[]> {
  // Baked-in roster (generated at build time from chennai.vit.ac.in) is the
  // complete, reliable floor: Cloudflare's edge can't always reach chennai
  // (TLS), so the live fetch below is only a best-effort refresh.
  const floor: RosterEntry[] = (rosterData as unknown as RosterEntry[]) || [];
  const byId = new Map<string, RosterEntry>();
  for (const e of floor) byId.set(e.employeeId, e);

  const refresh = async (): Promise<RosterEntry[]> => {
    try {
      const results = await Promise.all(
        SCHOOL_POST_TYPES.map((school) => fetchSchoolRoster(env, school).catch(() => [] as RosterEntry[]))
      );
      for (const e of results.flat()) {
        byId.set(e.employeeId, e); // live overrides floor
      }
    } catch {
      // keep floor
    }
    const merged = Array.from(byId.values());
    try {
      await env.CACHE.put("faculty_roster_v1", JSON.stringify(merged), { expirationTtl: 24 * 60 * 60 });
    } catch {
      // ignore
    }
    return merged;
  };

  // When a request context is available, return the floor immediately and
  // refresh the cache in the background so the response is instant.
  if (ctx) {
    ctx.waitUntil(refresh());
    return Array.from(byId.values());
  }
  return await refresh();
}

async function fetchDirectoryProfile(empId: string, env: Env): Promise<any | null> {
  try {
    const res = await fetch(`${directoryccBase(env)}/api/faculty/${encodeURIComponent(empId)}?format=profile`);
    if (!res.ok) return null;
    const data = await res.json();
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

async function buildCombinedCatalog(env: Env, ctx?: ExecutionContext): Promise<any[]> {
  const roster = await buildRoster(env, ctx);

  let vitfacList: VitfacFaculty[] = [];
  try {
    vitfacList = ((await env.CACHE.get("faculty_list_v1", "json")) as VitfacFaculty[]) || [];
  } catch {
    // ignore
  }

  const vitfacByEmp = new Map<string, VitfacFaculty>();
  for (const f of vitfacList) {
    vitfacByEmp.set(String(f.employeeId), f);
  }

  return roster.map((r) => {
    const v = vitfacByEmp.get(r.employeeId);
    return {
      employeeId: r.employeeId,
      name: r.name,
      school: r.school,
      wpId: r.wpId,
      slug: r.slug,
      profileUrl: r.profileUrl,
      wpUrl: r.wpUrl,
      featuredMedia: r.featuredMedia,
      // vitfac
      vitfacAvailable: !!v && v.reviews > 0,
      designation: v?.designation || null,
      dept: v?.dept || r.school || null,
      campus: v?.dept || null,
      image_url: toCdnUrl(env, v?.image_url, r.employeeId),
      imageUrl: toCdnUrl(env, v?.image_url, r.employeeId),
      wPct: v?.wPct ?? 0,
      reviews: v?.reviews ?? 0,
      wCount: v?.wCount ?? 0,
      lCount: v?.lCount ?? 0,
      metrics: v?.metrics ?? null,
      lore: v?.lore ?? null,
      courses: v?.courses ?? [],
    };
  });
}

async function buildCombinedProfile(env: Env, empId: string): Promise<any | null> {
  let f: VitfacFaculty | null = null;
  try {
    const list = ((await env.CACHE.get("faculty_list_v1", "json")) as VitfacFaculty[]) || [];
    f = list.find((item) => item.employeeId === empId || item.id === encodeB64(empId)) || null;
  } catch {
    // ignore
  }

  const dir = await fetchDirectoryProfile(empId, env);

  if (!f && !dir) return null;

  const cdnImg = toCdnUrl(env, null, empId);

  const prof: any = {
    employeeId: empId,
    name: dir?.name || f?.name || null,
    designation: dir?.designation || f?.designation || null,
    dept: f?.dept || null,
    campus: "Chennai",
    schoolPage: null,
    image: null, // NO base64 bloat! Served directly via cdn.amazecc.com
    imageUrl: cdnImg,
    email: dir?.email || null,
    intercom: dir?.intercom || null,
    phd: dir?.phd || null,
    researchArea: dir?.researchArea || [],
    areasOfSpecialization: dir?.areasOfSpecialization || [],
    links: dir?.links || null,
    metrics: { ...(f?.metrics || {}), ...(dir?.metrics || {}) },
    hIndexScopus: dir?.metrics?.hIndexScopus ?? null,
    i10Index: dir?.metrics?.i10Index ?? null,
    education: dir?.education || [],
    publications: dir?.publications || [],
    awards: dir?.awards || [],
    consultancyProjects: dir?.consultancyProjects || null,
    fundedProjects: dir?.fundedProjects || null,
    patentsGranted: dir?.patentsGranted || [],
    patentsPublished: dir?.patentsPublished || [],
    collaborations: dir?.collaborations || [],
    otherDetails: dir?.otherDetails || [],
    wPct: f?.wPct ?? 0,
    reviews: f?.reviews ?? 0,
    wCount: f?.wCount ?? 0,
    lCount: f?.lCount ?? 0,
    vitfacMetrics: f?.metrics || null,
    lore: f?.lore || null,
    courses: f?.courses || [],
    directoryAvailable: !!dir,
    vitfacAvailable: !!f && f.reviews > 0,
  };

  const courseStatsCourses = f
    ? (f.courses || []).map((code) => ({
        code,
        name: undefined,
        reviews: 0,
        wPct: f.wPct,
        metrics: f.metrics,
        lore: f.lore,
      }))
    : [];

  return {
    prof: {
      id: encodeB64(empId),
      employeeId: empId,
      name: prof.name,
      designation: prof.designation || undefined,
      dept: prof.dept || undefined,
      courses: prof.courses,
      wPct: prof.wPct,
      reviews: prof.reviews,
      wCount: prof.wCount,
      lCount: prof.lCount,
      metrics: prof.vitfacMetrics || undefined,
      lore: prof.lore,
      image_url: cdnImg,
      imageUrl: cdnImg,
      image: null,
      email: prof.email,
      intercom: prof.intercom,
      profileUrl: null,
      researchArea: prof.researchArea,
      areasOfSpecialization: prof.areasOfSpecialization,
      links: prof.links,
      education: prof.education,
      publications: prof.publications,
      awards: prof.awards,
    },
    courseStats: f
      ? {
          global: {
            reviews: f.reviews,
            wPct: f.wPct,
            metrics: f.metrics,
            lore: f.lore,
          },
          courses: courseStatsCourses,
        }
      : null,
    directory: {
      available: prof.directoryAvailable,
      name: prof.name,
      designation: prof.designation,
      email: prof.email,
      intercom: prof.intercom,
      image: null,
      imageUrl: cdnImg,
      phd: prof.phd,
      researchArea: prof.researchArea,
      areasOfSpecialization: prof.areasOfSpecialization,
      links: prof.links,
      metrics: {
        hIndexScopus: prof.hIndexScopus,
        i10Index: prof.i10Index,
      },
      education: prof.education,
      publications: prof.publications,
      awards: prof.awards,
      consultancyProjects: prof.consultancyProjects,
      fundedProjects: prof.fundedProjects,
      patentsGranted: prof.patentsGranted,
      patentsPublished: prof.patentsPublished,
      collaborations: prof.collaborations,
      otherDetails: prof.otherDetails,
    },
  };
}

// ---------- cached public-data proxies ----------
//
// The app used to fetch each of the documents below straight from a third-party
// origin in the browser. Serving them here turns every one of them into a single
// cached edge fetch: the browser stops talking to those origins, the origins stop
// seeing our users, and a rate limit that was previously per-student (GitHub's
// 60/hr unauthenticated) becomes per-worker.
//
// Everything is an explicit allowlist. There is deliberately no generic `?url=`
// passthrough: that would make cache.amazecc.com an open relay — free bandwidth
// on our account, our IP reputation attached to whatever anyone chose to fetch,
// and an SSRF path into whatever our own network can reach.

const AMAZECC_API_BASE_DEFAULT = "https://api.amazecc.com";
const UNMESSIFY_BASE_DEFAULT = "https://kanishka-developer.github.io/unmessify/json/en/";

/**
 * Sent on every upstream fetch. Some origins (chennai.vit.ac.in in particular)
 * answer Cloudflare's default fetch UA differently, or not at all.
 */
const USER_AGENT = "amazecc-cache/1.0 (+https://amazecc.com)";

function amazeccApiBase(env: Env): string {
  return (env.AMAZECC_API_BASE || AMAZECC_API_BASE_DEFAULT).replace(/\/$/, "");
}

function unmessifyBase(env: Env): string {
  return (env.UNMESSIFY_BASE || UNMESSIFY_BASE_DEFAULT).replace(/\/$/, "") + "/";
}

/**
 * Mess menus (VITC-{M,W}-{N,V,S}.json) and laundry slots (VITC-{...}-L.json).
 *
 * A fixed set rather than a pattern, so a path like `../../anything` or an
 * arbitrary upstream filename cannot be smuggled through. Thirteen files, all
 * verified live.
 */
const UNMESSIFY_FILES: ReadonlySet<string> = new Set([
  "VITC-M-N.json", "VITC-M-V.json", "VITC-M-S.json",
  "VITC-W-N.json", "VITC-W-V.json", "VITC-W-S.json",
  "VITC-A-L.json", "VITC-CB-L.json", "VITC-D1-L.json", "VITC-D2-L.json",
  "VITC-E-L.json", "VITC-B-L.json", "VITC-CG-L.json",
]);

/**
 * The only repo whose commits we mirror. Not derived from any request input.
 */
const CHANGELOG_OWNER = "AmazeContinuityProjects";
const CHANGELOG_REPO = "AmazeCC";

/** Freshness windows, in seconds. */
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const TTL = {
  /** Bus routes change between semesters, not between refreshes. */
  buses: DAY,
  /** A curated link list; the app only needs it on first paint. */
  fresherResources: DAY,
  /** Mess/laundry sheets are rewritten roughly weekly. */
  unmessify: 6 * HOUR,
  /** Changelog / GitHub commits mirror. */
  changelog: DAY,
  /** A faculty photo URL never changes once published. */
  wpMedia: 7 * DAY,
} as const;

/**
 * How long a superseded copy is kept past its freshness window, so an origin
 * outage degrades to "slightly old data" instead of an error.
 */
const STALE_GRACE = 30 * DAY;

/** Upstream body, passed through untouched with edge cache headers. */
function proxied(body: string, source: string, ttlSeconds = 3600): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-AmazeCC-Source": source,
      "Cache-Control": `public, max-age=${Math.min(ttlSeconds, 3600)}, s-maxage=${ttlSeconds}, stale-while-revalidate=86400`,
      ...CORS_HEADERS,
    },
  });
}

/**
 * Read-through cache for a public upstream document.
 *
 * Two KV keys do the work: `key` holds the last good body under a long TTL, and
 * `${key}:fresh` marks that body as still worth trusting under the short one.
 * A hit on the fresh marker answers straight from KV without touching the
 * upstream. A miss refetches — and if the upstream is down we serve the stale
 * body rather than an error, because a slightly out-of-date bus route beats no
 * bus route at all.
 *
 * Only the upstream's own success/failure decides what gets written: an error
 * page is never cached over a good copy.
 */
async function cachedProxy(
  env: Env,
  ctx: ExecutionContext,
  key: string,
  freshTtlSeconds: number,
  staleTtlSeconds: number,
  fetchUpstream: () => Promise<Response>,
): Promise<Response> {
  const isFresh = (await env.CACHE.get(`${key}:fresh`)) !== null;
  if (isFresh) {
    const body = await env.CACHE.get(key);
    if (body !== null) return proxied(body, "kv-cache", freshTtlSeconds);
  }

  try {
    const res = await fetchUpstream();
    if (!res.ok) throw new Error(`upstream returned ${res.status}`);
    const body = await res.text();
    ctx.waitUntil(
      Promise.all([
        env.CACHE.put(key, body, { expirationTtl: staleTtlSeconds }),
        env.CACHE.put(`${key}:fresh`, "1", { expirationTtl: freshTtlSeconds }),
      ]).catch(() => {})
    );
    return proxied(body, "upstream-fresh", freshTtlSeconds);
  } catch (err) {
    const stale = await env.CACHE.get(key);
    if (stale !== null) return proxied(stale, "kv-stale", 60);
    return json({ error: String(err) }, 502, 0);
  }
}

async function handleRoute(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const ttl = parseInt(env.CACHE_TTL_SECONDS || "3600", 10);
  const rosterTtl = 24 * 60 * 60;

    // ---- public bus routes ----
    //
    // VTOP publishes these without a login, so they can be cached for every
    // student at once. Proxied from api.amazecc.com rather than scraped from
    // VTOP directly: the API already owns the scraping and the session handling,
    // and this worker should not grow a second VTOP client.
    if (url.pathname === "/transport/buses") {
      return cachedProxy(env, ctx, "transport_buses_v1", TTL.buses, STALE_GRACE, () =>
        fetch(`${amazeccApiBase(env)}/api/buses`, {
          headers: { "User-Agent": USER_AGENT },
        })
      );
    }

    // ---- fresher resources ----
    //
    // The curated link list the dashboard shows to first-year students. Public,
    // and effectively static, so a day of freshness is plenty.
    if (url.pathname === "/fresher/resources") {
      return cachedProxy(env, ctx, "fresher_resources_v1", TTL.fresherResources, STALE_GRACE, () =>
        fetch(`${amazeccApiBase(env)}/api/fresher-resources`, {
          headers: { "User-Agent": USER_AGENT },
        })
      );
    }

    // ---- unmessify mess menus + laundry slots ----
    //
    // Previously fetched straight from kanishka-developer.github.io by every
    // client, on every visit, with `cache: "no-store"`. One cached copy here
    // serves the whole campus. The filename is matched against a fixed set — a
    // pattern like `/unmessify/.+` would turn this into an open proxy for
    // whatever path someone typed.
    const unmessifyMatch = url.pathname.match(/^\/unmessify\/([A-Za-z0-9-]+\.json)$/);
    if (unmessifyMatch) {
      const file = unmessifyMatch[1];
      if (!UNMESSIFY_FILES.has(file)) {
        return json({ error: "Unknown unmessify file" }, 404);
      }
      return cachedProxy(env, ctx, `unmessify_${file}_v1`, TTL.unmessify, STALE_GRACE, () =>
        fetch(`${unmessifyBase(env)}${file}`, {
          headers: { "User-Agent": USER_AGENT },
        })
      );
    }

    // ---- this repo's changelog ----
    //
    // Unauthenticated GitHub allows 60 requests/hour per IP. A campus full of
    // students behind a shared NAT would exhaust that in seconds, so the
    // browser must not call it directly. A token is optional: without one this
    // is still fine, because the 5-minute cache means the worker makes at most
    // 12 upstream calls an hour.
    if (url.pathname === "/github/commits") {
      const perPage = Math.min(Math.max(parseInt(url.searchParams.get("per_page") || "30", 10) || 30, 1), 100);
      return cachedProxy(env, ctx, `github_commits_${perPage}_v1`, TTL.changelog, STALE_GRACE, () =>
        fetch(
          `https://api.github.com/repos/${CHANGELOG_OWNER}/${CHANGELOG_REPO}/commits?per_page=${perPage}`,
          {
            headers: {
              "User-Agent": USER_AGENT,
              Accept: "application/vnd.github.v3+json",
              ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
            },
          }
        )
      );
    }

    // ---- VIT Chennai WordPress media lookup ----
    //
    // Resolves a featured_media id to the photo's real URL. Numeric id only —
    // this cannot be aimed at an arbitrary WP endpoint. Kept here because
    // chennai.vit.ac.in rejects Cloudflare's TLS for several paths, so a
    // failure falls back to whatever the roster already resolved.
    const wpMediaMatch = url.pathname.match(/^\/wp-media\/(\d+)$/);
    if (wpMediaMatch) {
      const id = wpMediaMatch[1];
      return cachedProxy(env, ctx, `wp_media_${id}_v1`, TTL.wpMedia, STALE_GRACE, () =>
        fetch(`${wpBase(env)}/wp-json/wp/v2/media/${id}`, {
          headers: { "User-Agent": USER_AGENT },
        })
      );
    }

    // ---- vitfac catalog (legacy) ----
    if (url.pathname === "/faculty") {
      const cacheKey = "faculty_list_v1";
      const cached = await env.CACHE.get(cacheKey, "json");
      if (cached) return json({ data: { faculty: cached }, cached: true, source: "kv-cache" });
      return json({ error: "Faculty catalog not found in cache" }, 404);
    }

    // ---- schools (derived from roster) ----
    if (url.pathname === "/faculty/schools") {
      const cacheKey = "faculty_roster_v1";
      let roster: RosterEntry[] | null = await env.CACHE.get(cacheKey, "json");
      if (!roster) {
        try {
          roster = await buildRoster(env, ctx);
        } catch (err) {
          return json({ error: String(err) }, 502);
        }
      }
      const schools = [...new Set(roster.map((r) => r.school))]
        .sort()
        .map((s) => ({ id: s, school_name: s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) }));
      return json({ success: true, schools, cached: true, source: "roster" });
    }

    // ---- roster ----
    if (url.pathname === "/faculty/roster") {
      const cacheKey = "faculty_roster_v1";
      const cached = await env.CACHE.get(cacheKey, "json");
      if (cached) return json({ data: { faculty: cached }, cached: true, source: "kv-cache" });
      try {
        const roster = await buildRoster(env, ctx);
        return json({ data: { faculty: roster }, cached: false, source: "chennai-wp-fresh" });
      } catch (err) {
        return json({ error: String(err) }, 502);
      }
    }

    // ---- search ----
    const searchMatch = url.pathname.match(/^\/faculty\/search\/?$/);
    if (searchMatch) {
      const q = (url.searchParams.get("q") || "").toLowerCase().trim();
      const school = (url.searchParams.get("school") || "").toLowerCase().trim();
      const cacheKey = "faculty_roster_v1";
      let roster: RosterEntry[] | null = await env.CACHE.get(cacheKey, "json");
      if (!roster) {
        try {
          roster = await buildRoster(env, ctx);
        } catch (err) {
          return json({ error: String(err) }, 502);
        }
      }
      const filtered = roster.filter((r) => {
        if (school && r.school.toLowerCase() !== school) return false;
        if (!q) return true;
        return (
          r.name.toLowerCase().includes(q) ||
          r.employeeId.toLowerCase().includes(q) ||
          r.school.toLowerCase().includes(q)
        );
      });
      return json({ success: true, faculties: filtered, cached: true, source: "roster" });
    }

    // ---- combined directory profile ----
    const dirProfileMatch = url.pathname.match(/^\/faculty\/profile\/(.+)$/);
    if (dirProfileMatch) {
      const raw = decodeURIComponent(dirProfileMatch[1]);
      const empId = /^[0-9]+$/.test(raw) ? raw : (() => { try { return atob(raw).trim(); } catch { return raw; } })();
      const cacheKey = `directory_profile_${empId}_v1`;
      const cached = await env.CACHE.get(cacheKey, "json");
      if (cached) return json({ data: cached, cached: true, source: "kv-cache" });
      try {
        const bundle = await buildCombinedProfile(env, empId);
        if (!bundle) return json({ data: null }, 404);
        // Only cache when we actually got something useful; short TTL if directorycc was down
        const ttlToUse = bundle.directory?.available ? rosterTtl : ttl;
        ctx.waitUntil(env.CACHE.put(cacheKey, JSON.stringify(bundle), { expirationTtl: ttlToUse }).catch(() => {}));
        return json({ data: bundle, cached: false, source: "fresh" });
      } catch (err) {
        return json({ error: String(err) }, 502);
      }
    }

    // ---- vitfac profile bundle (legacy) ----
    const profileMatch = url.pathname.match(/^\/profile\/(.+)$/);
    if (profileMatch) {
      const raw = decodeURIComponent(profileMatch[1]);
      const empId = /^[0-9]+$/.test(raw) ? raw : atob(raw).trim();
      const cacheKey = `profile_${empId}_v1`;
      const cached = await env.CACHE.get(cacheKey, "json");
      if (cached) return json({ data: cached, cached: true, source: "kv-cache" });
      try {
        const bundle = await buildProfile(env, empId);
        if (!bundle) return json({ data: null }, 404);
        ctx.waitUntil(env.CACHE.put(cacheKey, JSON.stringify(bundle), { expirationTtl: ttl }).catch(() => {}));
        return json({ data: bundle, cached: false, source: "kv-catalog" });
      } catch (err) {
        return json({ error: String(err) }, 502);
      }
    }

    // ---- all-data catalog (all faculties with complete shapes: directory + vitfac + roster) ----
    if (url.pathname === "/faculty/all-data" || url.pathname === "/faculty/all-data/") {
      const cacheKey = "faculty_all_data_v1";
      const cached = await env.CACHE.get(cacheKey, "json");
      if (cached) return json({ data: { faculty: cached }, cached: true, source: "kv-cache" });
      return json({ data: { faculty: facultyAllData }, cached: true, source: "baked-in" });
    }

    const allDataSingleMatch = url.pathname.match(/^\/faculty\/all-data\/(.+)$/);
    if (allDataSingleMatch) {
      const raw = decodeURIComponent(allDataSingleMatch[1]);
      const empId = /^[0-9]+$/.test(raw) ? raw : (() => { try { return atob(raw).trim(); } catch { return raw; } })();
      const single = (facultyAllData as readonly any[]).find((f) => f.employeeId === empId);
      if (single) return json({ data: single, cached: true, source: "baked-in" });
      const cacheKey = `directory_profile_${empId}_v1`;
      const cached: any = await env.CACHE.get(cacheKey, "json");
      if (cached) {
        const flat = { ...(cached.prof || {}), ...(cached.directory || {}) };
        return json({ data: flat, cached: true, source: "kv-cache" });
      }
      return json({ data: null }, 404);
    }

    // ---- combined catalog (all faculties, vitfac-enriched roster) ----
    if (url.pathname === "/faculty/combined" || url.pathname === "/faculty/all") {
      const cacheKey = "faculty_combined_v1";
      const cached = await env.CACHE.get(cacheKey, "json");
      if (cached) return json({ data: { faculty: cached }, cached: true, source: "kv-cache" });
      try {
        const combined = await buildCombinedCatalog(env, ctx);
        ctx.waitUntil(env.CACHE.put(cacheKey, JSON.stringify(combined), { expirationTtl: rosterTtl }).catch(() => {}));
        return json({ data: { faculty: combined }, cached: false, source: "fresh" });
      } catch (err) {
        return json({ error: String(err) }, 502);
      }
    }

    return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const response = await handleRoute(url, env, ctx);
    if (request.method === "HEAD") {
      return new Response(null, { status: response.status, headers: response.headers });
    }
    return response;
  },
};
