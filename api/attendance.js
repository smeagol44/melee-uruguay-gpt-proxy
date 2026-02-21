module.exports = async function handler(req, res) {

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { eventSlug, playerTag } = req.body

  const query = `
    query CheckAttendance($slug: String!) {
      event(slug: $slug) {
        entrants(query: { perPage: 500 }) {
          nodes {
            participants {
              gamerTag
            }
            placement
          }
        }
      }
    }
  `

  const response = await fetch('https://api.start.gg/gql/alpha', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + process.env.STARTGG_API_KEY
    },
    body: JSON.stringify({
      query,
      variables: { slug: eventSlug }
    })
  })

  const data = await response.json()

  const entrants = data?.data?.event?.entrants?.nodes || []

const found = entrants.find(e =>
  e.name.toLowerCase() === playerTag.toLowerCase()
)

  res.status(200).json({
    attended: !!found,
    placement: found?.placement || null
  })
}
