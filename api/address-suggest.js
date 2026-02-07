// /api/address-suggest.js
// Proxies OpenStreetMap Nominatim autocomplete to avoid browser-side CORS/rate-limit quirks.
// Returns an array of suggestion hits (Nominatim search results).
export default async function handler(req, res) {
  try {
    const q = String((req.query && req.query.q) || '').trim();
    if (q.length < 3) return res.status(200).json([]);

    const qs = new URLSearchParams({
      q,
      format: 'json',
      limit: '5',
      addressdetails: '1',
      countrycodes: 'us'
    });

    const url = 'https://nominatim.openstreetmap.org/search?' + qs.toString();

    const resp = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        // Nominatim usage policy asks for identifying UA. Browser can't set it; server can.
        'User-Agent': 'ProCanIntake/1.0 (support@procansanitation.com)'
      }
    });

    if (!resp.ok) {
      return res.status(resp.status).json([]);
    }

    const data = await resp.json().catch(() => []);
    return res.status(200).json(Array.isArray(data) ? data : []);
  } catch (e) {
    return res.status(200).json([]);
  }
}
