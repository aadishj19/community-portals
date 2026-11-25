// Data source: the JSON API behind editx.eu's own job search. The listing pages
// are a JavaScript app whose HTML is an empty shell; the browser fills the job
// cards from api.editx.eu/api/editx/jobs and opens a posting from
// api.editx.eu/api/editx/job/<id>, both without authentication. This CLI reads
// the same two endpoints. They are undocumented and may change without notice.
//
// Only api.editx.eu is requested. editx.eu appears in output as the public
// posting URL and is accepted as `detail` input; it is never fetched.

export const API_ORIGIN = "https://api.editx.eu"
export const SITE_ORIGIN = "https://editx.eu"
export const SEARCH_PATH = "/api/editx/jobs"
export const DETAIL_PATH = "/api/editx/job/"

// The API returns at most 50 jobs per request; a larger `count` is capped
// server-side without an error.
export const MAX_PAGE_SIZE = 50

const UA = "Mozilla/5.0 (compatible; editx-search-cli/1.0)"

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

export function writeWarning(warning: string, code: string): void {
  process.stderr.write(JSON.stringify({ warning, code }) + "\n")
}

// The most apiGet sleeps across all retries of one request. Its own backoff
// schedule (500ms doubling to 8s, six retries) stays under it; a Retry-After
// that would push past it fails the request at once instead.
const RETRY_BUDGET_MS = 30_000

/**
 * The wait a 429/503 asks for via `Retry-After`, in ms, or null when absent or
 * unreadable. Accepts both RFC 9110 forms: delta-seconds and an HTTP-date.
 */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null
  const value = header.trim()
  if (/^\d+$/.test(value)) return Number(value) * 1000
  const date = Date.parse(value)
  if (Number.isNaN(date)) return null
  return Math.max(date - now, 0)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * GET JSON from api.editx.eu. Retries 429/5xx with exponential backoff plus
 * jitter (500ms doubling to 8s, six retries), waiting at least as long as a
 * `Retry-After` header asks, within RETRY_BUDGET_MS. Returns `null` on a 404
 * (the API answers a missing job with 404 and the JSON body "Not Found").
 * Redirects are refused rather than followed, so a request can never leave
 * the declared host. A connection failure fails fast without retrying.
 */
export async function apiGet<T>(pathAndQuery: string): Promise<T | null> {
  const url = `${API_ORIGIN}${pathAndQuery}`
  const maxRetries = 6
  let delay = 500
  let waited = 0

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response
    try {
      response = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      })
    } catch (e) {
      throw new Error(`could not reach ${API_ORIGIN} (${e instanceof Error ? e.message : String(e)})`)
    }

    if (response.status >= 300 && response.status < 400) {
      throw new Error(`editx API answered with a redirect (${response.status}); refusing to follow it off ${API_ORIGIN}`)
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) {
        throw new Error(`editx API request failed: ${response.status} ${response.statusText}`)
      }
      const backoff = delay + Math.floor(Math.random() * 500)
      const retryAfter = retryAfterMs(response.headers.get("Retry-After"))
      const wait = Math.max(backoff, retryAfter ?? 0)
      if (waited + wait > RETRY_BUDGET_MS) {
        throw new Error(
          `editx API request failed: ${response.status} ${response.statusText}; ` +
            `the server asked to retry in ${Math.ceil(wait / 1000)}s, past this CLI's ${RETRY_BUDGET_MS / 1000}s retry budget`,
        )
      }
      await sleep(wait)
      waited += wait
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (response.status === 404) return null
    if (!response.ok) {
      throw new Error(`editx API request failed: ${response.status} ${response.statusText}`)
    }
    const body = (await response.json().catch(() => undefined)) as T | undefined
    if (body === undefined) throw new Error("editx API returned an unparseable response body")
    return body
  }
  throw new Error("editx API request failed after retries")
}

// ---------------------------------------------------------------------------
// Wire shapes (only the fields this CLI reads; the API sends more, including a
// `recruiter` object with a named person's details that is never read).

interface Labelled {
  id?: string
  label?: string
}

interface EditxDate {
  value?: string
}

export interface EditxJob {
  id: string | number
  title?: string
  status?: string
  onlineDate?: EditxDate
  locality?: string
  areas?: Labelled[] | null
  company?: { label?: string } | null
  contracts?: Labelled[] | null
  remote?: Labelled | null
  skills?: Labelled[] | null
}

export interface EditxJobDetail extends EditxJob {
  openToApply?: boolean
  applicationType?: string
  applicationAction?: string
  languages?: string[] | null
  shortDescription?: string
  role?: string
  profile?: string
  proposal?: string
  functions?: Labelled[] | null
  experiences?: Labelled[] | null
  educations?: Labelled[] | null
}

/** The search endpoint's envelope. `jobs` is `null` past the last page, where `total` also drops to 0. */
export interface EditxSearchResponse {
  total?: number
  page?: number | string
  count?: number | string
  jobs?: EditxJob[] | null
}

/**
 * A search result in the portal-skill contract shape. `id` is the Editx job id
 * (what `detail` consumes); `date` is the posting's online date as YYYY-MM-DD;
 * missing values are `null`, never omitted.
 */
export interface JobResult {
  id: string
  title: string
  company: string | null
  location: string | null
  date: string | null
  url: string
  remote: string | null
  contract: string | null
  skills: string[]
}

export interface JobDetailResult extends JobResult {
  status: string | null
  open_to_apply: boolean | null
  apply_url: string | null
  languages: string[]
  experience: string[]
  education: string[]
  functions: string[]
  summary: string | null
  description: string | null
}

function labels(list: Labelled[] | null | undefined): string[] {
  if (!Array.isArray(list)) return []
  return list.map((x) => clean(x?.label)).filter((x): x is string => x !== null)
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null
  const text = decodeHtmlEntities(value).replace(/\s+/g, " ").trim()
  return text || null
}

/** YYYY-MM-DD from the API's "2026-11-17 08:10:22" timestamps, or null. */
export function contractDate(value: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value ?? "")
  return m ? m[1] : null
}

/** The URL slug editx.eu uses for a posting title. Cosmetic: the site resolves a posting by its id. */
export function slugify(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function postingUrl(id: string, title: string): string {
  const slug = slugify(title)
  return `${SITE_ORIGIN}/en/it-jobs/${id}${slug ? `/${slug}` : ""}`
}

/** Whether a search response entry is a job this CLI can map (an object with a numeric id). */
export function isJob(entry: unknown): entry is EditxJob {
  if (entry === null || typeof entry !== "object") return false
  const id = (entry as { id?: unknown }).id
  return (typeof id === "string" || typeof id === "number") && /^\d{1,12}$/.test(String(id))
}

export function toResult(job: EditxJob): JobResult {
  const id = String(job.id)
  const rawTitle = clean(job.title)
  const place = [clean(job.locality), ...labels(job.areas)].filter((x): x is string => x !== null)
  const location = [...new Set(place)].join(", ") || null
  const contracts = labels(job.contracts)
  return {
    id,
    title: rawTitle ?? "(untitled)",
    company: clean(job.company?.label),
    location,
    date: contractDate(job.onlineDate?.value),
    url: postingUrl(id, rawTitle ?? ""),
    remote: clean(job.remote?.label),
    contract: contracts.length ? contracts.join(", ") : null,
    skills: labels(job.skills),
  }
}

const TRACKING_PARAM = /^(utm_[a-z_]+|gclid|fbclid|mc_cid|mc_eid)$/i

/**
 * An http(s) apply link with tracking parameters (utm_*, gclid, fbclid) removed,
 * or null for any other application type (e.g. applying inside Editx).
 */
function applyUrl(job: EditxJobDetail): string | null {
  if (job.applicationType !== "url" || typeof job.applicationAction !== "string") return null
  let u: URL
  try {
    u = new URL(job.applicationAction.trim())
  } catch {
    return null
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) u.searchParams.delete(key)
  }
  return u.toString().replace(/\?$/, "")
}

export function toDetail(job: EditxJobDetail): JobDetailResult {
  const sections: Array<[string, string | undefined]> = [
    ["The role", job.role],
    ["Profile", job.profile],
    ["Offer", job.proposal],
  ]
  const description = sections
    .map(([heading, html]) => {
      const text = cleanHtml(html)
      return text ? `${heading}\n${text}` : null
    })
    .filter((x): x is string => x !== null)
    .join("\n\n")
  return {
    ...toResult(job),
    status: clean(job.status),
    open_to_apply: typeof job.openToApply === "boolean" ? job.openToApply : null,
    apply_url: applyUrl(job),
    languages: Array.isArray(job.languages) ? job.languages.map((l) => String(l)) : [],
    experience: labels(job.experiences),
    education: labels(job.educations),
    functions: labels(job.functions),
    summary: cleanHtml(job.shortDescription),
    description: description || null,
  }
}

// ---------------------------------------------------------------------------
// Output hygiene (copied from linkedin-search/freehire-search helpers, with
// <noscript> added to the never-rendered blocks).

// The markup entities plus the Latin-1 letters and typographic marks that turn
// up in Dutch and French postings. Unknown names are left as written.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  agrave: "à",
  aacute: "á",
  acirc: "â",
  auml: "ä",
  ccedil: "ç",
  egrave: "è",
  eacute: "é",
  ecirc: "ê",
  euml: "ë",
  icirc: "î",
  iuml: "ï",
  ocirc: "ô",
  ouml: "ö",
  ugrave: "ù",
  ucirc: "û",
  uuml: "ü",
  Agrave: "À",
  Eacute: "É",
  Egrave: "È",
  Ccedil: "Ç",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  euro: "€",
  bull: "•",
  middot: "·",
}

function numericEntity(cp: number): string {
  return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""
}

/**
 * Decode HTML entities in a single pass, so an escaped entity ("&amp;lt;")
 * decodes once to its literal text ("&lt;") instead of twice to markup.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g, (whole, dec, hex, name) => {
    if (dec) return numericEntity(parseInt(dec, 10))
    if (hex) return numericEntity(parseInt(hex, 16))
    const named = NAMED_ENTITIES[name] ?? NAMED_ENTITIES[String(name).toLowerCase()]
    return named ?? whole
  })
}

/**
 * Characters a reader of the posting never sees but a model reading this
 * output does: C0/C1 controls other than tab, newline and carriage return, the
 * soft hyphen, bidi marks/embeddings/overrides/isolates, zero-width characters
 * and invisible operators, the BOM, variation selectors, and Unicode tag
 * characters (U+E0000-E007F).
 */
const INVISIBLE_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­؜᠎​-‏‪-‮⁠-⁯︀-️﻿\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu

/** Strip INVISIBLE_CHARS from every string in a result, recursively: the CLI's output boundary. */
export function stripInvisible<T>(value: T): T {
  if (typeof value === "string") return value.replace(INVISIBLE_CHARS, "") as T
  if (Array.isArray(value)) return value.map(stripInvisible) as T
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripInvisible(v)])) as T
  }
  return value
}

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"])

/** Whether an opening tag's attributes keep it from rendering: `hidden`, or an inline style that hides it. */
function isHiddenTag(attrs: string): boolean {
  for (const m of attrs.matchAll(/([^\s"'=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const name = m[1].toLowerCase()
    const value = m[2] ?? m[3] ?? m[4] ?? ""
    if (name === "hidden") return true
    if (name === "style" && /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all)\b/i.test(value)) {
      return true
    }
  }
  return false
}

/**
 * Drop markup a browser never renders - comments, <script>/<style>/<template>/
 * <noscript> blocks, and elements marked hidden - before tags are stripped.
 * CSS-only tricks (off-screen, zero font size) need a renderer and are not
 * caught here.
 */
export function visibleHtml(html: string): string {
  const src = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
  const tags = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[\s/](?:[^>"']|"[^"]*"|'[^']*')*)?)>/g
  const kept: string[] = []
  let from = 0
  let m: RegExpExecArray | null
  while ((m = tags.exec(src)) !== null) {
    if (m[1] || !m[3] || !isHiddenTag(m[3])) continue
    const tag = m[2].toLowerCase()
    let end = tags.lastIndex
    if (!VOID_TAGS.has(tag)) {
      // Skip to the matching close tag, counting nested same-name elements. An
      // unclosed hidden element runs to the end: failing closed drops visible
      // text, failing open would leak the hidden text.
      end = src.length
      let depth = 1
      let s: RegExpExecArray | null
      while ((s = tags.exec(src)) !== null) {
        if (s[2].toLowerCase() !== tag) continue
        depth += s[1] ? -1 : 1
        if (depth === 0) {
          end = tags.lastIndex
          break
        }
      }
    }
    kept.push(src.slice(from, m.index))
    from = end
    tags.lastIndex = end
  }
  kept.push(src.slice(from))
  return kept.join("")
}

/**
 * A posting's HTML section as readable text: hidden markup dropped, block and
 * line-break tags become newlines, list items get a bullet, tags are stripped
 * first and entities decoded once afterwards. Null for empty input.
 */
export function cleanHtml(html: string | null | undefined): string | null {
  if (!html) return null
  const withBreaks = visibleHtml(html)
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|ul|ol|div|h\d)>/gi, "\n")
  // Quote-aware, like visibleHtml: a `>` inside a quoted attribute is not the
  // end of the tag. Only `<` that starts a tag is stripped, so prose such as
  // "salary < 5000" survives.
  const text = decodeHtmlEntities(withBreaks.replace(/<[a-zA-Z/!?](?:[^>"']|"[^"]*"|'[^']*')*>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return text || null
}

/**
 * The Editx job id from a bare id or an editx.eu posting URL
 * (`https://editx.eu/<lang>/it-jobs/<id>[/<slug>]`). URLs are parsed for real,
 * so other hosts, look-alikes (editx.eu.evil.io) and userinfo tricks
 * (editx.eu@evil.io) are rejected before any request is made.
 */
export function normalizeId(input: string): string | null {
  const trimmed = input.trim()
  if (/^\d{1,12}$/.test(trimmed)) return trimmed
  const hasScheme = /^https?:\/\//i.test(trimmed)
  if (!hasScheme && !/^(www\.)?editx\.eu\//i.test(trimmed)) return null
  let parsed: URL
  try {
    parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  const host = parsed.hostname.toLowerCase()
  if (host !== "editx.eu" && host !== "www.editx.eu") return null
  if (parsed.username || parsed.password) return null
  const m = parsed.pathname.match(/^\/(?:(?:en|nl|fr)\/)?(?:it-jobs|job)\/(\d{1,12})(?:\/[^/]*)?\/?$/i)
  return m ? m[1] : null
}
