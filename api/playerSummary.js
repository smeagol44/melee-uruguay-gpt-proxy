// api/playerSummary.js
// Vercel Serverless Function (CommonJS)

const STARTGG_API_URL = "https://api.start.gg/gql/alpha";

function getBaseUrl(req) {
  // Prefer host header (works in Vercel), fallback to VERCEL_URL if needed
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (host) return `https://${host}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  // Last resort (should not happen in prod)
  return "https://melee-uruguay-gpt-proxy.vercel.app";
}

async function startggGraphQL(query, variables) {
  const apiKey = process.env.STARTGG_API_KEY;
  if (!apiKey) {
    const err = new Error("Missing STARTGG_API_KEY");
    err.statusCode = 500;
    throw err;
  }

  const res = await fetch(STARTGG_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(`Start.gg HTTP ${res.status}`);
    err.statusCode = res.status;
    err.details = json;
    throw err;
  }
  if (json?.errors?.length) {
    const err = new Error("Start.gg GraphQL errors");
    err.statusCode = 502;
    err.details = json.errors;
    throw err;
  }
  return json.data;
}

function normTag(s) {
  return String(s || "").trim();
}

function safeNumber(n) {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

async function fetchLeagueEvents(baseUrl, year) {
  const url = new URL(`${baseUrl}/api/leagueEvents`);
  if (year) url.searchParams.set("year", String(year));
  // Tu endpoint soporta resolve (por default = 1), lo dejamos como está.

  const res = await fetch(url.toString(), { method: "GET" });
  if (!res.ok) throw new Error(`leagueEvents failed: HTTP ${res.status}`);
  const data = await res.json();

  // data.events puede ser array de objetos o strings (según cómo lo dejes).
  const eventsRaw = Array.isArray(data?.events) ? data.events : [];
  const slugs = [];
  for (const item of eventsRaw) {
    if (typeof item === "string") {
      if (item.trim()) slugs.push(item.trim());
      continue;
    }
    if (item && typeof item === "object" && typeof item.eventSlug === "string" && item.eventSlug.trim()) {
      slugs.push(item.eventSlug.trim());
    }
  }

  return { year: data?.year ?? year, slugs };
}

async function checkAttendanceViaProxy(baseUrl, eventSlug, playerTag) {
  const res = await fetch(`${baseUrl}/api/attendance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventSlug, playerTag }),
  });
  if (!res.ok) throw new Error(`attendance failed: HTTP ${res.status}`);
  const data = await res.json();
  return {
    attended: !!data?.attended,
    placement: safeNumber(data?.placement),
  };
}

/**
 * Attempts to compute set wins/losses + best consecutive win streak inside a single event.
 * If it cannot resolve entrant or sets, returns nulls (no guessing).
 */
async function getEventSetStats(eventSlug, playerTag) {
  const tag = normTag(playerTag);
  if (!tag) return { setWins: null, setLosses: null, bestWinStreak: null };

  // 1) Find entrantId for this player in this event by participants.gamerTag
  // NOTE: Start.gg search/filtering is limited; we fetch entrants pages and match participants.gamerTag case-insensitive.
  const findEntrantQuery = `
    query FindEntrant($slug: String!, $page: Int!, $perPage: Int!) {
      event(slug: $slug) {
        id
        entrants(query: { page: $page, perPage: $perPage }) {
          pageInfo { totalPages }
          nodes {
            id
            participants {
              gamerTag
            }
          }
        }
      }
    }
  `;

  let entrantId = null;
  const perPage = 80;
  let page = 1;
  let totalPages = 1;
  const tagLower = tag.toLowerCase();

  while (page <= totalPages && page <= 10 && !entrantId) {
    const data = await startggGraphQL(findEntrantQuery, { slug: eventSlug, page, perPage });
    const entrants = data?.event?.entrants?.nodes || [];
    totalPages = data?.event?.entrants?.pageInfo?.totalPages || 1;

    for (const e of entrants) {
      const parts = e?.participants || [];
      const match = parts.some((p) => String(p?.gamerTag || "").toLowerCase() === tagLower);
      if (match) {
        entrantId = e.id;
        break;
      }
    }
    page++;
  }

  if (!entrantId) {
    // No entrant match => cannot compute sets without guessing.
    return { setWins: null, setLosses: null, bestWinStreak: null };
  }

  // 2) Fetch all sets for that entrant in this event
  const setsQuery = `
    query SetsForEntrant($slug: String!, $entrantId: ID!, $page: Int!, $perPage: Int!) {
      event(slug: $slug) {
        sets(
          page: $page
          perPage: $perPage
          sortType: STANDARD
          filters: { entrantIds: [$entrantId] }
        ) {
          pageInfo { totalPages }
          nodes {
            id
            winnerId
            completedAt
            slots {
              entrant { id }
            }
          }
        }
      }
    }
  `;

  let setWins = 0;
  let setLosses = 0;
  let bestWinStreak = 0;
  let currentStreak = 0;

  const allSets = [];
  page = 1;
  totalPages = 1;

  while (page <= totalPages && page <= 20) {
    const data = await startggGraphQL(setsQuery, {
      slug: eventSlug,
      entrantId,
      page,
      perPage: 80,
    });

    const sets = data?.event?.sets?.nodes || [];
    totalPages = data?.event?.sets?.pageInfo?.totalPages || 1;
    allSets.push(...sets);
    page++;
  }

  // If no sets, we can still return 0/0 with streak 0 (that’s factual).
  // Order by completedAt when present; otherwise stable by id.
  allSets.sort((a, b) => {
    const ta = typeof a?.completedAt === "number" ? a.completedAt : -1;
    const tb = typeof b?.completedAt === "number" ? b.completedAt : -1;
    if (ta !== tb) return ta - tb;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  });

  for (const s of allSets) {
    const winnerId = s?.winnerId;
    if (!winnerId) continue; // unfinished/invalid => skip (no guessing)

    const won = String(winnerId) === String(entrantId);
    if (won) {
      setWins++;
      currentStreak++;
      if (currentStreak > bestWinStreak) bestWinStreak = currentStreak;
    } else {
      // If entrant participated and winnerId is not entrantId, treat as a loss
      // (safe given filters by entrantIds)
      setLosses++;
      currentStreak = 0;
    }
  }

  return { setWins, setLosses, bestWinStreak };
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "GET") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const baseUrl = getBaseUrl(req);

    const year = req.query?.year ? parseInt(req.query.year, 10) : new Date().getFullYear();
    const playerTag = normTag(req.query?.playerTag);

    if (!playerTag) {
      res.status(400).json({ error: "Missing required query param: playerTag" });
      return;
    }

    // 1) Get MMM ranked event slugs for the year
    const { year: resolvedYear, slugs } = await fetchLeagueEvents(baseUrl, year);

    if (!slugs.length) {
      res.status(200).json({
        year: resolvedYear,
        playerTag,
        tournamentsAttended: 0,
        top8s: 0,
        avgPlacement: null,
        placementsCounted: 0,
        winrate: null,
        setWins: 0,
        setLosses: 0,
        bestWinStreak: 0,
      });
      return;
    }

    // 2) Iterate events: attendance + placement + optional set stats
    let tournamentsAttended = 0;
    let top8s = 0;

    let placementsSum = 0;
    let placementsCounted = 0;

    let totalSetWins = 0;
    let totalSetLosses = 0;
    let bestWinStreak = 0;

    // Sequential to be kind to Start.gg rate limits.
    for (const eventSlug of slugs) {
      const { attended, placement } = await checkAttendanceViaProxy(baseUrl, eventSlug, playerTag);

      if (!attended) continue;

      tournamentsAttended++;

      if (typeof placement === "number") {
        placementsSum += placement;
        placementsCounted++;
        if (placement <= 8) top8s++;
      }

      // Winrate / streak needs sets. If it fails for this event, skip sets (no guessing).
      try {
        const ss = await getEventSetStats(eventSlug, playerTag);
        if (typeof ss.setWins === "number" && typeof ss.setLosses === "number") {
          totalSetWins += ss.setWins;
          totalSetLosses += ss.setLosses;
        }
        if (typeof ss.bestWinStreak === "number" && ss.bestWinStreak > bestWinStreak) {
          bestWinStreak = ss.bestWinStreak;
        }
      } catch {
        // Ignore per-event set failures without fabricating.
      }
    }

    const avgPlacement = placementsCounted > 0 ? placementsSum / placementsCounted : null;
    const winrateDen = totalSetWins + totalSetLosses;
    const winrate = winrateDen > 0 ? totalSetWins / winrateDen : null;

    res.status(200).json({
      year: resolvedYear,
      playerTag,
      tournamentsAttended,
      top8s,
      avgPlacement,
      placementsCounted,
      winrate,
      setWins: totalSetWins,
      setLosses: totalSetLosses,
      bestWinStreak,
    });
  } catch (err) {
    res.status(500).json({
      error: "playerSummary failed",
      message: err?.message || String(err),
      // remove details in prod if you prefer
      details: err?.details || undefined,
    });
  }
};
