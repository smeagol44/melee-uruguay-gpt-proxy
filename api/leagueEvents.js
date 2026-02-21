const fs = require("fs");
const path = require("path");

// Start.gg videogame ID for Super Smash Bros. Melee is 1 in start.gg's backend.
// Source/example lists Melee -> 1. https://github.com/HDR-Development/StartGGActionsHDR
const MELEE_VIDEOGAME_ID = 1;

function pickMeleeEvent(events) {
  // Prefer Singles-like events, avoid Doubles/Teams.
  const score = (e) => {
    const name = (e.name || "").toLowerCase();
    const slug = (e.slug || "").toLowerCase();
    let s = 0;
    if (name.includes("singles") || slug.includes("singles")) s += 5;
    if (name.includes("melee") || slug.includes("melee")) s += 2;
    if (name.includes("doubles") || slug.includes("doubles") || name.includes("teams") || slug.includes("teams")) s -= 5;
    return s;
  };

  const melee = (events || []).filter((e) => {
    const vg = e.videogame;
    const id = vg && vg.id != null ? Number(vg.id) : null;
    return id === MELEE_VIDEOGAME_ID;
  });

  if (!melee.length) return null;
  melee.sort((a, b) => score(b) - score(a));
  return melee[0];
}

async function gql(query, variables) {
  const resp = await fetch("https://api.start.gg/gql/alpha", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + process.env.STARTGG_API_KEY,
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await resp.json();
  return data;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const year = req.query.year ? String(req.query.year) : String(new Date().getFullYear());
  const resolve = req.query.resolve == null ? "1" : String(req.query.resolve); // default: resolve=1

  const seasonPath = path.join(process.cwd(), "data", "seasons", `${year}.json`);
  if (!fs.existsSync(seasonPath)) {
    return res.status(404).json({ error: "Season not found", year });
  }

  const season = JSON.parse(fs.readFileSync(seasonPath, "utf-8"));
  const tournaments = season.tournaments || [];

  // If resolve=0, return tournament slugs only.
  if (resolve === "0") {
    return res.status(200).json({
      year: Number(year),
      tournaments: tournaments.map((t) => ({ name: t.name, tournamentSlug: t.tournamentSlug, sourceUrl: t.sourceUrl })),
    });
  }

  if (!process.env.STARTGG_API_KEY) {
    return res.status(500).json({ error: "Missing STARTGG_API_KEY env var" });
  }

  const query = `
    query EventsInTournament($slug: String!) {
      tournament(slug: $slug) {
        id
        name
        slug
        events {
          id
          name
          slug
          videogame { id name }
        }
      }
    }
  `;

  const resolved = [];
  const unresolved = [];

  // Resolve sequentially (safe for rate limits and serverless execution).
  for (const t of tournaments) {
    try {
      // tournamentSlug in our JSON is like "tournament/<slug>". GraphQL tournament(slug) expects "<slug>".
      const tourneySlug = String(t.tournamentSlug || "").replace(/^tournament\//, "");
      if (!tourneySlug) {
        unresolved.push({ ...t, reason: "Missing tournamentSlug" });
        continue;
      }

      const out = await gql(query, { slug: tourneySlug });

      const tourney = out && out.data && out.data.tournament ? out.data.tournament : null;
      const events = tourney ? tourney.events : null;

      const meleeEvent = pickMeleeEvent(events);

      if (!meleeEvent) {
        unresolved.push({ ...t, reason: "No Melee event found in tournament" });
        continue;
      }

      const eventSlugRaw = String(meleeEvent.slug || "");
      const eventSlug =
        eventSlugRaw.startsWith("tournament/")
          ? eventSlugRaw
          : `tournament/${tourneySlug}/event/${eventSlugRaw}`;

      resolved.push({
        name: t.name,
        tournamentSlug: `tournament/${tourneySlug}`,
        sourceUrl: t.sourceUrl,
        eventSlug,
      });
    } catch (err) {
      unresolved.push({ ...t, reason: "Exception resolving tournament events", detail: String(err && err.message ? err.message : err) });
    }
  }

  res.status(200).json({
    year: Number(year),
    count: resolved.length,
    events: resolved,
    unresolved,
    note: "events[] are filtered to Super Smash Bros. Melee (videogame id 1) and prefer Singles-type events when multiple exist.",
  });
};
