import Stripe from 'stripe';
import { Redis } from '@upstash/redis';

// Disable Vercel's default body parser. Stripe signature verification
// requires the raw, unparsed request body.
export const config = {
  api: {
    bodyParser: false,
  },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const redis = Redis.fromEnv();

// Helper: read the raw request body as a Buffer.
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Resolve the email for a subscription event by fetching the Stripe customer.
async function resolveCustomerEmail(customerId) {
  const customer = await stripe.customers.retrieve(customerId);
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
// Rules:
// - If subscriber:{email} does not exist: create it with a new mbrId.
// - If it exists and stripeSubscriptionId matches: idempotent no-op, just touch updatedAt.
// - If it exists and stripeSubscriptionId differs: cancel-and-resubscribe case.
//   Keep mbrId and joinedAt. Overwrite stripeSubscriptionId, customerId, status.
async function handleSubscriptionCreated(subscription) {
  const email = await resolveCustomerEmail(subscription.customer);
  const key = `subscriber:${email}`;
  const now = new Date().toISOString();

  const existingRaw = await redis.get(key);
  const existing = existingRaw
    ? (typeof existingRaw === 'string' ? JSON.parse(existingRaw) : existingRaw)
    : null;

  if (existing && existing.stripeSubscriptionId === subscription.id) {
    // Idempotent replay. Touch updatedAt and status; do nothing else.
    existing.status = subscription.status;
    existing.updatedAt = now;
    await redis.set(key, JSON.stringify(existing));
    console.log(`[stripe-webhook] created (idempotent replay) for ${email} mbrId=${existing.mbrId}`);
    return;
  }

  if (existing) {
    // Cancel-and-resubscribe: same human, new Stripe subscription.
    existing.stripeCustomerId = subscription.customer;
    existing.stripeSubscriptionId = subscription.id;
    existing.status = subscription.status;
    existing.updatedAt = now;
    await redis.set(key, JSON.stringify(existing));
    console.log(`[stripe-webhook] created (resubscribe) for ${email} mbrId=${existing.mbrId} new sub=${subscription.id}`);
    return;
  }

  // Fresh subscriber. Allocate a new mbrId.
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
// Rules:
// - If subscriber:{email} exists: set status to "canceled", touch updatedAt. Do NOT delete the record.
//   Reason: we want to preserve mbrId and joinedAt in case the human resubscribes (Decision 2a).
// - If it does not exist: log and no-op. We received a delete for a subscription we never recorded.
async function handleSubscriptionDeleted(subscription) {
  const email = await resolveCustomerEmail(subscription.customer);
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

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (err) {
    console.error('Signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  console.log(`[stripe-webhook] received event ${event.id} of type ${event.type}`);

  try {
    switch (event.type) {
      case 'customer.subscription.created':
        await handleSubscriptionCreated(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      case 'customer.subscription.updated':
        console.log(`[stripe-webhook] event ${event.type} will be handled in Step 3`);
        break;
      default:
        console.log(`[stripe-webhook] event type ${event.type} not handled`);
    }
  } catch (err) {
    console.error(`[stripe-webhook] handler error for ${event.type}:`, err.message);
    // Return 500 so Stripe retries. The handler failed; we want another shot.
    return res.status(500).json({ error: `Handler error: ${err.message}` });
  }

  return res.status(200).json({ received: true, type: event.type, id: event.id });
}
