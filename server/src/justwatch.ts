/**
 * JustWatch GraphQL fallback for the deeplink resolver. Used when the TMDB
 * watch page doesn't surface a JustWatch clickout for the (title, provider)
 * pair — TMDB's `/watch/providers` JSON occasionally lists a provider that
 * the user-facing HTML doesn't render a clickout for. Querying JustWatch
 * directly closes that gap and yields a clean provider URL with no affiliate
 * redirect chain to chase.
 */

const ENDPOINT = "https://apis.justwatch.com/graphql";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const SEARCH_QUERY = `query Search($country: Country!, $language: Language!, $first: Int!, $filter: TitleFilter) {
  popularTitles(country: $country, first: $first, filter: $filter) {
    edges {
      node {
        id
        objectType
        content(country: $country, language: $language) {
          externalIds { tmdbId }
        }
      }
    }
  }
}`;

const OFFERS_QUERY = `query Offers($nodeId: ID!, $country: Country!, $platform: Platform!) {
  node(id: $nodeId) {
    ... on MovieOrShow {
      offers(country: $country, platform: $platform) {
        standardWebURL
        monetizationType
        package { clearName }
      }
    }
  }
}`;

const MONETIZATION_RANK: Record<string, number> = {
  FLATRATE: 5,
  FREE: 4,
  ADS: 3,
  RENT: 2,
  BUY: 1,
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function gql<T>(
  query: string,
  variables: Record<string, unknown>,
  timeoutMs = 6000,
): Promise<T | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      signal: ac.signal,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: T; errors?: unknown };
    if (json.errors) return null;
    return json.data ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface SearchEdge {
  node: {
    id: string;
    objectType: string;
    content: { externalIds: { tmdbId: string | null } | null } | null;
  };
}

/**
 * Find the JustWatch node id for a TMDB title. We search by title string with
 * `includeTitlesWithoutUrl: true` (without it, regional catalog gaps hide
 * titles even when JustWatch has them indexed), then filter the results by
 * matching tmdbId — the only field that gives an exact crossref.
 */
async function searchNodeId(
  title: string,
  tmdbId: number,
  mediaType: "movie" | "tv",
  country: string,
): Promise<string | null> {
  const data = await gql<{ popularTitles: { edges: SearchEdge[] } }>(SEARCH_QUERY, {
    country,
    language: "en",
    first: 10,
    filter: { searchQuery: title, includeTitlesWithoutUrl: true },
  });
  if (!data) return null;
  const wantedType = mediaType === "movie" ? "MOVIE" : "SHOW";
  const wantedTmdb = String(tmdbId);
  for (const edge of data.popularTitles?.edges ?? []) {
    if (edge.node.objectType !== wantedType) continue;
    if (edge.node.content?.externalIds?.tmdbId === wantedTmdb) return edge.node.id;
  }
  return null;
}

interface Offer {
  standardWebURL: string | null;
  monetizationType: string | null;
  package: { clearName: string | null } | null;
}

async function fetchOfferUrl(
  nodeId: string,
  country: string,
  providerName: string,
): Promise<string | null> {
  const data = await gql<{ node: { offers: Offer[] } | null }>(OFFERS_QUERY, {
    nodeId,
    country,
    platform: "WEB",
  });
  const offers = data?.node?.offers;
  if (!offers) return null;
  const wanted = normalize(providerName);
  let best: { url: string; rank: number } | null = null;
  for (const offer of offers) {
    if (!offer.standardWebURL || !offer.package?.clearName) continue;
    if (normalize(offer.package.clearName) !== wanted) continue;
    const rank = MONETIZATION_RANK[offer.monetizationType ?? ""] ?? 0;
    if (!best || rank > best.rank) {
      best = { url: offer.standardWebURL, rank };
    }
  }
  return best?.url ?? null;
}

export interface JustWatchLookup {
  title: string;
  tmdbId: number;
  mediaType: "movie" | "tv";
  providerName: string;
  country: string;
  /** Optional: pre-known JustWatch node id (e.g. extracted from a TMDB-page cx blob); skips the search round-trip. */
  knownNodeId?: string | null;
}

export async function resolveViaJustWatch(opts: JustWatchLookup): Promise<string | null> {
  const nodeId =
    opts.knownNodeId ??
    (await searchNodeId(opts.title, opts.tmdbId, opts.mediaType, opts.country));
  if (!nodeId) return null;
  return fetchOfferUrl(nodeId, opts.country, opts.providerName);
}
