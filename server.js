// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');

// ===== Validaciones de entorno =====
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('❌ Falta STRIPE_SECRET_KEY en .env');
  process.exit(1);
}
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// (Opcional) Webhook para manejar eventos de Stripe
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || null;

const app = express();

// ===== CORS =====
const allowedOrigins = [
  'https://wefly.com.mx',
  'https://www.wefly.com.mx',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    console.warn(`⚠️ Origen bloqueado por CORS: ${origin}`);
    return cb(new Error('Origen no permitido por CORS'), false);
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));

// JSON para todas menos /webhook
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') return next();
  return express.json()(req, res, next);
});

// ===== Config precios (server-side, evita fraude) =====
const PRICES = { adult: 2500, child: 2200 }; // MXN

function computeTotalMXN(booking) {
  const adults   = Number(booking.adults)   || 0;
  const children = Number(booking.children) || 0;
  const pax = adults + children;

  let base = adults * PRICES.adult + children * PRICES.child;

  let addonsTotal = 0;
  const addons = Array.isArray(booking.addons) ? booking.addons : [];
  for (const a of addons) {
    const name = String(a.name || a).trim();
    const price = Number(a.price) || 0;
    if (name === 'Desayuno en La Cueva') {
      addonsTotal += price * pax; // p/p
    } else {
      addonsTotal += price;       // por grupo
    }
  }
  const total = base + addonsTotal;
  return Math.max(0, Math.round(total));
}

// ===== Health =====
app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'WEFly Stripe Checkout', when: new Date().toISOString() });
});

// ===== Crear sesión de Stripe Checkout =====
app.post('/create-checkout-session', async (req, res) => {
  try {
    const booking = req.body || {};
    // Recalcular total en servidor (seguro)
    const amountMXN = computeTotalMXN(booking);
    if (amountMXN <= 0) {
      return res.status(400).json({ error: 'Total inválido.' });
    }

    // Validaciones básicas de contacto
    const contact = booking.contact || {};
    if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) {
      return res.status(400).json({ error: 'Email de contacto inválido.' });
    }
    const pax = (Number(booking.adults)||0) + (Number(booking.children)||0);
    if (pax <= 0) {
      return res.status(400).json({ error: 'Debes seleccionar al menos un pasajero.' });
    }

    // Nombre producto para el recibo / panel
    const addonsLabel = Array.isArray(booking.addons) && booking.addons.length
      ? ' + ' + booking.addons.map(a => (a.name || a)).join(' + ')
      : '';
    const productName = `Vuelo en Globo (${booking.adults} Ad, ${booking.children} Niñ)${addonsLabel}`.slice(0, 120);

    // URLs de retorno (ajusta tu dominio del frontend)
    const FRONTEND_URL = process.env.FRONTEND_URL || 'https://wefly.com.mx';
    const successUrl = `${FRONTEND_URL}/?checkout=success`;
    const cancelUrl  = `${FRONTEND_URL}/?checkout=cancel`;

    // Crear sesión Checkout (tarjeta, wallets y OXXO)
    // Nota: Google/Apple Pay entran por "card" y "automatic_tax/wallets"
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      locale: 'es',
      currency: 'mxn',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'mxn',
          unit_amount: amountMXN * 100, // centavos
          product_data: {
            name: productName,
            metadata: {
              pax: String(pax),
              fechaVuelo: booking.date ? String(booking.date) : 'No especificada'
            }
          }
        }
      }],
      allow_promotion_codes: false,
      billing_address_collection: 'auto',
      phone_number_collection: { enabled: true },
      // habilita métodos (oxxo + card)
      payment_method_types: ['card', 'oxxo'],
      payment_method_options: {
        oxxo: { expires_after_days: 2 } // vence en 2 días (ajustable)
      },
      customer_email: contact.email || undefined,
      success_url: successUrl,
      cancel_url: cancelUrl,
      // Metadata útil para post-procesar
      metadata: {
        nombreCliente: contact.name || 'No proporcionado',
        emailCliente: contact.email || 'No proporcionado',
        telefonoCliente: contact.phone || 'No proporcionado',
        fechaVuelo: booking.date ? String(booking.date) : 'No especificada',
        adultos: String(booking.adults || 0),
        ninos: String(booking.children || 0),
        addons: JSON.stringify((booking.addons||[]).map(a => a.name || a)),
        totalServidorMXN: String(amountMXN)
      }
    });

    return res.json({ id: session.id, url: session.url });
  } catch (err) {
    console.error('❌ Error create-checkout-session:', err);
    return res.status(500).json({ error: 'No se pudo crear la sesión de pago.' });
  }
});

// ===== Webhook (opcional, recomendado en producción) =====
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!endpointSecret) {
    console.warn('⚠️ Webhook sin verificar (falta STRIPE_WEBHOOK_SECRET)');
    return res.status(200).json({ received: true });
  }
  const sig = req.headers['stripe-signature'];
  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    console.log('🎯 Webhook:', event.type);

    if (event.type === 'checkout.session.completed') {
      const sess = event.data.object;
      console.log('✅ Checkout pagado:', sess.id, sess.payment_status);
      // TODO: tu lógica post-pago (crear reserva, enviar email, etc.)
    }
    if (event.type === 'checkout.session.async_payment_succeeded') {
      const sess = event.data.object;
      console.log('✅ Pago async (ej. OXXO) confirmado:', sess.id);
    }
    if (event.type === 'checkout.session.async_payment_failed') {
      const sess = event.data.object;
      console.log('❌ Pago async falló:', sess.id);
    }
    return res.json({ received: true });
  } catch (e) {
    console.error('❌ Webhook error:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }
});

// ===== Errores globales =====
app.use((err, req, res, next) => {
  if (err && err.message && err.message.includes('Origen no permitido por CORS')) {
    return res.status(403).json({ error: 'Acceso denegado.' });
  }
  console.error('❌ Error no manejado:', err.stack || err.message);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

// ===== Inicio =====
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`
🚀 WEFly Stripe Checkout listo
- Puerto: ${PORT}
- Entorno: ${process.env.NODE_ENV || 'development'}
- Stripe Key: ${process.env.STRIPE_SECRET_KEY ? 'OK' : 'FALTA'}
- Webhook Key: ${endpointSecret ? 'OK' : 'NO CONFIGURADA'}
- FRONTEND_URL: ${process.env.FRONTEND_URL || 'https://wefly.com.mx'}
Endpoints:
  GET  /                      -> Health
  POST /create-checkout-session
  POST /webhook
  `);
});
