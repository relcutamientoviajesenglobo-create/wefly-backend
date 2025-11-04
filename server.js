require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { customAlphabet } = require('nanoid');
const sgMail = require('@sendgrid/mail');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://wefly.com.mx';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const PRICE_ADULT_MXN = Number(process.env.PRICE_ADULT_MXN || 10);
const PRICE_CHILD_MXN = Number(process.env.PRICE_CHILD_MXN || 10);

if (!process.env.SENDGRID_API_KEY) {
  console.warn('⚠️ Falta SENDGRID_API_KEY en variables de entorno');
}
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// CORS
const allowedOrigins = [
  'https://wefly.com.mx',
  'https://www.wefly.com.mx',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('CORS bloqueado para origen: ' + origin));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// ====== WEBHOOK (RAW) ======
app.post(
  '/stripe-webhook',
  bodyParser.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('❌ Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;

        const bookingId = session.metadata?.bookingId;
        const confirmationCode = session.metadata?.confirmation_code;

        const customer_email =
          session.customer_details?.email ||
          session.metadata?.customer_email ||
          '';
        const customer_name =
          session.customer_details?.name ||
          session.metadata?.customer_name ||
          'Cliente';
        const pax = session.metadata?.pax || '0';
        const dateISO = session.metadata?.date || '';
        const dateStr = dateISO
          ? new Date(dateISO).toLocaleDateString('es-MX', {
              weekday: 'short',
              year: 'numeric',
              month: 'short',
              day: 'numeric',
            })
          : 'Por confirmar';

        const totalMXN =
          typeof session.amount_total === 'number'
            ? session.amount_total / 100
            : undefined;

        const services = 'Vuelo en Globo';

        // Email cliente
        if (process.env.SENDGRID_TEMPLATE_ID && customer_email) {
          await sendBookingEmail({
            to: customer_email,
            templateId: process.env.SENDGRID_TEMPLATE_ID,
            dynamicData: {
              customer_name,
              confirmation_code: confirmationCode,
              date: dateStr,
              pax: String(pax),
              total_formatted:
                totalMXN !== undefined
                  ? `$${Number(totalMXN).toLocaleString('es-MX')} MXN`
                  : '',
              services,
            },
            from: 'We Fly Teotihuacan <info@wefly.com.mx>',
          });
        } else {
          console.warn(
            '⚠️ Falta SENDGRID_TEMPLATE_ID o email del cliente para enviar correo.'
          );
        }

        // Copia staff (opcional)
        const staffInbox =
          process.env.BOOKINGS_INBOX || 'info@wefly.com.mx';
        const staffTpl =
          process.env.SENDGRID_TEMPLATE_ID_STAFF ||
          process.env.SENDGRID_TEMPLATE_ID;

        if (staffTpl && staffInbox) {
          await sendBookingEmail({
            to: staffInbox,
            templateId: staffTpl,
            dynamicData: {
              customer_name,
              confirmation_code: confirmationCode,
              date: dateStr,
              pax: String(pax),
              total_formatted:
                totalMXN !== undefined
                  ? `$${Number(totalMXN).toLocaleString('es-MX')} MXN`
                  : '',
              services,
            },
            from: 'Reservas We Fly <info@wefly.com.mx>',
          });
        }

        // Guardar en Supabase
        try {
          await saveBookingToSupabase(session);
        } catch (dbErr) {
          console.error('⚠️ Error guardando en Supabase:', dbErr.message);
        }
      }

      res.json({ received: true });
    } catch (e) {
      console.error('❌ Error procesando webhook:', e);
      res.status(500).send('Webhook handler failed.');
    }
  }
);

// Después del webhook, JSON normal
app.use(express.json());

// ====== UTILS ======

const nano = customAlphabet('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 6);
function buildConfirmationCode(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `WFT-${y}${m}${d}-${nano()}`;
}

async function sendBookingEmail({ to, templateId, dynamicData, from }) {
  const msg = {
    to,
    from: from || 'We Fly Teotihuacan <info@wefly.com.mx>',
    templateId,
    dynamic_template_data: dynamicData,
  };
  await sgMail.send(msg);
}

// Cálculo total replicando el front (adultos + niños + addons)
function computeTotalMXN(booking) {
  const adults = Number(booking.adults) || 0;
  const children = Number(booking.children) || 0;
  const base =
    adults * PRICE_ADULT_MXN +
    children * PRICE_CHILD_MXN;
  const pax = adults + children;

  let addonsTotal = 0;
  (booking.addons || []).forEach((a) => {
    const price = Number(a.price) || 0;
    addonsTotal += a.name === 'Desayuno en La Cueva' ? price * pax : price;
  });

  return base + addonsTotal;
}

function saveBookingToSupabase(session) {
  return new Promise((resolve, reject) => {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      console.warn('⚠️ Supabase no configurado, omitiendo guardado.');
      return resolve();
    }

    const totalMXN =
      typeof session.amount_total === 'number'
        ? session.amount_total / 100
        : null;

    const payload = {
      stripe_session_id: session.id,
      booking_id: session.metadata?.bookingId || null,
      confirmation_code: session.metadata?.confirmation_code || null,
      customer_name:
        session.customer_details?.name ||
        session.metadata?.customer_name ||
        null,
      customer_email:
        session.customer_details?.email ||
        session.metadata?.customer_email ||
        null,
      pax: session.metadata?.pax
        ? Number(session.metadata.pax)
        : null,
      date_iso: session.metadata?.date || null,
      total_mxn: totalMXN,
      payment_status: session.payment_status || null,
    };

    const baseUrl = new URL(SUPABASE_URL);
    const restUrl = new URL('/rest/v1/bookings', baseUrl.origin);

    const data = JSON.stringify(payload);

    const opts = {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
    };

    const req = https.request(restUrl, opts, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(
            new Error(
              `Supabase status ${res.statusCode}: ${body || 'sin cuerpo'}`
            )
          );
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.write(data);
    req.end();
  });
}

// ====== HEALTH ======
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'WeFly Stripe Server',
    time: new Date().toISOString(),
    priceAdultMXN: PRICE_ADULT_MXN,
    priceChildMXN: PRICE_CHILD_MXN,
  });
});

app.get('/status', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get('/status/html', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<!doctype html><meta charset="utf-8"><title>Status</title><h1>OK</h1>');
});

// ====== CREATE CHECKOUT ======
app.post('/create-checkout-session', async (req, res) => {
  try {
    const booking = req.body || {};

    const adults = Number(booking.adults) || 0;
    const children = Number(booking.children) || 0;
    if (adults + children <= 0) {
      return res
        .status(400)
        .json({ error: 'Debes seleccionar al menos 1 pasajero.' });
    }

    const totalMXN = computeTotalMXN(booking);
    if (!(totalMXN > 0)) {
      return res.status(400).json({ error: 'Total inválido.' });
    }

    const bookingId = `BKG_${Date.now()}`;
    const confDate = booking?.date ? new Date(booking.date) : new Date();
    const confirmationCode = buildConfirmationCode(confDate);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      currency: 'mxn',
      line_items: [
        {
          price_data: {
            currency: 'mxn',
            product_data: {
              name: 'Vuelo en Globo We Fly Teotihuacan',
            },
            unit_amount: Math.round(totalMXN * 100),
          },
          quantity: 1,
        },
      ],
      metadata: {
        bookingId,
        confirmation_code: confirmationCode,
        customer_name: booking?.contact?.name || '',
        customer_email: booking?.contact?.email || '',
        customer_phone: booking?.contact?.phone || '',
        pax: String(adults + children),
        date: booking?.date ? String(booking.date) : '',
      },
      client_reference_id: bookingId,

      // 🔴 AQUÍ VA EL CAMBIO IMPORTANTE PARA LA PANTALLA DE CONFIRMACIÓN 🔴
      success_url: `${FRONTEND_URL}/?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/?canceled=true`,
      // (Tu HTML nuevo soporta también el esquema anterior ?checkout=success&bid=..., pero con esto ya estándar Stripe)
    });

    res.json({ url: session.url, bookingId });
  } catch (err) {
    console.error('❌ Error creando sesión:', err);
    res
      .status(400)
      .json({ error: err.message || 'No se pudo crear la sesión.' });
  }
});

// ====== LOOKUP POR SESSION ID ======
app.get('/booking/by-session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });

    const confirmationCode = session.metadata?.confirmation_code || null;
    const bookingId = session.metadata?.bookingId || null;
    const pax = session.metadata?.pax || null;
    const dateISO = session.metadata?.date || null;
    const totalMXN =
      typeof session.amount_total === 'number'
        ? session.amount_total / 100
        : null;

    res.json({
      bookingId,
      confirmationCode,
      pax,
      date: dateISO,
      totalMXN,
      status: session.payment_status,
    });
  } catch (e) {
    console.error('❌ Error consultando sesión:', e);
    res.status(404).json({ error: 'Not found' });
  }
});

// ====== /verify-ticket (QR) ======
app.get('/verify-ticket', async (req, res) => {
  const sid = req.query.sid;
  if (!sid) return res.status(400).send('Missing sid');

  try {
    const s = await stripe.checkout.sessions.retrieve(sid);
    const paid = s.payment_status === 'paid';
    const code = s.metadata?.confirmation_code || 'N/D';
    const bid = s.metadata?.bookingId || 'N/D';
    const pax = s.metadata?.pax || 'N/D';
    const dateISO = s.metadata?.date || '';
    const dateStr = dateISO
      ? new Date(dateISO).toLocaleDateString('es-MX', {
          weekday: 'short',
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        })
      : 'Por confirmar';

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(`<!doctype html>
<meta charset="utf-8">
<title>Check-in | We Fly Teotihuacan</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;700;800&display=swap" rel="stylesheet">
<style>
  body{font-family:'Plus Jakarta Sans',system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,'Helvetica Neue',Arial,'Noto Sans',sans-serif;background:#0ea5e9;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#fff;border-radius:20px;max-width:480px;width:92%;padding:28px;box-shadow:0 12px 40px rgba(2,6,23,.25)}
  .ok{color:#16a34a;font-weight:800}
  .bad{color:#ef4444;font-weight:800}
  .row{display:flex;justify-content:space-between;align-items:center;margin:10px 0}
  .h1{font-size:22px;font-weight:800;color:#0f172a;margin:0 0 12px}
  .h2{font-size:14px;font-weight:700;color:#334155;margin:0 0 18px}
  .k{color:#475569;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
  .v{color:#0f172a;font-size:14px;font-weight:800}
  .brand{display:flex;align-items:center;gap:10px;margin-bottom:10px}
  .brand img{width:36px;height:36px}
  .foot{margin-top:16px;color:#334155;font-size:12px}
</style>
<div class="card">
  <div class="brand">
    <img src="https://wefly.com.mx/assets/images/logo20we20fly-256x256.webp" alt="We Fly Teotihuacan" onerror="this.style.display='none'">
    <div>
      <div class="h1">Check-in de reserva</div>
      <div class="h2">We Fly Teotihuacan</div>
    </div>
  </div>

  <div class="row"><span class="k">Estado</span><span class="v ${paid ? 'ok' : 'bad'}">${paid ? 'PAGADO ✅' : 'PENDIENTE / INVÁLIDO ❌'}</span></div>
  <div class="row"><span class="k">Código</span><span class="v">${code}</span></div>
  <div class="row"><span class="k">Booking</span><span class="v">${bid}</span></div>
  <div class="row"><span class="k">Pasajeros</span><span class="v">${pax}</span></div>
  <div class="row"><span class="k">Fecha</span><span class="v">${dateStr}</span></div>

  <div class="foot">Pide al pasajero que muestre este código en su ticket. Si hay duda, busca la reserva por session_id en Stripe.</div>
</div>`);
  } catch (e) {
    console.error('❌ /verify-ticket error:', e.message);
    return res.status(404).send('Ticket no encontrado');
  }
});

// ====== START ======
app.listen(PORT, () => {
  const key = process.env.STRIPE_SECRET_KEY || '';
  const masked = key ? `${key.slice(0, 8)}...${key.slice(-4)}` : 'NO DEFINIDA';
  console.log('✅ WeFly Stripe Server arriba');
  console.log('  Puerto:        ', PORT);
  console.log('  FRONTEND_URL:  ', FRONTEND_URL);
  console.log('  STRIPE_KEY:    ', masked);
  console.log('  Precio adulto: ', PRICE_ADULT_MXN, 'MXN');
  console.log('  Precio niño:   ', PRICE_CHILD_MXN, 'MXN');
});

