/**
 * server.js — FINAL
 * We Fly Teotihuacán
 * - Stripe Checkout (create-checkout-session)
 * - Webhook firmado (checkout.session.completed) -> SendGrid
 * - Generación de código de confirmación (WFT-YYYYMMDD-XXXXXX)
 * - Guarda en Supabase la reserva (pending -> paid)
 * - Endpoint /booking/by-session/:sessionId (para mostrar el código en el front)
 * - Endpoint /verify-ticket?code=... (para tu staff / móvil día de vuelo)
 * - CORS y health
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser'); // para webhook raw
const { customAlphabet } = require('nanoid');
const sgMail = require('@sendgrid/mail');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Supabase client (versión simple con fetch)
const { createClient } = require('@supabase/supabase-js');

// ====== CONFIG ======
const app = express();
const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://wefly.com.mx';
const QR_SIGNING_SECRET = process.env.QR_SIGNING_SECRET || 'change-this';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Supabase client con service role (solo en el server)
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

// SendGrid
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
} else {
  console.warn('⚠️ Falta SENDGRID_API_KEY en .env');
}

// CORS
const allowedOrigins = [
  'https://wefly.com.mx',
  'https://www.wefly.com.mx',
  'https://vuelosenglobo.mx',
  'https://wefly.com.mx:443',
  // agrega más si los usas
];
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error('CORS bloqueado para origen: ' + origin));
    },
  })
);

// WEBHOOK necesita RAW
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

        // 1) Guarda en Supabase como "paid"
        if (supabase && bookingId) {
          const flightDate =
            dateISO && dateISO.length >= 10 ? dateISO.slice(0, 10) : null;
          await supabase
            .from('bookings')
            .upsert(
              {
                booking_id: bookingId,
                confirmation_code: confirmationCode,
                stripe_session_id: session.id,
                customer_name,
                customer_email,
                customer_phone: session.metadata?.customer_phone || '',
                pax: Number(pax) || 0,
                flight_date: flightDate,
                total_mxn: totalMXN || null,
                status: 'paid',
              },
              { onConflict: 'booking_id' }
            )
            .then(({ error }) => {
              if (error) {
                console.error('❌ Supabase upsert (webhook):', error);
              }
            });
        }

        // 2) Enviar correo al cliente
        const services = 'Vuelo en Globo We Fly Teotihuacan';
        if (
          process.env.SENDGRID_TEMPLATE_ID &&
          process.env.SENDGRID_API_KEY &&
          customer_email
        ) {
          try {
            await sgMail.send({
              to: customer_email,
              from: 'We Fly Teotihuacan <info@wefly.com.mx>',
              templateId: process.env.SENDGRID_TEMPLATE_ID,
              dynamic_template_data: {
                customer_name,
                confirmation_code: confirmationCode,
                date: dateStr,
                pax: String(pax),
                total_formatted:
                  totalMXN !== undefined
                    ? `$${Number(totalMXN).toLocaleString('es-MX')} MXN`
                    : '',
                services,
                maps_text: 'We Fly Teotihuacan',
              },
            });
          } catch (e) {
            console.error('❌ Error enviando email cliente:', e);
          }
        }

        // 3) Copia interna
        const staffInbox =
          process.env.BOOKINGS_INBOX || 'info@wefly.com.mx';
        const staffTpl =
          process.env.SENDGRID_TEMPLATE_ID_STAFF ||
          process.env.SENDGRID_TEMPLATE_ID;
        if (staffTpl && staffInbox && process.env.SENDGRID_API_KEY) {
          try {
            await sgMail.send({
              to: staffInbox,
              from: 'Reservas We Fly <info@wefly.com.mx>',
              templateId: staffTpl,
              dynamic_template_data: {
                customer_name,
                confirmation_code: confirmationCode,
                date: dateStr,
                pax: String(pax),
                total_formatted:
                  totalMXN !== undefined
                    ? `$${Number(totalMXN).toLocaleString('es-MX')} MXN`
                    : '',
                services,
                maps_text: 'We Fly Teotihuacan',
              },
            });
          } catch (e) {
            console.error('❌ Error enviando email staff:', e);
          }
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

// nanoid para códigos sin confusión
const nano = customAlphabet('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 6);
function buildConfirmationCode(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `WFT-${y}${m}${d}-${nano()}`;
}

// total como en el front
const PRICES = { adult: 2500, child: 2200 };
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

// ====== RUTAS ======

// health
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'WeFly Stripe Server',
    time: new Date().toISOString(),
  });
});

app.get('/status', (_req, res) => {
  res.send('<h1>We Fly Teotihuacan — Stripe Server OK ✅</h1>');
});

// crear sesión checkout
app.post('/create-checkout-session', async (req, res) => {
  try {
    const booking = req.body || {};
    const adults = Number(booking.adults) || 0;
    const children = Number(booking.children) || 0;

    if (adults + children <= 0) {
      return res.status(400).json({ error: 'Debes seleccionar al menos 1 pasajero.' });
    }

    const totalMXN = computeTotalMXN(booking);
    if (!(totalMXN > 0)) {
      return res.status(400).json({ error: 'Total inválido.' });
    }

    const bookingId = `BKG_${Date.now()}`;
    const confDate = booking?.date ? new Date(booking.date) : new Date();
    const confirmationCode = buildConfirmationCode(confDate);

    // crear sesión stripe
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
      success_url: `${FRONTEND_URL}/?checkout=success&bid={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/?checkout=cancel`,
      payment_method_types: ['card', 'oxxo', 'paypal'],
      payment_method_options: {
        oxxo: { expires_after_days: 2 },
      },
    });

    // guardamos ya en Supabase como pending
    if (supabase) {
      const flightDate =
        booking?.date && booking.date.length >= 10
          ? booking.date.slice(0, 10)
          : null;

      const { error } = await supabase.from('bookings').insert({
        booking_id: bookingId,
        confirmation_code: confirmationCode,
        stripe_session_id: session.id,
        customer_name: booking?.contact?.name || '',
        customer_email: booking?.contact?.email || '',
        customer_phone: booking?.contact?.phone || '',
        pax: adults + children,
        flight_date: flightDate,
        total_mxn: totalMXN,
        status: 'pending',
      });
      if (error) {
        console.error('❌ Supabase insert (create-checkout-session):', error);
      }
    }

    res.json({ url: session.url, bookingId });
  } catch (err) {
    console.error('❌ Error creando sesión:', err);
    res.status(400).json({ error: err.message || 'No se pudo crear la sesión.' });
  }
});

// consultar por sessionId (para mostrar el código en UI)
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
      brand: 'We Fly Teotihuacan',
    });
  } catch (e) {
    console.error('❌ Error consultando sesión:', e);
    res.status(404).json({ error: 'Not found' });
  }
});

// verify-ticket (para el QR)
app.get('/verify-ticket', async (req, res) => {
  try {
    const code = (req.query.code || '').trim();
    if (!code) {
      return res.status(400).send('<h1>400 — Falta el código</h1>');
    }

    // buscar en Supabase
    if (!supabase) {
      return res.status(500).send('<h1>500 — Supabase no configurado</h1>');
    }

    const { data, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('confirmation_code', code)
      .maybeSingle();

    if (error) {
      console.error('❌ Supabase error /verify-ticket:', error);
      return res.status(500).send('<h1>500 — Error al consultar</h1>');
    }

    if (!data) {
      return res
        .status(404)
        .send(
          `<html><body style="font-family:system-ui;background:#fee2e2;padding:2rem;"><h1 style="color:#b91c1c;">❌ Código no encontrado</h1><p>Revisa que el código sea correcto.</p></body></html>`
        );
    }

    const isToday =
      data.flight_date &&
      data.flight_date.toString() ===
        new Date().toISOString().slice(0, 10).toString();

    const okColor = '#0f766e';
    const warnColor = '#b45309';
    const bg = isToday ? '#ecfdf3' : '#fef9c3';
    const color = isToday ? okColor : warnColor;
    const status = data.status;

    // actualizar a checked_in si venimos del QR (opcional)
    if (status === 'paid') {
      await supabase
        .from('bookings')
        .update({ status: 'checked_in' })
        .eq('id', data.id);
    }

    res.send(`
      <html>
        <head>
          <meta charset="UTF-8" />
          <title>We Fly Teotihuacan - Verificación</title>
          <meta name="viewport" content="width=device-width,initial-scale=1" />
        </head>
        <body style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:${bg}; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:1.5rem;">
          <div style="background:white; border-radius:1.5rem; padding:1.5rem 1.75rem; width:100%; max-width:420px; box-shadow:0 20px 40px rgba(15,23,42,0.15); text-align:center;">
            <img src="https://wefly.com.mx/assets/images/logo20we20fly-256x256.webp" alt="We Fly Teotihuacan" style="width:72px;height:72px;object-fit:contain;margin:0 auto 1rem;border-radius:9999px;background:#1a72f6;padding:6px;" />
            <p style="font-size:.75rem; color:#94a3b8; letter-spacing:.06em; text-transform:uppercase;">We Fly Teotihuacan • Check-in</p>
            <h1 style="font-size:1.5rem; font-weight:700; margin-top:.25rem; margin-bottom:1rem; color:${color};">Código válido ✅</h1>
            <p style="font-size:.875rem; color:#475569; margin-bottom:1rem;">${data.customer_name || 'Pasajero'} — ${data.customer_email || ''}</p>
            <div style="background:#f8fafc; border-radius:1.25rem; padding:1rem; margin-bottom:1rem; border:1px solid rgba(148,163,184,0.25);">
              <p style="font-size:.75rem; text-transform:uppercase; color:#94a3b8; margin-bottom:.25rem;">Código de confirmación</p>
              <p style="font-size:1.25rem; font-weight:800; letter-spacing:.08em; color:#0f172a;">${data.confirmation_code}</p>
            </div>
            <div style="display:flex; gap:.75rem; margin-bottom:1rem;">
              <div style="flex:1; background:white; border:1px solid rgba(148,163,184,0.35); border-radius:1rem; padding:.5rem;">
                <p style="font-size:.6rem; text-transform:uppercase; color:#94a3b8; margin:0;">Pasajeros</p>
                <p style="font-weight:700; color:#0f172a; margin:0;">${data.pax || 0}</p>
              </div>
              <div style="flex:1; background:white; border:1px solid rgba(148,163,184,0.35); border-radius:1rem; padding:.5rem;">
                <p style="font-size:.6rem; text-transform:uppercase; color:#94a3b8; margin:0;">Fecha</p>
                <p style="font-weight:700; color:#0f172a; margin:0;">${data.flight_date || 'Por confirmar'}</p>
              </div>
              <div style="flex:1; background:white; border:1px solid rgba(148,163,184,0.35); border-radius:1rem; padding:.5rem;">
                <p style="font-size:.6rem; text-transform:uppercase; color:#94a3b8; margin:0;">Estatus</p>
                <p style="font-weight:700; color:#0f172a; margin:0;">${status}</p>
              </div>
            </div>
            <p style="font-size:.75rem; color:#94a3b8;">Ubícanos en Google Maps como <strong>We Fly Teotihuacan</strong></p>
          </div>
        </body>
      </html>
    `);
  } catch (e) {
    console.error('❌ /verify-ticket error:', e);
    res.status(500).send('<h1>500 — Error interno</h1>');
  }
});

// start
app.listen(PORT, () => {
  console.log(`✅ WeFly Stripe Server arriba en puerto ${PORT}`);
});
