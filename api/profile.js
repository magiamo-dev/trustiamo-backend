import { Redis } from '@upstash/redis';
const redis = Redis.fromEnv();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Get profile by TRS ID (after phone verification)
  if (req.method === 'GET' && req.query.action === 'get') {
    const { trsId } = req.query;
    if (!trsId) return res.status(400).json({ error: 'TRS ID required' });

    const raw = await redis.get(`member:${trsId}`);
    if (!raw) return res.status(404).json({ error: 'Profile not found' });

    const member = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return res.status(200).json(member);
  }

  // Find TRS ID by phone number
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

  // Claim profile — connect email to existing record by network name
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

  // Update profile
  if (req.method === 'POST' && req.query.action === 'update') {
    const { trsId, specialty, city, vouch, pulse, connectionOpen } = req.body;
    if (!trsId) return res.status(400).json({ error: 'TRS ID required' });

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

  // Clear pulse
  if (req.method === 'POST' && req.query.action === 'clearpulse') {
    const { trsId } = req.body;
    if (!trsId) return res.status(400).json({ error: 'TRS ID required' });

    const raw = await redis.get(`member:${trsId}`);
    if (!raw) return res.status(404).json({ error: 'Profile not found' });

    const member = typeof raw === 'string' ? JSON.parse(raw) : raw;
    member.pulse = '';
    await redis.set(`member:${trsId}`, JSON.stringify(member));
    return res.status(200).json({ cleared: true });
  }

  // Count invites for a TRS ID — public, no auth needed
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
// Check if network name is available
  if (req.method === 'GET' && req.query.action === 'checkname') {
    const { name } = req.query;
    if (!name) return res.status(400).json({ error: 'Name required' });

    const keys = await redis.keys('member:*');
    for (const key of keys) {
      const raw = await redis.get(key);
      const member = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (member.networkName.toLowerCase() === name.toLowerCase()) {
        return res.status(200).json({ available: false });
      }
    }
    return res.status(200).json({ available: true });
  }
  return res.status(405).json({ error: 'Method not allowed' });
}
