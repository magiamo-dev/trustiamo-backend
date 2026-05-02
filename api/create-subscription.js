const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, name, paymentMethodId } = req.body;
  if (!email || !name || !paymentMethodId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const existingCustomers = await stripe.customers.list({ email, limit: 1 });
    let customer;

    if (existingCustomers.data.length > 0) {
      customer = existingCustomers.data[0];
      await stripe.paymentMethods.attach(paymentMethodId, { customer: customer.id });
    } else {
      customer = await stripe.customers.create({
        email, name,
        payment_method: paymentMethodId,
        metadata: { platform: 'Trustiamo', network: 'Hospiamo' }
      });
    }

    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: paymentMethodId }
    });

    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: process.env.STRIPE_PRICE_ID }],
      payment_settings: {
        payment_method_types: ['card'],
        save_default_payment_method: 'on_subscription',
      },
      expand: ['latest_invoice.payment_intent'],
      metadata: { platform: 'Trustiamo', network: 'Hospiamo' }
    });

    const memberId = 'TRM-' + Math.floor(100000 + Math.random() * 900000);

    return res.status(200).json({
      success: true,
      subscriptionId: subscription.id,
      customerId: customer.id,
      status: subscription.status,
      memberId,
      nextBillingDate: new Date(subscription.current_period_end * 1000).toLocaleDateString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric'
      }),
    });

  } catch (error) {
    console.error('Stripe error:', error.message);
    return res.status(400).json({ error: error.message });
  }
};
