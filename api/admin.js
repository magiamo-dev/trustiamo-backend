import { Redis } from '@upstash/redis';
const redis = Redis.fromEnv();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const secret = (req.query.secret || req.headers['x-admin-secret'] || '').trim();
 if (secret !== (process.env.ADMIN_SECRET || '').trim()) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method === 'GET' && req.query.action === 'list') {
    const keys = await redis.keys('member:*');
    const members = [];
    for (const key of keys) {
      const raw = await redis.get(key);
      const member = typeof raw === 'string' ? JSON.parse(raw) : raw;
      members.push(member);
    }
    members.sort((a, b) => new Date(a.joinedAt) - new Date(b.joinedAt));
    return res.status(200).json({ count: members.length, members });
  }

  if (req.method === 'POST' && req.query.action === 'update') {
    const { trsId, networkName } = req.body;
    if (!trsId || !networkName) {
      return res.status(400).json({ error: 'TRS ID and network name required' });
    }
    const clean = networkName.replace(/[^a-zA-Z\s]/g, '').trim();
    if (clean.length < 4 || clean.length > 15) {
      return res.status(400).json({ error: 'Network name must be 4 to 15 letters' });
    }
    const raw = await redis.get(`member:${trsId}`);
    if (!raw) return res.status(404).json({ error: 'Member not found' });
    const member = typeof raw === 'string' ? JSON.parse(raw) : raw;
    member.networkName = clean;
    await redis.set(`member:${trsId}`, JSON.stringify(member));
    return res.status(200).json({ updated: trsId, networkName: clean });
  }
if (req.query.action === 'seed') {
    const founder = {
      networkName: 'Naked Sequoia',
      trsId: 'TRS-000001',
      personalCode: 'w7i2yb2',
      invitedBy: null,
      joinedAt: '2026-05-10T00:00:00.000Z',
    };
    await redis.set('member:TRS-000001', JSON.stringify(founder));
    return res.status(200).json({ seeded: 'TRS-000001', networkName: 'Naked Sequoia' });
  }
  if (req.method === 'POST' && req.query.action === 'delete') {
    const { trsId } = req.body;
    if (!trsId) return res.status(400).json({ error: 'TRS ID required' });
    await redis.del(`member:${trsId}`);
    return res.status(200).json({ deleted: trsId });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
