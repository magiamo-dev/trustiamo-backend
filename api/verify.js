import twilio from 'twilio';

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const apiKey = process.env.TWILIO_API_KEY;
const apiSecret = process.env.TWILIO_API_SECRET;
const fromNumber = process.env.TWILIO_PHONE_NUMBER;

function getClient() {
  return twilio(apiKey, apiSecret, { accountSid });
}

const codes = {};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST' && req.query.action === 'send') {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number required' });

    const clean = phone.replace(/\D/g, '');
    if (clean.length < 10) return res.status(400).json({ error: 'Invalid phone number' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = Date.now() + 10 * 60 * 1000;
    codes[clean] = { code, expires };

    try {
      const client = getClient();
      await client.messages.create({
        body: `Trustiamo: Your verification code is ${code}. It expires in 10 minutes. Reply STOP to opt out.`,
        from: fromNumber,
        to: `+${clean}`,
      });
      return res.status(200).json({ sent: true });
    } catch (e) {
      console.error('Twilio error:', e.message);
      return res.status(500).json({ error: 'Failed to send code' });
    }
  }

  if (req.method === 'POST' && req.query.action === 'verify') {
    const { phone, code } = req.body;
    if (!phone || !code) return res.status(400).json({ error: 'Phone and code required' });

    const clean = phone.replace(/\D/g, '');
    const record = codes[clean];

    if (!record) return res.status(400).json({ error: 'No code found for this number' });
    if (Date.now() > record.expires) {
      delete codes[clean];
      return res.status(400).json({ error: 'Code expired' });
    }
    if (record.code !== code) return res.status(400).json({ error: 'Incorrect code' });

    delete codes[clean];
    return res.status(200).json({ verified: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
