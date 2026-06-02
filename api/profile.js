import { Redis } from '@upstash/redis';
const redis = Redis.fromEnv();

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(part => {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  });
  return out;
}

// Read the signed-in identity from the ts_session cookie.
// Mirrors api/magic.js action=check, including the backward-compat
// tier fallback for sessions written before Phase 3.5.
async function getSession(req) {
  const cookies = parseCookies(req);
  const token = cookies.ts_session;
  if (!token) return null;
  const raw = await redis.get(`session:${token}`);
  if (!raw) return null;
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const tier = data.tier
    || (data.trsId ? 'somebody' : (data.mbrId ? 'member' : 'traveler'));
  return {
    trsId: data.trsId || null,
    mbrId: data.mbrId || null,
    tier,
    email: data.email || null,
  };
}

export default async function handler(req, res) {
  const ALLOWED_ORIGINS = [
    'https://me.trustiamo.com',
    'https://trustiamo.com',
    'https://forest.trustiamo.com',
    'https://invite.trustiamo.com',
  ];
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = await getSession(req);

  // Get profile by TRS ID — full record, signed-in owner only
  if (req.method === 'GET' && req.query.action === 'get') {
    const { trsId } = req.query;
    if (!trsId) return res.status(400).json({ error: 'TRS ID required' });
    if (!session) return res.status(401).json({ error: 'Not signed in' });
    if (session.trsId !== trsId) return res.status(403).json({ error: 'Forbidden' });

    const raw = await redis.get(`member:${trsId}`);
    if (!raw) return res.status(404).json({ error: 'Profile not found' });

    const member = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return res.status(200).json(member);
  }

  // Find TRS ID by phone number — unchanged (phone path; Twilio disabled)
  if (req.method === 'POST' && req.query.action === 'lookup') {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });

    const clean = phone.replace(/\D/g, '');
    const keys = await redis.keys('member:*');

    for (const key of keys) {
      const raw = await redis.get(key);
      const member = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (member.phone && member.phone.replace(/\D/g, '') === clean) {
        return res.status(200).json({ found: true, trsId: member.trsId });
      }
    }

    return res.status(200).json({ found: false });
  }

  // Claim profile — unchanged this pass (onboarding email-attach;
  // deferred to a follow-up that needs the invite frontend)
  if (req.method === 'POST' && req.query.action === 'claim') {
    const { email, networkName } = req.body;
    if (!email || !networkName) {
      return res.status(400).json({ error: 'Email and network name required' });
    }

    const clean = email.toLowerCase().trim();
    const keys = await redis.keys('member:*');

    for (const key of keys) {
      const raw = await redis.get(key);
      const member = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (member.networkName.toLowerCase() === networkName.toLowerCase()) {
        if (member.email && member.email.toLowerCase() !== clean) {
          return res.status(400).json({ error: 'This profile has already been claimed' });
        }
        member.email = clean;
        await redis.set(key, JSON.stringify(member));
        return res.status(200).json({ claimed: true, trsId: member.trsId });
      }
    }

    return res.status(404).json({ error: 'Network name does not match our records' });
  }

  // Update profile — signed-in owner only
  if (req.method === 'POST' && req.query.action === 'update') {
    const { trsId, specialty, city, vouch, pulse, connectionOpen } = req.body;
    if (!trsId) return res.status(400).json({ error: 'TRS ID required' });
    if (!session) return res.status(401).json({ error: 'Not signed in' });
    if (session.trsId !== trsId) return res.status(403).json({ error: 'Forbidden' });

    const raw = await redis.get(`member:${trsId}`);
    if (!raw) return res.status(404).json({ error: 'Profile not found' });

    const member = typeof raw === 'string' ? JSON.parse(raw) : raw;

    if (specialty !== undefined) member.specialty = specialty;
    if (city !== undefined) member.city = city;
    if (vouch !== undefined) member.vouch = vouch;
    if (pulse !== undefined) member.pulse = pulse;
    if (connectionOpen !== undefined) member.connectionOpen = connectionOpen;

    await redis.set(`member:${trsId}`, JSON.stringify(member));
    return res.status(200).json({ updated: true, member });
  }

  // Clear pulse — signed-in owner only
  if (req.method === 'POST' && req.query.action === 'clearpulse') {
    const { trsId } = req.body;
    if (!trsId) return res.status(400).json({ error: 'TRS ID required' });
    if (!session) return res.status(401).json({ error: 'Not signed in' });
    if (session.trsId !== trsId) return res.status(403).json({ error: 'Forbidden' });

    const raw = await redis.get(`member:${trsId}`);
    if (!raw) return res.status(404).json({ error: 'Profile not found' });

    const member = typeof raw === 'string' ? JSON.parse(raw) : raw;
    member.pulse = '';
    await redis.set(`member:${trsId}`, JSON.stringify(member));
    return res.status(200).json({ cleared: true });
  }

  // Count invites for a TRS ID — unchanged (intentionally public)
  if (req.method === 'GET' && req.query.action === 'invitecount') {
    const { trsId } = req.query;
    if (!trsId) return res.status(400).json({ error: 'TRS ID required' });

    const keys = await redis.keys('member:*');
    let count = 0;
    for (const key of keys) {
      const raw = await redis.get(key);
      const member = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (member.invitedBy === trsId) count++;
    }
    return res.status(200).json({ count });
  }

  // Check if network name is available — unchanged this pass
  if (req.method === 'GET' && req.query.action === 'checkname') {
    const { name } = req.query;
    if (!name) return res.status(400).json({ error: 'Name required' });

    const keys = await redis.keys('member:*');
    for (const key of keys) {
      const raw = await redis.get(key);
      const member = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (member.networkName.toLowerCase() === name.toLowerCase() && member.email) {
        return res.status(200).json({ available: false });
      }
    }
    return res.status(200).json({ available: true });
  }

  // List members — for forest visualization (tier-aware)
  // Somebody session: trsId, networkName, invitedBy.
  // Everyone else (no session / member / traveler): structure only —
  // trsId, invitedBy. No names, no pulses, no personalCode, ever.
  if (req.method === 'GET' && req.query.action === 'list') {
    const isSomebody = !!(session && session.tier === 'somebody');
    const keys = await redis.keys('member:*');
    const members = [];
    for (const key of keys) {
      const raw = await redis.get(key);
      const member = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (isSomebody) {
        members.push({
          trsId: member.trsId,
          networkName: member.networkName,
          invitedBy: member.invitedBy || null,
        });
      } else {
        members.push({
          trsId: member.trsId,
          invitedBy: member.invitedBy || null,
        });
      }
    }
    return res.status(200).json({ members });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
