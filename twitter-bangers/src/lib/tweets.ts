export interface Tweet {
  id: string;
  url: string;
  handle: string;
  name: string;
  text: string;
  likes: number;
  createdAt: string; // ISO, '' when unparseable
  imageCount: number;
}

// Local calendar date N days before runDate, formatted for X's since: operator.
export function sinceDate(runDate: Date, lookbackDays: number): string {
  const d = new Date(runDate.getFullYear(), runDate.getMonth(), runDate.getDate() - lookbackDays);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function buildQuery(minFaves: number, since: string): string {
  return `min_faves:${minFaves} filter:images since:${since}`;
}

// No f= parameter is the "Top" tab: X's own ranking of what went big, which
// is what a bangers list should reflect. (f=live would be "Latest".)
export function searchUrl(query: string): string {
  return `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query`;
}

// X HTML-escapes full_text (`&amp;`, `&lt;`, `&#39;`…); captions should read
// as the author wrote them.
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// A tweet object as it appears in X's GraphQL responses. Newer payloads put the
// handle at core.user_results.result.core.screen_name, older ones at
// ...result.legacy.screen_name; both are read.
function toTweet(node: Obj): Tweet | null {
  const legacy = node.legacy;
  if (!isObj(legacy)) return null;
  // A retweet. The original tweet appears as its own search entry, so the
  // retweet adds nothing but a duplicate with the wrong author.
  if (isObj(legacy.retweeted_status_result)) return null;
  const id =
    typeof node.rest_id === 'string' ? node.rest_id : typeof legacy.id_str === 'string' ? legacy.id_str : null;
  if (!id) return null;

  const core = isObj(node.core) ? node.core : {};
  const userResults = isObj(core.user_results) ? core.user_results : {};
  const userResult = isObj(userResults.result) ? userResults.result : {};
  const userCore = isObj(userResult.core) ? userResult.core : {};
  const userLegacy = isObj(userResult.legacy) ? userResult.legacy : {};
  const handle = String(userCore.screen_name ?? userLegacy.screen_name ?? '');
  const name = String(userCore.name ?? userLegacy.name ?? handle);

  const extended = isObj(legacy.extended_entities) ? legacy.extended_entities : {};
  const entities = isObj(legacy.entities) ? legacy.entities : {};
  const media: unknown[] = Array.isArray(extended.media)
    ? extended.media
    : Array.isArray(entities.media)
      ? entities.media
      : [];
  const imageCount = media.filter((m) => isObj(m) && m.type === 'photo').length;

  const rawText = typeof legacy.full_text === 'string' ? legacy.full_text : '';
  // Media and quote links are t.co stubs that mean nothing in a caption.
  const text = decodeEntities(rawText.replace(/\s*https:\/\/t\.co\/\w+/g, '')).trim();
  const created = typeof legacy.created_at === 'string' ? new Date(legacy.created_at) : new Date(NaN);
  const likes =
    typeof legacy.favorite_count === 'number' ? legacy.favorite_count : Number(legacy.favorite_count) || 0;

  return {
    id,
    url: `https://x.com/${handle || 'i'}/status/${id}`,
    handle,
    name,
    text,
    likes,
    createdAt: Number.isNaN(created.getTime()) ? '' : created.toISOString(),
    imageCount,
  };
}

// Walk the whole response rather than the instruction/entry nesting, which X
// reshapes more often than the tweet object itself. Any object with a `legacy`
// block carrying full_text is a tweet; TweetWithVisibilityResults wraps it in
// `tweet`.
export function parseSearchResponse(body: unknown): Tweet[] {
  const found = new Map<string, Tweet>();
  const stack: unknown[] = [body];
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      stack.push(...cur);
      continue;
    }
    if (!isObj(cur)) continue;
    if (cur.__typename === 'TweetWithVisibilityResults' && isObj(cur.tweet)) {
      stack.push(cur.tweet);
      continue;
    }
    if (isObj(cur.legacy) && typeof cur.legacy.full_text === 'string') {
      const t = toTweet(cur);
      if (t && !found.has(t.id)) found.set(t.id, t);
      // Do not descend: a quoted or retweeted tweet nested here is not itself a
      // search hit, and if it is, it has its own entry.
      continue;
    }
    stack.push(...Object.values(cur));
  }
  return [...found.values()];
}

export function selectTweets(tweets: Tweet[], opts: { minFaves: number; maxPosts: number }): Tweet[] {
  const byId = new Map<string, Tweet>();
  for (const t of tweets) {
    if (t.likes < opts.minFaves || t.imageCount < 1) continue;
    const prev = byId.get(t.id);
    if (!prev || t.likes > prev.likes) byId.set(t.id, t);
  }
  return [...byId.values()].sort((a, b) => b.likes - a.likes).slice(0, opts.maxPosts);
}
