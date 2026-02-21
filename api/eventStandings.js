const fetch = require("node-fetch");

const STARTGG_ENDPOINT = "https://api.start.gg/gql/alpha";
const STARTGG_TOKEN = process.env.STARTGG_API_TOKEN;

async function fetchStandingsPage(eventSlug, page, perPage) {
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

  const res = await fetch(STARTGG_ENDPOINT, {
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

  const json = await res.json();
  return json.data?.event?.standings || null;
}

module.exports = async function handler(req, res) {
  const { eventSlug, top = 8 } = req.query;

  if (!eventSlug) {
    return res.status(400).json({ error: "Missing eventSlug" });
  }

  const perPage = 128;
  let page = 1;
  let totalPages = 1;
  let collected = [];

  try {
    while (page <= totalPages && collected.length < top) {
      const standings = await fetchStandingsPage(eventSlug, page, perPage);
      if (!standings) break;

      totalPages = standings.pageInfo.totalPages;

      for (const node of standings.nodes) {
        const gamerTag = node.entrant?.participants?.[0]?.gamerTag;
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
      top,
      standings: collected.slice(0, top),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
