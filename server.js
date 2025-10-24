// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');

// ============================================
// VALIDACIONES INICIALES
// ============================================
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('❌ FATAL: Falta STRIPE_SECRET_KEY en variables de entorno.');
  process.exit(1);
}
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
// stripe.setAppInfo({ name: 'WEFly Stripe Server', version: '1.0.0' });

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
if (!endpointSecret) {
  console.warn('⚠️ ADVERTENCIA: Falta STRIPE_WEBHOOK_SECRET. Verificación de webhooks deshabilitada.');
}

const app = express();

// ============================================
// CONFIGURACIÓN DE CORS
// ============================================
const allowedOrigins = [
  'https://wefly.com.mx',
  'https://www.wefly.com.mx',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      const msg = `Origen no permitido por CORS: ${origin}`;
      console.warn(`⚠️ ${msg}`);
      callback(new Error(msg), false);
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
  credentials: false,
  optionsSuccessStatus: 204
};
app.use(cors(corsOptions));

// ============================================
// MIDDLEWARES
// ============================================
// Importante: NO aplicar express.json() al webhook (requiere raw)
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') return next();
  return express.json({ limit: '1mb' })(req, res, next);
});

// ============================================
// CONSTANTES DE PRECIO (fuente de la verdad)
// ============================================
const PRICES = {
  ADULT: 2500, // MXN
  CHILD: 2200, // MXN
  ADDONS: {
    'Photoshoot': 1200,          // fijo por reserva
    'Video con Drone': 1200,     // fijo por reserva
    'Video con Dron': 1200,      // alias defensivo
    'Desayuno en La Cueva': 600  // por persona
  }
};

// Utilidades
const isValidEmail = (email) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());

function computeServerTotalMXN(booking) {
  const adults = Number(booking?.adults) || 0;
  const children = Number(booking?.children) || 0;
  if (adults + children <= 0) throw new Error('Debe haber al menos 1 pasajero.');

  const base = adults * PRICES.ADULT + children * PRICES.CHILD;

  const addonsArr = Array.isArray(booking?.addons) ? booking.addons : [];
  const paxCount = adults + children;

  let addonsTotal = 0;
  const names = addonsArr.map(a => String(a?.name || ''));

  // Fijos por reserva
  if (names.some(n => n === 'Photoshoot')) addonsTotal += PRICES.ADDONS['Photoshoot'];
  if (names.some(n => n === 'Video con Drone' || n === 'Video con Dron')) addonsTotal += PRICES.ADDONS['Video con Drone'];

  // Por persona
  if (names.some(n => n === 'Desayuno en La Cueva')) addonsTotal += PRICES.ADDONS['Desayuno en La Cueva'] * paxCount;

  const total = base + addonsTotal;
  if (total <= 0) throw new Error('Total calculado inválido.');
  return total;
}

// ============================================
// RUTAS
// ============================================

// Health check
app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'WEFly Stripe Server',
    timestamp: new Date().toISOString()
  });
});

// Crear PaymentIntent (Stripe Elements)
app.post('/create-payment-intent', async (req, res) => {
  try {
    const booking = req.body || {};
    const contact = booking.contact || {};

    // Validaciones
    const pax = (Number(booking.adults) || 0) + (Number(booking.children) || 0);
    if (pax <= 0) {
      return res.status(400).json({ error: 'Debes seleccionar al menos un pasajero.' });
    }
    if (contact.email && !isValidEmail(contact.email)) {
      return res.status(400).json({ error: 'Email de contacto inválido.' });
    }

    // Calcular total en el servidor (MXN)
    const totalMXN = computeServerTotalMXN(booking);
    const amount = Math.round(totalMXN * 100); // centavos

    // Idempotency opcional (header o body)
    const idemKey =
      req.get('Idempotency-Key') ||
      (booking.idempotencyKey ? String(booking.idempotencyKey) : undefined);

    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount,
        currency: 'mxn',
        automatic_payment_methods: { enabled: true },
        receipt_email: contact.email || undefined,
        metadata: {
          nombreCliente: contact.name || 'No proporcionado',
          emailCliente: contact.email || 'No proporcionado',
          telefonoCliente: contact.phone || 'No proporcionado',
          fechaVuelo: booking.date ? String(booking.date).split('T')[0] : 'No especificada',
          totalPasajeros: String(pax),
          totalCalculadoMXN: String(totalMXN),
          addons: Array.isArray(booking.addons)
            ? JSON.stringify(booking.addons.map(a => a.name))
            : '[]'
        }
      },
      idemKey ? { idempotencyKey: idemKey } : undefined
    );

    return res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('❌ Error /create-payment-intent:', err.message);
    return res.status(500).json({ error: 'No se pudo iniciar el proceso de pago.' });
  }
});

// Webhook (usar raw)
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!endpointSecret) {
    console.error('❌ Webhook no procesado: Falta STRIPE_WEBHOOK_SECRET');
    return res.status(400).send('Webhook secret no configurado.');
  }

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error(`❌ Error verificación Webhook: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`🎯 Webhook recibido: ${event.type}`);

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        console.log('💰 PaymentIntent Succeeded:', pi.id);
        console.log('   Monto:', (pi.amount / 100).toFixed(2), pi.currency.toUpperCase());
        console.log('   Email:', pi.receipt_email || pi.customer_details?.email || 'N/D');
        console.log('   Metadata:', pi.metadata);

        // TODO: Lógica de negocio (idempotente):
        // - Verificar si ya se procesó pi.id
        // - Crear/actualizar reserva con metadata
        // - Marcar pagada
        // - Enviar confirmaciones (cliente/equipo)
        // - Actualizar inventario
        break;
      }

      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        console.log('❌ PaymentIntent Failed:', pi.id);
        console.log('   Error:', pi.last_payment_error?.message);
        // TODO: Notificar si lo requieres
        break;
      }

      case 'charge.succeeded': {
        const ch = event.data.object;
        console.log('✅ Charge Succeeded:', ch.id, 'PI:', ch.payment_intent);
        // Puedes guardar ch.receipt_url
        break;
      }

      default:
        console.log(`🤷 Evento no manejado: ${event.type}`);
    }
  } catch (bizErr) {
    // Si tu lógica de negocio falla, registra el error pero responde 200 para evitar reintentos infinitos
    console.error('⚠️ Error en lógica de negocio del webhook:', bizErr.message);
  }

  return res.json({ received: true });
});

// ============================================
// MANEJO DE ERRORES GLOBAL
// ============================================
app.use((err, req, res, _next) => {
  // Manejo CORS: empata el mensaje lanzado arriba
  const msg = String(err?.message || '');
  if (msg.toLowerCase().includes('origen no permitido por cors')) {
    console.error(`❌ CORS bloqueado: ${req.headers.origin || 'origen desconocido'}`);
    return res.status(403).json({ error: 'Acceso denegado por CORS.' });
  }

  console.error('❌ Error no manejado:', err.stack || msg);
  const isDev = process.env.NODE_ENV === 'development';
  return res.status(500).json({
    error: 'Error interno del servidor.',
    details: isDev ? msg : undefined
  });
});

// ============================================
// INICIO DEL SERVIDOR
// ============================================
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`
🚀 WEFly Stripe Server ACTIVO
--------------------------------------------
  Puerto:      ${PORT}
  Entorno:     ${process.env.NODE_ENV || 'development'}
  Stripe Key:  ${process.env.STRIPE_SECRET_KEY ? 'OK' : 'FALTA'}
  Webhook Key: ${endpointSecret ? 'OK' : 'FALTA (requerida prod)'}
  CORS:        ${allowedOrigins.join(', ')}
  Inicio:      ${new Date().toLocaleString('es-MX')}
--------------------------------------------
  GET  /                      -> Health
  POST /create-payment-intent -> Crear PaymentIntent
  POST /webhook               -> Webhooks de Stripe
--------------------------------------------
  `);
});

// Cierre limpio
process.on('SIGTERM', () => { console.log('SIGTERM recibido. Cerrando...'); process.exit(0); });
process.on('SIGINT',  () => { console.log('SIGINT recibido. Cerrando...');  process.exit(0); });
