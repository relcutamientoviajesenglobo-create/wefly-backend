/**
 * server.js — We Fly Teotihuacán
 * - Stripe Checkout (create-checkout-session)
 * - Webhook firmado (checkout.session.completed) -> envía email con SendGrid
 * - Generación de código de confirmación (WFT-YYYYMMDD-XXXXXX)
 * - Endpoint para consultar por session_id (mostrar confirmation_code en UI)
 * - Endpoint de verificación por QR: /verify/:code (busca PI por metadata)
 * - CORS, robots.txt, status, security.txt y logs
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const os = require('os');
const bodyParser = require('body-parser'); // raw para webhook
const { customAlphabet } = require('nanoid');
const sgMail = require('@sendgrid/mail');

if (!process.env.STRIPE_SECRET_KEY) {
  console.error('❌ Falta STRIPE_SECRET_KEY');
  process.exit(1);
}
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;
const START_TIME = Date.now();

// ====== SendGrid ======
if (!process.env.SENDGRID_API_KEY) {
  console.warn('⚠️  Falta SENDGRID_API_KEY en variables de entorno');
}
sgMail.setApiKey(process.env.SENDGRID_API_KEY || '');

// ====== CORS ======
const allowedOrigins = [
  'https://wefly.com.mx',
  'https://www.wefly.com.mx',
  'https://vuelosenglobo.mx',
  'https://www.vuelosenglobo.mx',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowedOrigins.includes(origin)) cb(null, true);
      else cb(new Error(`CORS bloqueado para origen: ${origin}`), false);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// ====== Webhook (RAW) ======
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

        // Metadata que enviamos al crear la sesión
        const bookingId = session.metadata?.bookingId;
        const confirmationCode = session.metadata?.confirmation_code;

        // Datos del cliente
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

        let services = 'Vuelo en Globo';

        // Enviar correo al cliente
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
            '⚠️  Falta SENDGRID_TEMPLATE_ID o email del cliente para enviar correo.'
          );
        }

        // Copia interna al staff
        const staffInbox =
          process.env.BOOKINGS_INBOX || 'info@wefly.com.mx'; // fallback
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
      }

      res.json({ received: true });
    } catch (e) {
      console.error('❌ Error procesando webhook:', e);
      res.status(500).send('Webhook handler failed.');
    }
  }
);

// ====== JSON parser para el resto ======
app.use(express.json());

// ====== UTILS ======
const PRICES = { adult: 2500, child: 2200 };

// Genera código: WFT-YYYYMMDD-XXXXXX (sin O/0, I/1, etc.)
const nano = customAlphabet('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 6);
function buildConfirmationCode(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `WFT-${y}${m}${d}-${nano()}`;
}

function computeTotalMXN(booking) {
  const adults = Number(booking.adults) || 0;
  const children = Number(booking.children) || 0;
  const base = adults * PRICES.adult + children * PRICES.child;
  const pax = adults + children;

  let addonsTotal = 0;
  (booking.addons || []).forEach((a) => {
    const price = Number(a.price) || 0;
    addonsTotal += a.name === 'Desayuno en La Cueva' ? price * pax : price;
  });

  return base + addonsTotal;
}

async function sendBookingEmail({ to, templateId, dynamicData, from }) {
  if (!process.env.SENDGRID_API_KEY || !templateId || !to) return;
  const msg = {
    to,
    from: from || 'We Fly Teotihuacan <info@wefly.com.mx>',
    templateId,
    dynamic_template_data: dynamicData,
  };
  await sgMail.send(msg);
}

// ====== Health / Warm-up ======
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'WeFly Stripe Server',
    time: new Date().toISOString(),
  });
});

// ====== Crear sesión de checkout ======
app.post('/create-checkout-session', async (req, res) => {
  try {
    const booking = req.body || {};

    // Validaciones
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

    // IDs y confirmación
    const bookingId = `BKG_${Date.now()}`;
    const confDate = booking?.date ? new Date(booking.date) : new Date();
    const confirmationCode = buildConfirmationCode(confDate);

    // Sesión de Stripe
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      currency: 'mxn',
      line_items: [
        {
          price_data: {
            currency: 'mxn',
            product_data: { name: 'Vuelo en Globo + Adicionales' },
            unit_amount: Math.round(totalMXN * 100),
          },
          quantity: 1,
        },
      ],
      // metadata en la sesión
      metadata: {
        bookingId,
        confirmation_code: confirmationCode,
        customer_name: booking?.contact?.name || '',
        customer_email: booking?.contact?.email || '',
        customer_phone: booking?.contact?.phone || '',
        pax: String(adults + children),
        date: booking?.date ? String(booking.date) : '',
        brand: 'We Fly Teotihuacan',
      },
      // también en el PaymentIntent (para poder verificar por QR)
      payment_intent_data: {
        description: `Reserva We Fly Teotihuacan — ${confirmationCode}`,
        metadata: {
          bookingId,
          confirmation_code: confirmationCode,
          pax: String(adults + children),
          date: booking?.date ? String(booking.date) : '',
          brand: 'We Fly Teotihuacan',
        },
      },
      client_reference_id: bookingId,
      success_url:
        'https://wefly.com.mx/?checkout=success&bid={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://wefly.com.mx/?checkout=cancel',
    });

    res.json({ url: session.url, bookingId });
  } catch (err) {
    console.error('❌ Error creando sesión:', err);
    res
      .status(400)
      .json({ error: err.message || 'No se pudo crear la sesión.' });
  }
});

// ====== Consultar por sessionId (mostrar confirmation_code en UI) ======
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
      brand: session.metadata?.brand || 'We Fly Teotihuacan',
    });
  } catch (e) {
    console.error('❌ Error consultando sesión:', e);
    res.status(404).json({ error: 'Not found' });
  }
});

// ====== Verificación por QR ======
// Busca PaymentIntents por metadata['confirmation_code'] usando el Search API
app.get('/verify/:code', async (req, res) => {
  try {
    const code = req.params.code;
    // Busca el PaymentIntent por metadata.confirmation_code
    let piFound = null;

    try {
      const search = await stripe.paymentIntents.search({
        query: `metadata['confirmation_code']:'${code}'`,
        limit: 1,
      });
      if (search?.data?.length) piFound = search.data[0];
    } catch (err) {
      console.warn('Search API no disponible para PaymentIntents:', err.message);
    }

    if (!piFound) {
      // Fallback: 404
      res.status(404).send(`
        <!doctype html><meta charset="utf-8">
        <title>Verificación — We Fly Teotihuacan</title>
        <style>body{font-family:ui-sans-serif; background:#0f172a; color:#e5e7eb; padding:24px} .card{max-width:700px;margin:0 auto;background:#111827;border:1px solid #1f2937;border-radius:16px;padding:24px}</style>
        <div class="card">
          <h1>Verificación</h1>
          <p>No encontramos la confirmación <strong>${code}</strong>.</p>
          <p>Si crees que es un error, muestra tu correo de confirmación de <b>We Fly Teotihuacan</b>.</p>
        </div>
      `);
      return;
    }

    const paid =
      piFound.status === 'succeeded' || piFound.status === 'requires_capture';
    const bookingId = piFound.metadata?.bookingId || '—';
    const pax = piFound.metadata?.pax || '—';
    const dateISO = piFound.metadata?.date || '';
    const dateStr = dateISO
      ? new Date(dateISO).toLocaleDateString('es-MX', {
          weekday: 'short',
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        })
      : 'Por confirmar';
    const brand = piFound.metadata?.brand || 'We Fly Teotihuacan';

    res.send(`
      <!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Verificación — ${brand}</title>
      <style>
        body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Inter,Roboto,Arial;background:#0f172a;color:#e5e7eb;margin:0;padding:24px}
        .card{max-width:720px;margin:0 auto;background:#111827;border:1px solid #1f2937;border-radius:16px;padding:24px;box-shadow:0 10px 30px rgba(0,0,0,.4)}
        .ok{color:#22c55e;font-weight:700}
        .bad{color:#ef4444;font-weight:700}
        .row{display:flex;justify-content:space-between;border-top:1px dashed #374151;padding:10px 0}
      </style>
      <div class="card">
        <h1>Verificación de Reserva — ${brand}</h1>
        <div class="row"><span>Código</span><span>${code}</span></div>
        <div class="row"><span>Booking ID</span><span>${bookingId}</span></div>
        <div class="row"><span>Pax</span><span>${pax}</span></div>
        <div class="row"><span>Fecha</span><span>${dateStr}</span></div>
        <div class="row"><span>Estado de pago</span><span class="${paid ? 'ok' : 'bad'}">${paid ? 'PAGADO' : 'NO PAGADO'}</span></div>
        <p style="margin-top:16px;color:#9ca3af">Marca: ${brand}</p>
      </div>
    `);
  } catch (err) {
    console.error('❌ Error /verify:', err);
    res.status(500).send('Error de verificación.');
  }
});

// ====== robots.txt ======
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain; charset=utf-8');
  const site = process.env.FRONTEND_URL || 'https://wefly.com.mx';
  res.send(
    [
      'User-agent: *',
      'Allow: /',
      'Disallow: /stripe-webhook',
      'Disallow: /booking/',
      'Disallow: /verify/',
      '',
      `Sitemap: ${site.replace(/\/$/, '')}/sitemap.xml`,
      '',
    ].join('\n')
  );
});

// ====== security.txt ======
app.get(['/security.txt', '/.well-known/security.txt'], (_req, res) => {
  res.type('text/plain; charset=utf-8');
  res.send(
    [
      'Contact: mailto:info@wefly.com.mx',
      'Policy: https://wefly.com.mx/politica-de-privacidad/',
      'Preferred-Languages: es, en',
      '',
    ].join('\n')
  );
});

// ====== status ======
app.get('/status', (req, res) => {
  const uptimeSec = Math.round((Date.now() - START_TIME) / 1000);
  res.json({
    ok: true,
    service: 'WeFly Stripe Server',
    version: process.env.APP_VERSION || '1.0.0',
    node: process.version,
    platform: `${os.platform()}-${os.arch()}`,
    region:
      process.env.RENDER_REGION ||
      process.env.FLY_REGION ||
      process.env.VERCEL_REGION ||
      null,
    env: process.env.NODE_ENV || 'development',
    uptime_seconds: uptimeSec,
    now: new Date().toISOString(),
    health: {
      stripe_key: !!process.env.STRIPE_SECRET_KEY,
      webhook_secret: !!process.env.STRIPE_WEBHOOK_SECRET,
      sendgrid_key: !!process.env.SENDGRID_API_KEY,
      sendgrid_template: !!process.env.SENDGRID_TEMPLATE_ID,
    },
  });
});

app.get('/status/html', (req, res) => {
  const uptimeSec = Math.round((Date.now() - START_TIME) / 1000);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`
<!doctype html>
<html lang="es"><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Status — We Fly Teotihuacan</title>
<style>
  body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial;background:#0f172a;color:#e5e7eb;margin:0;padding:24px}
  .card{max-width:760px;margin:0 auto;background:#111827;border:1px solid #1f2937;border-radius:16px;padding:24px;box-shadow:0 10px 30px rgba(0,0,0,.4)}
  h1{margin:0 0 8px;font-size:22px}
  .row{display:flex;justify-content:space-between;border-top:1px dashed #374151;padding:10px 0}
  .ok{color:#22c55e;font-weight:700}
  .bad{color:#ef4444;font-weight:700}
</style>
<div class="card">
  <h1>Status <span style="color:#9ca3af">We Fly Teotihuacan</span></h1>
  <div class="row"><span>Versión</span><span>${process.env.APP_VERSION || '1.0.0'}</span></div>
  <div class="row"><span>Node</span><span>${process.version}</span></div>
  <div class="row"><span>Plataforma</span><span>${os.platform()}-${os.arch()}</span></div>
  <div class="row"><span>Región</span><span>${process.env.RENDER_REGION || process.env.FLY_REGION || process.env.VERCEL_REGION || '—'}</span></div>
  <div class="row"><span>Entorno</span><span>${process.env.NODE_ENV || 'development'}</span></div>
  <div class="row"><span>Uptime</span><span>${uptimeSec}s</span></div>
  <div class="row"><span>Stripe Key</span><span class="${process.env.STRIPE_SECRET_KEY ? 'ok' : 'bad'}">${process.env.STRIPE_SECRET_KEY ? 'OK' : 'FALTA'}</span></div>
  <div class="row"><span>Webhook Secret</span><span class="${process.env.STRIPE_WEBHOOK_SECRET ? 'ok' : 'bad'}">${process.env.STRIPE_WEBHOOK_SECRET ? 'OK' : 'FALTA'}</span></div>
  <div class="row"><span>SendGrid Key</span><span class="${process.env.SENDGRID_API_KEY ? 'ok' : 'bad'}">${process.env.SENDGRID_API_KEY ? 'OK' : 'FALTA'}</span></div>
  <div class="row"><span>SendGrid Template</span><span class="${process.env.SENDGRID_TEMPLATE_ID ? 'ok' : 'bad'}">${process.env.SENDGRID_TEMPLATE_ID ? 'OK' : 'FALTA'}</span></div>
</div>
</html>`);
});

// ====== START ======
app.listen(PORT, () => {
  console.log(`✅ WeFly Stripe Server arriba en puerto ${PORT}`);
});
