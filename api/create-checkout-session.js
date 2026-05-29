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
     res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
     res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
   }

   export default async function handler(req, res) {
     setOriginHeaders(req, res);
     if (req.method === 'OPTIONS') return res.status(200).end();
     if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

     try {
       const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
       const priceId = process.env.STRIPE_PRICE_ID;

       const session = await stripe.checkout.sessions.create({
         mode: 'subscription',
         payment_method_types: ['card'],
         line_items: [
           { price: priceId, quantity: 1 },
         ],
         success_url: 'https://trustiamo.com/join/success/?session_id={CHECKOUT_SESSION_ID}',
         cancel_url: 'https://trustiamo.com/join/',
         allow_promotion_codes: false,
         billing_address_collection: 'auto',
       });

       return res.status(200).json({ url: session.url });
     } catch (err) {
       console.error('create-checkout-session error:', err);
       return res.status(500).json({ error: err.message });
     }
   }
