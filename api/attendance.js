export default async function handler(request) {

  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405 }
    )
  }

  const { eventSlug, playerTag } = await request.json()

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
    e.participants.some(p =>
      p.gamerTag.toLowerCase() === playerTag.toLowerCase()
    )
  )

  return new Response(
    JSON.stringify({
      attended: !!found,
      placement: found?.placement || null
    }),
    { status: 200 }
  )
}
