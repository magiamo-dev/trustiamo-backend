import { Redis } from '@upstash/redis';
const redis = Redis.fromEnv();

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

    const keys = await redis.keys('member:*');
    for (const key of keys) {
      const mraw = await redis.get(key);
      const member = typeof mraw === 'string' ? JSON.parse(mraw) : mraw;
      if (member.email && member.email.toLowerCase() === data.email.toLowerCase()) {
        return res.status(200).json({ verified: true, trsId: member.trsId });
      }
    }

    return res.status(200).json({ verified: true, trsId: null, email: data.email });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
