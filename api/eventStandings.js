const STARTGG_ENDPOINT = "https://api.start.gg/gql/alpha";

module.exports = async function handler(req, res) {
  const STARTGG_TOKEN = process.env.STARTGG_API_TOKEN;
  const { eventSlug, top = 8 } = req.query;

  if (!eventSlug) {
    return res.status(400).json({ error: "Missing eventSlug" });
  }

  async function fetchStandingsPage(page, perPage) {
    const query = `
      query EventStandings($slug: String!, $page: Int!, $perPage: Int!) {
        event(slug: $slug) {
          standings(query: {page: $page, perPage: $perPage}) {
            pageInfo {
              totalPages
            }
            nodes {
              placement
              entrant {
                participants {
                  gamerTag
                }
              }
            }
          }
        }
      }
    `;

    const response = await fetch(STARTGG_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${STARTGG_TOKEN}`,
      },
      body: JSON.stringify({
        query,
        variables: {
          slug: eventSlug,
          page,
          perPage,
        },
      }),
    });

    const json = await response.json();

    if (!json.data || !json.data.event) {
      throw new Error("Invalid Start.gg response");
    }

    return json.data.event.standings;
  }

  try {
    const perPage = 128;
    let page = 1;
    let totalPages = 1;
    let collected = [];

    while (page <= totalPages && collected.length < top) {
      const standings = await fetchStandingsPage(page, perPage);
      totalPages = standings.pageInfo.totalPages;

      for (const node of standings.nodes) {
        const gamerTag = node?.entrant?.participants?.[0]?.gamerTag;
        if (!gamerTag) continue;

        collected.push({
          placement: node.placement,
          gamerTag,
        });

        if (collected.length >= top) break;
      }

      page++;
    }

    return res.status(200).json({
      eventSlug,
      top: Number(top),
      standings: collected.slice(0, top),
    });

  } catch (err) {
    console.error("eventStandings error:", err);
    return res.status(500).json({
      console.log("TOKEN EXISTS:", !!STARTGG_TOKEN);
      error: "Failed to fetch standings",
      details: err.message,
    });
  }
};
