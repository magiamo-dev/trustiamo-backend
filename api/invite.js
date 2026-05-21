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
      inviterName: inviterName || 'Adam',
      inviterCode: inviterCode || 'TRS-000001',
      giftWord: giftWord || '',
      inviteeName: inviteeName || '',
      permanent: true,
      createdAt: new Date().toISOString(),
    };
    await redis.set(`invite:${code}`, JSON.stringify(invite));
    return res.status(200).json({ code, url: `https://invite.trustiamo.com/${code}` });
  }

  // Look up an invite code — dynamically pulls current inviter name from member record
  if (req.method === 'GET' && req.query.code) {
    const raw = await redis.get(`invite:${req.query.code}`);
    if (!raw) return res.status(404).json({ error: 'Invite not found' });
    const invite = typeof raw === 'string' ? JSON.parse(raw) : raw;

    // Try to get current name from member record
    if (invite.inviterCode) {
      const memberRaw = await redis.get(`member:${invite.inviterCode}`);
      if (memberRaw) {
        const member = typeof memberRaw === 'string' ? JSON.parse(memberRaw) : memberRaw;
        if (member.networkName) invite.inviterName = member.networkName;
      }
    }

    return res.status(200).json(invite);
  }

  // Check if network name is available
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

  // Accept an invite — no phone verification required temporarily
  if (req.method === 'POST' && req.query.action === 'accept') {
    const { code, networkName } = req.body;

    if (!networkName) return res.status(400).json({ error: 'Network name required' });

    // Validate network name — letters only, 4-15 characters
    const clean = networkName.replace(/[^a-zA-Z\s]/g, '').trim();
    if (clean.length < 4 || clean.length > 15) {
      return res.status(400).json({ error: 'Network name must be 4 to 15 letters' });
    }

    // Check for duplicate name
    const allKeys = await redis.keys('member:*');
    for (const key of allKeys) {
      const raw = await redis.get(key);
      const member = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (member.networkName.toLowerCase() === clean.toLowerCase() && member.email) {
        return res.status(400).json({ error: 'Name taken' });
      }
    }

    const raw = await redis.get(`invite:${code}`);
    if (!raw) return res.status(404).json({ error: 'Invite not found' });
    const invite = typeof raw === 'string' ? JSON.parse(raw) : raw;

    const counter = await redis.incr('trs:counter');
    const trsId = `TRS-${String(counter + 4).padStart(6, '0')}`;
    const personalCode = Math.random().toString(36).substring(2, 9);

    const memberRecord = {
      networkName: clean,
      trsId,
      personalCode,
      invitedBy: invite.inviterCode,
      joinedAt: new Date().toISOString(),
    };

    await redis.set(`member:${trsId}`, JSON.stringify(memberRecord));
    await redis.set(`invite:${personalCode}`, JSON.stringify({
      code: personalCode,
      inviterName: clean,
      inviterCode: trsId,
      giftWord: '',
      inviteeName: '',
      permanent: true,
      createdAt: new Date().toISOString(),
    }));

    if (!invite.permanent) {
      await redis.set(`invite:${code}`, JSON.stringify({ ...invite, used: true, memberId: trsId }));
    }

    return res.status(200).json({
      trsId,
      networkName: clean,
      personalCode,
      personalUrl: `https://invite.trustiamo.com/${personalCode}`,
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
