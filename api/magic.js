import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const SESSION_DAYS = 30;
const SESSION_SECONDS = SESSION_DAYS * 24 * 60 * 60;

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

export default async function handler(req, res) {
  setOriginHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

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

    let trsId = null;
    const keys = await redis.keys('member:*');
    for (const key of keys) {
      const mraw = await redis.get(key);
      const member = typeof mraw === 'string' ? JSON.parse(mraw) : mraw;
      if (member.email && member.email.toLowerCase() === data.email.toLowerCase()) {
        trsId = member.trsId;
        break;
      }
    }

    // Issue a shared session for .trustiamo.com when a member match is found
    if (trsId) {
      const session = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
      await redis.set(`session:${session}`, JSON.stringify({ trsId, email: data.email, created: Date.now() }), { ex: SESSION_SECONDS });
      const cookie = `ts_session=${session}; Domain=.trustiamo.com; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
      res.setHeader('Set-Cookie', cookie);
      return res.status(200).json({ verified: true, trsId });
    }

    return res.status(200).json({ verified: true, trsId: null, email: data.email });
  }

  // Check current session
  if (req.method === 'GET' && req.query.action === 'check') {
    const cookies = parseCookies(req);
    const session = cookies.ts_session;
    if (!session) return res.status(200).json({ signedIn: false });
    const raw = await redis.get(`session:${session}`);
    if (!raw) return res.status(200).json({ signedIn: false });
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return res.status(200).json({ signedIn: true, trsId: data.trsId });
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
