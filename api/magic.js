import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const SESSION_DAYS = 30;
const SESSION_SECONDS = SESSION_DAYS * 24 * 60 * 60;

// Stripe statuses that grant member tier on magic-link sign-in.
// Decision A (Phase 3.5): active + trialing only. All other statuses
// (past_due, canceled, incomplete, incomplete_expired, unpaid, paused)
// fall back to traveler tier.
const MEMBER_TIER_STATUSES = new Set(['active', 'trialing']);

async function sendEmail(to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: 'Trustiamo <network@trustiamo.com>',
      to,
      subject,
      html,
    }),
  });
  return res.ok;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(part => {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  });
  return out;
}

function setOriginHeaders(req, res) {
  const origin = req.headers.origin || '';
  const allowed = [
    'https://me.trustiamo.com',
    'https://forest.trustiamo.com',
    'https://invite.trustiamo.com',
    'https://trustiamo.com',
    'https://www.trustiamo.com',
  ];
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Look up trsId by scanning member:* records for matching email.
// O(n) scan — matches existing behavior. Optimization parked for later.
async function findTrsIdByEmail(email) {
  const keys = await redis.keys('member:*');
  for (const key of keys) {
    const raw = await redis.get(key);
    const member = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (member.email && member.email.toLowerCase() === email.toLowerCase()) {
      return member.trsId;
    }
  }
  return null;
}

// Look up mbrId and status by direct key lookup on subscriber:{email}.
// O(1).
async function findSubscriberByEmail(email) {
  const raw = await redis.get(`subscriber:${email}`);
  if (!raw) return null;
  const sub = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return { mbrId: sub.mbrId, status: sub.status };
}

// Compute tier from identity pieces.
// Decision 3 (Phase 3.5): tier reflects deepest entitlement.
// somebody (trsId present) > member (active/trialing subscriber) > traveler.
function computeTier(trsId, subscriber) {
  if (trsId) return 'somebody';
  if (subscriber && MEMBER_TIER_STATUSES.has(subscriber.status)) return 'member';
  return 'traveler';
}

export default async function handler(req, res) {
  setOriginHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  res.setHeader('Cache-Control', 'no-store');

  // Send magic link
  if (req.method === 'POST' && req.query.action === 'send') {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const clean = email.toLowerCase().trim();
    const token = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
    const expires = Date.now() + 15 * 60 * 1000;
    await redis.set(`magic:${token}`, JSON.stringify({ email: clean, expires }), { ex: 900 });
    const returnUrl = req.body.returnUrl || 'https://me.trustiamo.com';
    const magicUrl = `${returnUrl}?token=${token}`;
    const html = `
      <div style="background:#060504;padding:48px 24px;font-family:Georgia,serif;text-align:center;max-width:480px;margin:0 auto;">
        <p style="font-family:serif;font-size:11px;letter-spacing:5px;color:#8a6a3a;text-transform:uppercase;margin-bottom:32px;">Trustiamo · My Profile</p>
        <p style="font-size:24px;font-weight:300;color:#f0ede6;margin-bottom:16px;">Your link is ready.</p>
        <p style="font-size:16px;color:#6a6058;line-height:1.7;margin-bottom:32px;">Click below to access your profile in the network. This link expires in 15 minutes.</p>
        <a href="${magicUrl}" style="display:inline-block;padding:16px 32px;border:1px solid #8a6a3a;color:#c9a96e;text-decoration:none;font-family:serif;font-size:11px;letter-spacing:4px;text-transform:uppercase;">Enter the forest</a>
        <p style="font-size:12px;color:#3a3530;margin-top:32px;line-height:1.6;">If you did not request this, ignore this email.<br>Need help? network@trustiamo.com</p>
        <p style="font-size:10px;color:#3a3530;margin-top:24px;letter-spacing:3px;">Trustiamo · For the Love of Hospitality®</p>
      </div>
    `;
    const sent = await sendEmail(clean, 'Your Trustiamo profile link', html);
    if (!sent) return res.status(500).json({ error: 'Failed to send email' });
    return res.status(200).json({ sent: true });
  }

  // Verify magic token
  if (req.method === 'GET' && req.query.action === 'verify') {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token required' });
    const raw = await redis.get(`magic:${token}`);
    if (!raw) return res.status(400).json({ error: 'Invalid or expired link' });
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Date.now() > data.expires) {
      await redis.del(`magic:${token}`);
      return res.status(400).json({ error: 'Link expired' });
    }
    await redis.del(`magic:${token}`);

    const email = data.email.toLowerCase();

    // Dual lookup: scan member:* for trsId, direct lookup for subscriber:{email}.
    const [trsId, subscriber] = await Promise.all([
      findTrsIdByEmail(email),
      findSubscriberByEmail(email),
    ]);

    const mbrId = subscriber ? subscriber.mbrId : null;
    const tier = computeTier(trsId, subscriber);

    // Session issuance rule:
    // - Issue a session if the user has any identity (trsId OR mbrId).
    // - If neither, return verified:true with no cookie (Decision B: unchanged).
    if (tier !== 'traveler') {
      const session = Math.random().toString(36).substring(2)
        + Math.random().toString(36).substring(2)
        + Math.random().toString(36).substring(2);
      const sessionData = {
        trsId: trsId || null,
        mbrId: mbrId || null,
        email,
        tier,
        created: Date.now(),
      };
      await redis.set(`session:${session}`, JSON.stringify(sessionData), { ex: SESSION_SECONDS });
      const cookie = `ts_session=${session}; Domain=.trustiamo.com; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
      res.setHeader('Set-Cookie', cookie);
      return res.status(200).json({ verified: true, trsId, mbrId, tier, email });
    }

    // No identity match — unchanged behavior from previous version.
    return res.status(200).json({ verified: true, trsId: null, mbrId: null, tier: 'traveler', email });
  }

  // Check current session
  if (req.method === 'GET' && req.query.action === 'check') {
    const cookies = parseCookies(req);
    const session = cookies.ts_session;
    if (!session) return res.status(200).json({ signedIn: false });
    const raw = await redis.get(`session:${session}`);
    if (!raw) return res.status(200).json({ signedIn: false });
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    // Backward compat: old sessions written before Phase 3.5 lack `tier`.
    // Recompute it from trsId/mbrId presence so a pre-existing signed-in
    // somebody is correctly tagged tier=somebody without forcing re-signin.
    const tier = data.tier
      || (data.trsId ? 'somebody' : (data.mbrId ? 'member' : 'traveler'));
    return res.status(200).json({
      signedIn: true,
      trsId: data.trsId || null,
      mbrId: data.mbrId || null,
      tier,
      email: data.email || null,
    });
  }

  // Sign out — clear session
  if (req.method === 'POST' && req.query.action === 'signout') {
    const cookies = parseCookies(req);
    const session = cookies.ts_session;
    if (session) await redis.del(`session:${session}`);
    const cookie = `ts_session=; Domain=.trustiamo.com; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
    res.setHeader('Set-Cookie', cookie);
    return res.status(200).json({ signedOut: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
