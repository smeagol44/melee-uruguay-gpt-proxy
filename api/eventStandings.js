const STARTGG_ENDPOINT = "https://api.start.gg/gql/alpha";

module.exports = async function handler(req, res) {
  const STARTGG_TOKEN = process.env.STARTGG_API_KEY;
  const { eventSlug, top = 8, debug } = req.query;

  if (!eventSlug) return res.status(400).json({ error: "Missing eventSlug" });

  const query = `
    query EventStandings($slug: String!, $page: Int!, $perPage: Int!) {
      event(slug: $slug) {
        standings(query: { page: $page, perPage: $perPage }) {
          pageInfo { totalPages }
          nodes {
            placement
            entrant { participants { gamerTag } }
          }
        }
      }
    }
  `;

  async function callStartGG(page, perPage) {
    const resp = await fetch(STARTGG_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${STARTGG_TOKEN || ""}`,
      },
      body: JSON.stringify({
        query,
        variables: { slug: eventSlug, page, perPage },
      }),
    });

    const text = await resp.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // leave json null
    }

    return { status: resp.status, ok: resp.ok, text, json };
  }

  try {
    const perPage = 128;
    let page = 1;
    let totalPages = 1;
    const collected = [];

    while (page <= totalPages && collected.length < Number(top)) {
      const r = await callStartGG(page, perPage);

      // DEBUG MODE: return what Start.gg is actually sending (safe, no token leaked)
      if (debug === "1") {
        return res.status(200).json({
          debug: true,
          tokenPresent: !!STARTGG_TOKEN,
          startggHttpStatus: r.status,
          startggOk: r.ok,
          hasJson: !!r.json,
          startggErrors: r.json?.errors || null,
          dataEventIsNull: r.json?.data?.event === null,
          sample: r.json ? r.json : r.text.slice(0, 1000),
        });
      }

      if (!r.ok) {
        return res.status(502).json({
          error: "Start.gg request failed",
          startggHttpStatus: r.status,
        });
      }

      if (r.json?.errors) {
        return res.status(502).json({
          error: "Start.gg returned errors",
          details: r.json.errors,
        });
      }

      const standings = r.json?.data?.event?.standings;
      if (!standings) {
        // Event exists but standings not returned (token/permissions or schema mismatch)
        return res.status(502).json({
          error: "Start.gg did not return standings for this event",
        });
      }

      totalPages = standings.pageInfo?.totalPages ?? 1;

      for (const node of standings.nodes || []) {
        const gamerTag = node?.entrant?.participants?.[0]?.gamerTag;
        if (!gamerTag) continue;
        collected.push({ placement: node.placement, gamerTag });
        if (collected.length >= Number(top)) break;
      }

      page++;
    }

    return res.status(200).json({
      eventSlug,
      top: Number(top),
      standings: collected.slice(0, Number(top)),
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch standings", details: err.message });
  }
};
