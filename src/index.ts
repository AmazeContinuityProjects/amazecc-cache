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
 *   /faculty/profile/{id}    combined shape: vitfac review aggregates + directorycc profile + image
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

interface Env {
  CACHE: KVNamespace;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
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

interface FacultyRow {
  id: number;
  employee_id: string;
  name: string;
  designation: string | null;
  image_url: string | null;
  school_page: string | null;
  campus: string | null;
}

interface ReviewRow {
  faculty_id: number;
  verdict: string | null;
  score_lecture: number | null;
  score_da: number | null;
  score_vibe: number | null;
  lore_chips: { green?: string[]; red?: string[] } | null;
  course_code: string | null;
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

async function supabaseFetch(env: Env, table: string, select: string, query = ""): Promise<any[]> {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}${query}`;
  const res = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase ${table} returned ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function fetchAll(env: Env, table: string, select: string, query = ""): Promise<any[]> {
  const pageSize = 1000;
  const rows: any[] = [];
  let offset = 0;
  while (true) {
    const page = await supabaseFetch(env, table, select, `${query}&limit=${pageSize}&offset=${offset}`);
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

function aggregateReviews(reviews: ReviewRow[]) {
  const total = reviews.length;
  const wCount = reviews.filter((r) => String(r.verdict || "").toUpperCase() === "W").length;
  const lCount = total - wCount;
  const wPct = total > 0 ? Math.round((wCount / total) * 100) : 0;
  const avg = (field: "score_lecture" | "score_da" | "score_vibe") =>
    total > 0 ? reviews.reduce((s, r) => s + (Number(r[field]) || 0), 0) / total : 0;
  const metrics: VitfacMetrics | undefined =
    total > 0 ? { lecture: avg("score_lecture"), da: avg("score_da"), vibe: avg("score_vibe") } : undefined;

  const greenCounts = new Map<string, number>();
  const redCounts = new Map<string, number>();
  for (const r of reviews) {
    const chips = r.lore_chips || {};
    for (const c of chips.green || []) greenCounts.set(c, (greenCounts.get(c) || 0) + 1);
    for (const c of chips.red || []) redCounts.set(c, (redCounts.get(c) || 0) + 1);
  }
  const toLore = (m: Map<string, number>): { text: string; count: number }[] =>
    Array.from(m.entries()).map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count);
  const green = toLore(greenCounts);
  const red = toLore(redCounts);
  const lore = green.length > 0 || red.length > 0 ? { green, red } : undefined;
  const courses = [...new Set(reviews.map((r) => r.course_code).filter(Boolean))] as string[];
  return { total, wCount, lCount, wPct, metrics, lore, courses };
}

async function buildCatalog(env: Env): Promise<VitfacFaculty[]> {
  const [facultyRows, reviewRows] = await Promise.all([
    fetchAll(env, "faculty", "id,employee_id,name,designation,image_url,school_page,campus"),
    fetchAll(env, "reviews", "faculty_id,verdict,score_lecture,score_da,score_vibe,lore_chips,course_code"),
  ]);

  const reviewsByFaculty = new Map<number, ReviewRow[]>();
  for (const r of reviewRows as ReviewRow[]) {
    if (!reviewsByFaculty.has(r.faculty_id)) reviewsByFaculty.set(r.faculty_id, []);
    reviewsByFaculty.get(r.faculty_id)!.push(r);
  }

  return (facultyRows as FacultyRow[]).map((f) => {
    const revs = reviewsByFaculty.get(f.id) || [];
    const agg = aggregateReviews(revs);
    return {
      id: encodeB64(String(f.employee_id)),
      employeeId: String(f.employee_id),
      name: f.name,
      designation: f.designation || undefined,
      dept: f.school_page || f.campus || undefined,
      courses: agg.courses,
      wPct: agg.wPct,
      reviews: agg.total,
      wCount: agg.wCount,
      lCount: agg.lCount,
      metrics: agg.metrics,
      lore: agg.lore,
      image_url: toCdnUrl(env, f.image_url),
    };
  });
}

async function buildProfile(env: Env, empId: string): Promise<any | null> {
  const fRows = await supabaseFetch(
    env,
    "faculty",
    "id,employee_id,name,designation,image_url,school_page,campus",
    `&employee_id=eq.${encodeURIComponent(empId)}`
  );
  const f = (fRows as FacultyRow[])[0];
  if (!f) return null;

  const reviews = (await supabaseFetch(
    env,
    "reviews",
    "score_lecture,score_da,score_vibe,verdict,lore_chips,course_code",
    `&faculty_id=eq.${f.id}`
  )) as ReviewRow[];

  const globalAgg = aggregateReviews(reviews);

  const byCourse = new Map<string, ReviewRow[]>();
  for (const r of reviews) {
    const code = r.course_code;
    if (!code) continue;
    if (!byCourse.has(code)) byCourse.set(code, []);
    byCourse.get(code)!.push(r);
  }
  const courseStatsCourses = Array.from(byCourse.entries()).map(([code, revs]) => {
    const agg = aggregateReviews(revs);
    return {
      code,
      name: undefined,
      reviews: agg.total,
      wPct: agg.wPct,
      metrics: agg.metrics,
      lore: agg.lore,
    };
  });

  const prof: VitfacFaculty = {
    id: encodeB64(String(f.employee_id)),
    employeeId: String(f.employee_id),
    name: f.name,
    designation: f.designation || undefined,
    dept: f.school_page || f.campus || undefined,
    courses: globalAgg.courses,
    wPct: globalAgg.wPct,
    reviews: globalAgg.total,
    wCount: globalAgg.wCount,
    lCount: globalAgg.lCount,
    metrics: globalAgg.metrics,
    lore: globalAgg.lore,
    image_url: toCdnUrl(env, f.image_url),
  };

  return {
    prof,
    courseStats: {
      global: {
        reviews: globalAgg.total,
        wPct: globalAgg.wPct,
        metrics: globalAgg.metrics,
        lore: globalAgg.lore,
      },
      courses: courseStatsCourses,
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

  // vitfac side (Supabase) — best effort, joined by employee_id
  let facultyRows: FacultyRow[] = [];
  let reviewRows: ReviewRow[] = [];
  try {
    [facultyRows, reviewRows] = await Promise.all([
      fetchAll(env, "faculty", "id,employee_id,name,designation,image_url,school_page,campus"),
      fetchAll(env, "reviews", "faculty_id,verdict,score_lecture,score_da,score_vibe,lore_chips,course_code"),
    ]);
  } catch {
    // Supabase down — combined catalog degrades to roster-only
  }

  const reviewsByFaculty = new Map<number, ReviewRow[]>();
  for (const r of reviewRows as ReviewRow[]) {
    if (!reviewsByFaculty.has(r.faculty_id)) reviewsByFaculty.set(r.faculty_id, []);
    reviewsByFaculty.get(r.faculty_id)!.push(r);
  }
  const vitfacByEmp = new Map<string, { row: FacultyRow; agg: ReturnType<typeof aggregateReviews> }>();
  for (const f of facultyRows as FacultyRow[]) {
    const revs = reviewsByFaculty.get(f.id) || [];
    vitfacByEmp.set(String(f.employee_id), { row: f, agg: aggregateReviews(revs) });
  }

  return roster.map((r) => {
    const v = vitfacByEmp.get(r.employeeId);
    const agg = v?.agg;
    const f = v?.row;
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
      vitfacAvailable: !!v,
      designation: f?.designation || null,
      dept: f?.school_page || f?.campus || null,
      campus: f?.campus || null,
      image_url: toCdnUrl(env, f?.image_url),
      wPct: agg?.wPct ?? 0,
      reviews: agg?.total ?? 0,
      wCount: agg?.wCount ?? 0,
      lCount: agg?.lCount ?? 0,
      metrics: agg?.metrics ?? null,
      lore: agg?.lore ?? null,
      courses: agg?.courses ?? [],
    };
  });
}

async function buildCombinedProfile(env: Env, empId: string): Promise<any | null> {
  let f: FacultyRow | null = null;
  let reviews: ReviewRow[] = [];
  try {
    const fRows = await supabaseFetch(
      env,
      "faculty",
      "id,employee_id,name,designation,image_url,school_page,campus",
      `&employee_id=eq.${encodeURIComponent(empId)}`
    );
    f = (fRows as FacultyRow[])[0] || null;
    if (f) {
      reviews = (await supabaseFetch(
        env,
        "reviews",
        "score_lecture,score_da,score_vibe,verdict,lore_chips,course_code",
        `&faculty_id=eq.${f.id}`
      )) as ReviewRow[];
    }
  } catch {
    // Supabase down — continue with directorycc only
  }

  const vitfacAgg = reviews.length ? aggregateReviews(reviews) : null;
  const dir = await fetchDirectoryProfile(empId, env);

  if (!f && !dir) return null;

  const prof: any = {
    employeeId: empId,
    name: dir?.name || f?.name || null,
    designation: dir?.designation || f?.designation || null,
    dept: f?.school_page || f?.campus || null,
    campus: f?.campus || null,
    schoolPage: f?.school_page || null,
    image: dir?.image || null,
    imageUrl: toCdnUrl(env, f?.image_url),
    email: dir?.email || null,
    intercom: dir?.intercom || null,
    phd: dir?.phd || null,
    researchArea: dir?.researchArea || [],
    areasOfSpecialization: dir?.areasOfSpecialization || [],
    links: dir?.links || null,
    metrics: { ...(vitfacAgg?.metrics || {}), ...(dir?.metrics || {}) },
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
    wPct: vitfacAgg?.wPct ?? 0,
    reviews: vitfacAgg?.total ?? 0,
    wCount: vitfacAgg?.wCount ?? 0,
    lCount: vitfacAgg?.lCount ?? 0,
    vitfacMetrics: vitfacAgg?.metrics || null,
    lore: vitfacAgg?.lore || null,
    courses: vitfacAgg?.courses || [],
    directoryAvailable: !!dir,
    vitfacAvailable: !!f,
  };

  const courseStatsCourses = f
    ? Array.from(
        new Map(
          (reviews as ReviewRow[])
            .filter((r) => r.course_code)
            .map((r) => [r.course_code, r])
        ).keys()
      ).map((code) => {
        const revs = (reviews as ReviewRow[]).filter((r) => r.course_code === code);
        const agg = aggregateReviews(revs);
        return {
          code,
          name: undefined,
          reviews: agg.total,
          wPct: agg.wPct,
          metrics: agg.metrics,
          lore: agg.lore,
        };
      })
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
      image_url: toCdnUrl(env, prof.imageUrl),
      image: prof.image || null,
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
            reviews: vitfacAgg?.total ?? 0,
            wPct: vitfacAgg?.wPct ?? 0,
            metrics: vitfacAgg?.metrics,
            lore: vitfacAgg?.lore,
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
      image: prof.image,
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
      ])
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
      try {
        const faculty = await buildCatalog(env);
        ctx.waitUntil(env.CACHE.put(cacheKey, JSON.stringify(faculty), { expirationTtl: ttl }));
        return json({ data: { faculty }, cached: false, source: "supabase-fresh" });
      } catch (err) {
        return json({ error: String(err) }, 502);
      }
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
        ctx.waitUntil(env.CACHE.put(cacheKey, JSON.stringify(bundle), { expirationTtl: ttlToUse }));
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
        ctx.waitUntil(env.CACHE.put(cacheKey, JSON.stringify(bundle), { expirationTtl: ttl }));
        return json({ data: bundle, cached: false, source: "supabase-fresh" });
      } catch (err) {
        return json({ error: String(err) }, 502);
      }
    }

    // ---- combined catalog (all faculties, vitfac-enriched roster) ----
    if (url.pathname === "/faculty/combined" || url.pathname === "/faculty/all") {
      const cacheKey = "faculty_combined_v1";
      const cached = await env.CACHE.get(cacheKey, "json");
      if (cached) return json({ data: { faculty: cached }, cached: true, source: "kv-cache" });
      try {
        const combined = await buildCombinedCatalog(env, ctx);
        ctx.waitUntil(env.CACHE.put(cacheKey, JSON.stringify(combined), { expirationTtl: rosterTtl }));
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
