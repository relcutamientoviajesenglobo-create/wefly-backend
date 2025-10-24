require('dotenv').config();
const express = require('express');
const cors = require('cors');

// ===== Validaciones de entorno =====
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('❌ Falta STRIPE_SECRET_KEY en .env');
  process.exit(1);
}
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || null;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://wefly.com.mx';
const ENABLE_OXXO = String(process.env.ENABLE_OXXO || 'true').toLowerCase() !== 'false'; // true por defecto

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

// JSON para todas menos /webhook (que necesita raw)
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') return next();
  return express.json()(req, res, next);
});

// ===== Precios (server-side) =====
const PRICES = { adult: 2500, child: 2200 }; // MXN

function computeTotalMXN(booking) {
  const adults   = Number(booking.adults)   || 0;
  const children = Number(booking.children) || 0;
  const pax = adults + children;

  let base = adults * PRICES.adult + children * PRICES.child;

  let addonsTotal = 0;
  const addons = Array.isArray(booking.addons) ? booking.addons : [];
  for (const a of addons) {
    const name = String(a?.name || a || '').trim();
    const price = Number(a?.price) || 0;
    if (!name) continue;
    if (name === 'Desayuno en La Cueva') {
      addonsTotal += price * pax; // por persona
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

// ===== Helpers de validación y formato =====
function buildProductTexts(booking) {
  const contact = booking.contact || {};
  const pasajeros = Array.isArray(booking.passengers) ? booking.passengers : [];
  const adultos = Number(booking.adults) || 0;
  const ninos   = Number(booking.children) || 0;

  const textoAdultos = adultos === 1 ? '1 Adulto' : `${adultos} Adultos`;
  const textoNinos   = ninos   === 1 ? '1 Niño'   : `${ninos} Niños`;

  const addonsLabel = Array.isArray(booking.addons) && booking.addons.length
    ? ' + ' + booking.addons.map(a => (a.name || a)).join(' y ')
    : '';

  const productName = `Vuelo en Globo (${textoAdultos}, ${textoNinos})${addonsLabel}`;

  const passengerDetailsText = pasajeros.length
    ? pasajeros.map((p, i) => `Pasajero ${i + 1}: ${p.name || 'Sin nombre'} (${p.weight || 'Sin peso'} kg)`).join('; ')
    : 'Sin información de pasajeros';

  const fechaVueloTxt = booking.date ? String(booking.date) : 'No especificada';

  const descripcionCompleta =
    `${productName}. ${passengerDetailsText}. ` +
    `Fecha de vuelo: ${fechaVueloTxt}. ` +
    `Cliente: ${contact.name || 'No proporcionado'} ` +
    `(${contact.email || 'Sin correo'}, ${contact.phone || 'Sin teléfono'}).`;

  return { contact, pasajeros, adultos, ninos, productName, passengerDetailsText, fechaVueloTxt, descripcionCompleta };
}

function sanitizeStripeError(err) {
  const base = err?.raw?.message || err.message || 'Error al crear sesión de pago.';
  const code = err?.raw?.code || err.code || '';
  if (code === 'payment_method_type_unavailable' ||
      (String(base).toLowerCase().includes('payment_method_types') && String(base).toLowerCase().includes('oxxo'))) {
    return 'Tu cuenta de Stripe no tiene OXXO habilitado o este método no está disponible. Pagos con tarjeta siguen disponibles.';
  }
  if (String(base).toLowerCase().includes('invalid email')) return 'Email de contacto inválido.';
  if (String(base).toLowerCase().includes('amount')) return 'Monto inválido para crear el pago.';
  return base;
}

// ===== Crear sesión de Stripe Checkout =====
app.post('/create-checkout-session', async (req, res) => {
  try {
    const booking = req.body || {};

    // Recalcular total en servidor
    const amountMXN = computeTotalMXN(booking);
    if (amountMXN <= 0) {
      return res.status(400).json({ error: 'Total inválido.' });
    }

    const { contact, pasajeros, adultos, ninos, productName, fechaVueloTxt, descripcionCompleta } = buildProductTexts(booking);

    // Validaciones clave
    const pax = (Number(booking.adults)||0) + (Number(booking.children)||0);
    if (pax <= 0) {
      return res.status(400).json({ error: 'Debes seleccionar al menos un pasajero.' });
    }
    if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) {
      return res.status(400).json({ error: 'Email de contacto inválido.' });
    }

    // Métodos de pago (fallback si OXXO no disponible)
    const pmTypesBase = ['card'];
    if (ENABLE_OXXO) pmTypesBase.push('oxxo');

    async function createSession(paymentMethodTypes) {
      return await stripe.checkout.sessions.create({
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
              description: descripcionCompleta.slice(0, 500),
              metadata: {
                tipoProducto: 'Vuelo en Globo',
                adultos: String(adultos),
                ninos: String(ninos),
                addonsSeleccionados: JSON.stringify((booking.addons || []).map(a => a.name || a)),
                fechaVuelo: fechaVueloTxt,
                pasajeros: JSON.stringify(pasajeros), // nombre + peso
                totalServidorMXN: String(amountMXN)
              }
            }
          }
        }],

        allow_promotion_codes: false,
        billing_address_collection: 'auto',
        phone_number_collection: { enabled: true },

        payment_method_types: paymentMethodTypes,
        payment_method_options: paymentMethodTypes.includes('oxxo') ? { oxxo: { expires_after_days: 2 } } : undefined,

        // Recibo por correo & descripción en el cobro
        payment_intent_data: {
          receipt_email: contact.email || undefined,
          description: descripcionCompleta.slice(0, 500),
          metadata: {
            descripcionCompleta,
            nombreCliente: contact.name || 'No proporcionado',
            emailCliente: contact.email || 'No proporcionado',
            telefonoCliente: contact.phone || 'No proporcionado',
            fechaVuelo: fechaVueloTxt,
            adultos: String(adultos),
            ninos: String(ninos),
            pasajeros: JSON.stringify(pasajeros),
            addons: JSON.stringify((booking.addons || []).map(a => a.name || a)),
            totalServidorMXN: String(amountMXN)
          }
        },

        // Customer + Factura (PDF/email) con descripción y metadatos
        customer_email: contact.email || undefined,
        customer_creation: 'always',
        invoice_creation: {
          enabled: true,
          invoice_data: {
            description: descripcionCompleta, // aparece en PDF/correo de factura
            metadata: {
              descripcionCompleta,
              nombreCliente: contact.name || 'No proporcionado',
              emailCliente: contact.email || 'No proporcionado',
              telefonoCliente: contact.phone || 'No proporcionado',
              fechaVuelo: fechaVueloTxt,
              adultos: String(adultos),
              ninos: String(ninos),
              pasajeros: JSON.stringify(pasajeros),
              addons: JSON.stringify((booking.addons || []).map(a => a.name || a)),
              totalServidorMXN: String(amountMXN)
            },
            custom_fields: [
              { name: 'Fecha de vuelo', value: fechaVueloTxt },
              { name: 'Pasajeros', value: `${adultos} adulto(s), ${ninos} niño(s)` }
            ],
            footer: 'Gracias por volar con We Fly. Atención: +52 55 1234 5678 • wefly.com.mx'
          }
        },

        success_url: `${FRONTEND_URL}/?checkout=success`,
        cancel_url: `${FRONTEND_URL}/?checkout=cancel`,

        // Visibles en el panel
        description: descripcionCompleta,
        statement_descriptor_suffix: 'WEFLY GLOBO',

        // Metadatos a nivel sesión
        metadata: {
          descripcionCompleta,
          nombreCliente: contact.name || 'No proporcionado',
          emailCliente: contact.email || 'No proporcionado',
          telefonoCliente: contact.phone || 'No proporcionado',
          fechaVuelo: fechaVueloTxt,
          adultos: String(adultos),
          ninos: String(ninos),
          pasajeros: JSON.stringify(pasajeros),
          addons: JSON.stringify((booking.addons || []).map(a => a.name || a)),
          totalServidorMXN: String(amountMXN)
        }
      });
    }

    let session;
    try {
      session = await createSession(pmTypesBase);
    } catch (e) {
      // Si falla por OXXO no disponible, reintenta solo con tarjeta
      const msg = sanitizeStripeError(e);
      const oxxoUnavailable =
        (e?.raw?.code === 'payment_method_type_unavailable') ||
        (String(e?.message || '').toLowerCase().includes('payment_method_types') &&
         String(e?.message || '').toLowerCase().includes('oxxo'));

      if (oxxoUnavailable && pmTypesBase.includes('oxxo')) {
        console.warn('⚠️ OXXO no disponible. Reintentando solo con tarjeta…');
        session = await createSession(['card']);
      } else {
        console.error('❌ Error create-checkout-session:', e);
        return res.status(500).json({ error: msg });
      }
    }

    return res.json({ id: session.id, url: session.url });
  } catch (err) {
    console.error('❌ Error create-checkout-session (catch):', err);
    return res.status(500).json({ error: sanitizeStripeError(err) });
  }
});

// ===== Webhook (opcional, recomendado) =====
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!endpointSecret) {
    console.warn('⚠️ Webhook sin verificar (falta STRIPE_WEBHOOK_SECRET). Respondiendo 200 para pruebas.');
    return res.status(200).json({ received: true });
  }
  const sig = req.headers['stripe-signature'];
  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    console.log('🎯 Webhook:', event.type);

    if (event.type === 'checkout.session.completed') {
      const sess = event.data.object;
      console.log('✅ Checkout pagado (sincrónico):', sess.id, sess.payment_status);
      // TODO: crear/actualizar reserva, enviar emails, etc.
    }
    if (event.type === 'checkout.session.async_payment_succeeded') {
      const sess = event.data.object;
      console.log('✅ Pago asíncrono confirmado (p.ej., OXXO):', sess.id);
      // TODO
    }
    if (event.type === 'checkout.session.async_payment_failed') {
      const sess = event.data.object;
      console.log('❌ Pago asíncrono falló:', sess.id);
      // TODO
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
- FRONTEND_URL: ${FRONTEND_URL}
- ENABLE_OXXO: ${ENABLE_OXXO}
Endpoints:
  GET  /                      -> Health
  POST /create-checkout-session
  POST /webhook
  `);
});
