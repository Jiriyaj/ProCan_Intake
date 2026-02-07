// /api/address-geocode.js
// Returns a "best" geocode result for a full address string.
// This proxies Nominatim so we can send a proper User-Agent and avoid client-side issues.
export default async function handler(req, res) {
  try {
    const q = String((req.query && req.query.q) || '').trim();
    if (q.length < 3) return res.status(200).json(null);

    const qs = new URLSearchParams({
      q,
      format: 'json',
      limit: '1',
      addressdetails: '1',
      countrycodes: 'us'
    });

    const url = 'https://nominatim.openstreetmap.org/search?' + qs.toString();

    const resp = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'ProCanIntake/1.0 (support@procansanitation.com)'
      }
    });

    if (!resp.ok) {
      return res.status(resp.status).json(null);
    }

    const data = await resp.json().catch(() => []);
    const best = Array.isArray(data) && data.length ? data[0] : null;
    return res.status(200).json(best);
  } catch (e) {
    return res.status(200).json(null);
  }
}
