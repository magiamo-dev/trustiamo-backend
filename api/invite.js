import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Generate a new invite code
  if (req.method === 'POST' && req.query.action === 'create') {
    const { inviterName, inviterCode, giftWord, inviteeName } = req.body;
    const code = Math.random().toString(36).substring(2, 9);
    const invite = {
      code,
      inviterName: inviterName || 'Naked Sequoia',
      inviterCode: inviterCode || 'TRS-000001',
      giftWord: giftWord || '',
      inviteeName: inviteeName || '',
      permanent: true,
      createdAt: new Date().toISOString(),
    };
    await redis.set(`invite:${code}`, JSON.stringify(invite));
    return res.status(200).json({ code, url: `https://invite.trustiamo.com/${code}` });
  }

  // Look up an invite code
  if (req.method === 'GET' && req.query.code) {
    const raw = await redis.get(`invite:${req.query.code}`);
    if (!raw) return res.status(404).json({ error: 'Invite not found' });
    const invite = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return res.status(200).json(invite);
  }

  // Accept an invite
  if (req.method === 'POST' && req.query.action === 'accept') {
    const { code, networkName } = req.body;
    const raw = await redis.get(`invite:${code}`);
    if (!raw) return res.status(404).json({ error: 'Invite not found' });
    const invite = typeof raw === 'string' ? JSON.parse(raw) : raw;

    const counter = await redis.incr('trs:counter');
    const trsId = `TRS-${String(counter + 4).padStart(6, '0')}`;
    const personalCode = Math.random().toString(36).substring(2, 9);

    const member = {
      networkName,
      trsId,
      personalCode,
      invitedBy: invite.inviterCode,
      joinedAt: new Date().toISOString(),
    };

    await redis.set(`member:${trsId}`, JSON.stringify(member));
    await redis.set(`invite:${personalCode}`, JSON.stringify({
      code: personalCode,
      inviterName: networkName,
      inviterCode: trsId,
      giftWord: '',
      inviteeName: '',
      permanent: true,
      createdAt: new Date().toISOString(),
    }));

    // Only mark as used if NOT permanent
    if (!invite.permanent) {
      await redis.set(`invite:${code}`, JSON.stringify({ ...invite, used: true, memberId: trsId }));
    }

    return res.status(200).json({
      trsId,
      networkName,
      personalCode,
      personalUrl: `https://invite.trustiamo.com/${personalCode}`,
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
