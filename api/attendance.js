// api/attendance.js
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { eventSlug, playerTag } = req.body;
  if (!eventSlug || !playerTag) {
    return res.status(400).json({ error: "Missing eventSlug or playerTag" });
  }

  const tagLower = String(playerTag).trim().toLowerCase();

  const query = `
    query CheckAttendance($slug: String!, $entrantsPage: Int!, $standingsPage: Int!, $perPage: Int!) {
      event(slug: $slug) {
        entrants(query: { page: $entrantsPage, perPage: $perPage }) {
          pageInfo { totalPages }
          nodes {
            id
            participants { gamerTag }
          }
        }
        standings(query: { page: $standingsPage, perPage: $perPage }) {
          pageInfo { totalPages }
          nodes {
            placement
            entrant {
              id
              participants { gamerTag }
            }
          }
        }
      }
    }
  `;

  const fetchPage = async (entrantsPage, standingsPage) => {
    const response = await fetch("https://api.start.gg/gql/alpha", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + process.env.STARTGG_API_KEY,
      },
      body: JSON.stringify({
        query,
        variables: { slug: eventSlug, entrantsPage, standingsPage, perPage: 200 },
      }),
    });

    const data = await response.json();
    return data?.data?.event || null;
  };

  try {
    // 1) Find entrant by gamerTag (entrants)
    let entrantId = null;
    let entrantsPage = 1;
    let entrantsTotalPages = 1;

    while (entrantsPage <= entrantsTotalPages && entrantsPage <= 10 && !entrantId) {
      const event = await fetchPage(entrantsPage, 1);
      const entrants = event?.entrants?.nodes || [];
      entrantsTotalPages = event?.entrants?.pageInfo?.totalPages || 1;

      const foundEntrant = entrants.find((e) =>
        (e?.participants || []).some((p) => String(p?.gamerTag || "").toLowerCase() === tagLower)
      );

      if (foundEntrant?.id) entrantId = foundEntrant.id;
      entrantsPage++;
    }

    const attended = !!entrantId;

    // 2) Find placement by entrantId in standings (if present)
    let placement = null;

    if (attended) {
      let standingsPage = 1;
      let standingsTotalPages = 1;

      while (standingsPage <= standingsTotalPages && standingsPage <= 10 && placement == null) {
        const event = await fetchPage(1, standingsPage);
        const nodes = event?.standings?.nodes || [];
        standingsTotalPages = event?.standings?.pageInfo?.totalPages || 1;

        const foundStanding = nodes.find((s) => String(s?.entrant?.id || "") === String(entrantId));
        if (foundStanding && typeof foundStanding.placement === "number") {
          placement = foundStanding.placement;
          break;
        }
        standingsPage++;
      }
    }

    return res.status(200).json({ attended, placement });
  } catch (err) {
    return res.status(500).json({
      error: "attendance failed",
      message: err?.message || String(err),
    });
  }
};
