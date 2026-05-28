import Stripe from 'stripe';

function setOriginHeaders(req, res) {
  const origin = req.headers.origin || '';
  const allowed = [
    'https://trustiamo.com',
    'https://www.trustiamo.com',
  ];
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setOriginHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'session_id required' });

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY_TEST);
    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status !== 'paid') {
      return res.status(200).json({
        ok: false,
        reason: 'payment_not_complete',
        payment_status: session.payment_status,
      });
    }

    const email = session.customer_details && session.customer_details.email;
    if (!email) {
      return res.status(200).json({ ok: false, reason: 'no_email_on_session' });
    }

    // Fire magic-link send by calling the existing /api/magic?action=send endpoint.
    const sendRes = await fetch('https://project-vygjz.vercel.app/api/magic?action=send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        returnUrl: 'https://me.trustiamo.com',
      }),
    });

    if (!sendRes.ok) {
      const errText = await sendRes.text();
      console.error('magic send failed:', sendRes.status, errText);
      return res.status(200).json({ ok: false, reason: 'magic_send_failed', email });
    }

    return res.status(200).json({ ok: true, email });
  } catch (err) {
    console.error('join-success error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
