import { Redis } from '@upstash/redis';
const redis = Redis.fromEnv();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const secret = req.query.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method === 'GET') {
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

  if (req.method === 'DELETE') {
    const { trsId } = req.query;
    if (!trsId) return res.status(400).json({ error: 'TRS ID required' });
    await redis.del(`member:${trsId}`);
    return res.status(200).json({ deleted: trsId });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
