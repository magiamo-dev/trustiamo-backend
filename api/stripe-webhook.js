import Stripe from 'stripe';
import { Redis } from '@upstash/redis';

// Disable Vercel's default body parser. Stripe signature verification
// requires the raw, unparsed request body.
export const config = {
  api: {
    bodyParser: false,
  },
};

// Two Stripe clients: one for live mode, one for test mode.
// We use the test-mode client when an incoming event has livemode === false.
// Signature verification uses STRIPE_WEBHOOK_SECRET separately and works for both.
const stripeLive = new Stripe(process.env.STRIPE_SECRET_KEY);
const stripeTest = process.env.STRIPE_SECRET_KEY_TEST
  ? new Stripe(process.env.STRIPE_SECRET_KEY_TEST)
  : null;

const redis = Redis.fromEnv();

// Pick the right Stripe client for API calls based on the event's livemode flag.
function stripeForEvent(event) {
  if (event.livemode === false) {
    if (!stripeTest) {
      throw new Error('Received test-mode event but STRIPE_SECRET_KEY_TEST is not set');
    }
    return stripeTest;
  }
  return stripeLive;
}

// Helper: read the raw request body as a Buffer.
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Resolve the email for a subscription event by fetching the Stripe customer.
async function resolveCustomerEmail(stripeClient, customerId) {
  const customer = await stripeClient.customers.retrieve(customerId);
  if (customer.deleted) {
    throw new Error(`Stripe customer ${customerId} is deleted`);
  }
  if (!customer.email) {
    throw new Error(`Stripe customer ${customerId} has no email`);
  }
  return customer.email.toLowerCase().trim();
}

// Format a sequential MBR id: MBR-000001
function formatMbrId(n) {
  return `MBR-${String(n).padStart(6, '0')}`;
}

// Handle customer.subscription.created
async function handleSubscriptionCreated(stripeClient, subscription) {
  const email = await resolveCustomerEmail(stripeClient, subscription.customer);
  const key = `subscriber:${email}`;
  const now = new Date().toISOString();

  const existingRaw = await redis.get(key);
  const existing = existingRaw
    ? (typeof existingRaw === 'string' ? JSON.parse(existingRaw) : existingRaw)
    : null;

  if (existing && existing.stripeSubscriptionId === subscription.id) {
    existing.status = subscription.status;
    existing.updatedAt = now;
    await redis.set(key, JSON.stringify(existing));
    console.log(`[stripe-webhook] created (idempotent replay) for ${email} mbrId=${existing.mbrId}`);
    return;
  }

  if (existing) {
    existing.stripeCustomerId = subscription.customer;
    existing.stripeSubscriptionId = subscription.id;
    existing.status = subscription.status;
    existing.updatedAt = now;
    await redis.set(key, JSON.stringify(existing));
    console.log(`[stripe-webhook] created (resubscribe) for ${email} mbrId=${existing.mbrId} new sub=${subscription.id}`);
    return;
  }

  const counter = await redis.incr('mbr:counter');
  const mbrId = formatMbrId(counter);
  const record = {
    mbrId,
    email,
    stripeCustomerId: subscription.customer,
    stripeSubscriptionId: subscription.id,
    status: subscription.status,
    joinedAt: now,
    updatedAt: now,
  };
  await redis.set(key, JSON.stringify(record));
  console.log(`[stripe-webhook] created (new) for ${email} mbrId=${mbrId} sub=${subscription.id}`);
}

// Handle customer.subscription.deleted
async function handleSubscriptionDeleted(stripeClient, subscription) {
  const email = await resolveCustomerEmail(stripeClient, subscription.customer);
  const key = `subscriber:${email}`;
  const now = new Date().toISOString();

  const existingRaw = await redis.get(key);
  if (!existingRaw) {
    console.log(`[stripe-webhook] deleted for ${email}: no existing record, ignoring`);
    return;
  }

  const existing = typeof existingRaw === 'string' ? JSON.parse(existingRaw) : existingRaw;
  existing.status = 'canceled';
  existing.updatedAt = now;
  await redis.set(key, JSON.stringify(existing));
  console.log(`[stripe-webhook] deleted for ${email} mbrId=${existing.mbrId}`);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const signature = req.headers['stripe-signature'];
  if (!signature) {
    return res.status(400).json({ error: 'Missing Stripe-Signature header' });
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('STRIPE_WEBHOOK_SECRET is not set');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    console.error('Failed to read raw body:', err.message);
    return res.status(400).json({ error: 'Could not read request body' });
  }

  // Signature verification uses stripeLive's static method, which doesn't
  // require a per-mode client — constructEvent only checks the signature
  // and parses the payload. Either client's static method would work.
  let event;
  try {
    event = Stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (err) {
    console.error('Signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  console.log(`[stripe-webhook] received event ${event.id} of type ${event.type} livemode=${event.livemode}`);

  let stripeClient;
  try {
    stripeClient = stripeForEvent(event);
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: err.message });
  }

  try {
    switch (event.type) {
      case 'customer.subscription.created':
        await handleSubscriptionCreated(stripeClient, event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(stripeClient, event.data.object);
        break;
      case 'customer.subscription.updated':
        console.log(`[stripe-webhook] event ${event.type} will be handled in Step 3`);
        break;
      default:
        console.log(`[stripe-webhook] event type ${event.type} not handled`);
    }
  } catch (err) {
    console.error(`[stripe-webhook] handler error for ${event.type}:`, err.message);
    return res.status(500).json({ error: `Handler error: ${err.message}` });
  }

  return res.status(200).json({ received: true, type: event.type, id: event.id });
}
