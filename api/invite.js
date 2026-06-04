import { Redis } from '@upstash/redis';
const redis = Redis.fromEnv();

const RESERVED_NETWORK_NAMES = [
  'Magiamo', 'Hospiamo', 'Trustiamo', 'Hi3',
  'Anchor', 'Admin', 'Concierge',
  'Somebody', 'Member', 'Traveler', 'Stranger', 'System',
];

function isReservedName(name) {
  const lower = name.toLowerCase();
  return RESERVED_NETWORK_NAMES.some(r => r.toLowerCase() === lower);
}

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
    if (isReservedName(name)) {
      return res.status(200).json({ available: false });
    }
    return res.status(200).json({ available: true });
  }

  // Accept an invite — invite-code-authorized. The email is collected
  // HERE, under the invite-code gate, and written onto the member record.
  // This is what lets the new somebody sign in (magic verify finds the
  // trsId by email). It permanently replaces the retired network-name-only
  // profile claim: an email can only be attached by presenting a valid
  // invite code. A per-inviter cap on direct invitees is enforced here too.
  if (req.method === 'POST' && req.query.action === 'accept') {
    const { code, networkName, email } = req.body;

    // Invite-code gate — required, must resolve to a real invite.
    if (!code) return res.status(400).json({ error: 'Invite code required' });
    const inviteRaw = await redis.get(`invite:${code}`);
    if (!inviteRaw) return res.status(404).json({ error: 'Invite not found' });
    const invite = typeof inviteRaw === 'string' ? JSON.parse(inviteRaw) : inviteRaw;

    // Network name — letters only, 4-15 characters.
    if (!networkName) return res.status(400).json({ error: 'Network name required' });
    const clean = networkName.replace(/[^a-zA-Z\s]/g, '').trim();
    if (clean.length < 4 || clean.length > 15) {
      return res.status(400).json({ error: 'Network name must be 4 to 15 letters' });
    }
    if (isReservedName(clean)) {
      return res.status(400).json({ error: 'Name taken' });
    }

    // Email — required, basic shape check, normalized to lowercase.
    if (!email) return res.status(400).json({ error: 'Email required' });
    const cleanEmail = String(email).toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: 'Enter a valid email' });
    }

    // One pass over members: reject a duplicate network name, reject an
    // email already in the network (one identity per email — email is the
    // sign-in key), and tally the inviter's direct invitees plus capture
    // the inviter's own record (for the cap).
    const allKeys = await redis.keys('member:*');
    let directCount = 0;
    let inviterRecord = null;
    for (const key of allKeys) {
      const raw = await redis.get(key);
      const member = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (member.networkName
          && member.networkName.toLowerCase() === clean.toLowerCase()
          && member.email) {
        return res.status(400).json({ error: 'Name taken' });
      }
      if (member.email && member.email.toLowerCase() === cleanEmail) {
        return res.status(409).json({ error: 'That email is already in the network' });
      }
      if (member.invitedBy === invite.inviterCode) directCount++;
      if (member.trsId === invite.inviterCode) inviterRecord = member;
    }

    // Per-inviter cap on direct invitees. Default 10; the trunk
    // (invitedBy null) gets 100; an explicit numeric inviteLimit on the
    // inviter's record overrides both (no record has this field today —
    // it is a future lever, not a migration).
    const DEFAULT_INVITE_LIMIT = 10;
    const TRUNK_INVITE_LIMIT = 100;
    let inviteLimit = DEFAULT_INVITE_LIMIT;
    if (inviterRecord) {
      if (typeof inviterRecord.inviteLimit === 'number') {
        inviteLimit = inviterRecord.inviteLimit;
      } else if (inviterRecord.invitedBy == null) {
        inviteLimit = TRUNK_INVITE_LIMIT;
      }
    }
    if (directCount >= inviteLimit) {
      return res.status(403).json({ error: 'Invite limit reached' });
    }

    // Mint a collision-safe TRS ID. trs:counter is monotonic; the +4
    // offset is historical. Guard so we can never write over an existing
    // record (e.g. if the counter were ever restored to an earlier value).
    let trsId;
    for (let i = 0; i < 5; i++) {
      const counter = await redis.incr('trs:counter');
      const candidate = `TRS-${String(counter + 4).padStart(6, '0')}`;
      const exists = await redis.get(`member:${candidate}`);
      if (!exists) { trsId = candidate; break; }
    }
    if (!trsId) return res.status(500).json({ error: 'Could not allocate an ID' });

    const personalCode = Math.random().toString(36).substring(2, 9);

    const memberRecord = {
      networkName: clean,
      trsId,
      personalCode,
      email: cleanEmail,
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
