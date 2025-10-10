require('dotenv').config();

const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

// ---------- CORS CORREGIDO ----------
/**
 * Define tus orígenes permitidos sin Markdown.
 * Agrega los que uses para pruebas (por ejemplo, subdominios de Render o tu preview).
 * También puedes usar la variable ALLOWED_ORIGINS separada por comas en Render.
 */
const DEFAULT_ALLOWED_ORIGINS = [
  '[https://wefly.com.mx](https://wefly.com.mx)',
  '[https://www.wefly.com.mx](https://www.wefly.com.mx)',
  'http://localhost:3000'
];

const allowedOrigins = (process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : DEFAULT_ALLOWED_ORIGINS
);

/**
 * Permitimos peticiones solo si el Origin está en la lista.
 * OJO: requests sin Origin (p. ej., curl/cron) se aceptan.
 */
const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`Origen no permitido por CORS: ${origin}`), false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // preflight
app.use(express.json());

// ---------- RUTAS BÁSICAS ----------
app.get('/', (_req, res) => {
  res.send('Servidor WEFly · CORS OK · Stripe listo 🚀');
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------- ENDPOINT DE CHECKOUT (ÚNICO Y VALIDADO) ----------
app.post('/create-checkout-session', async (req, res) => {
  try {
    const booking = req.body || {};
    const contact = booking.contact || {};
    const addons = Array.isArray(booking.addons) ? booking.addons : [];

    // Validaciones mínimas
    if (typeof booking.total !== 'number' || booking.total <= 0) {
      return res.status(400).json({ error: 'El total de la reserva no es válido.' });
    }

    const adults = Number(booking.adults || 0);
    const children = Number(booking.children || 0);
    const pax = adults + children;
    if (pax <= 0) {
      return res.status(400).json({ error: 'Debes seleccionar al menos un pasajero.' });
    }

    // Email opcional pero recomendado: valida formato simple si llega
    if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) {
      return res.status(400).json({ error: 'Email de contacto inválido.' });
    }

    const FRONTEND = process.env.FRONTEND_URL || '[https://wefly.com.mx](https://wefly.com.mx)';
    const flightDate = booking.date ? String(booking.date).split('T')[0] : 'No especificada';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: contact.email || undefined,
      billing_address_collection: 'required',
      phone_number_collection: { enabled: true },

      line_items: [
        {
          price_data: {
            currency: 'mxn',
            product_data: {
              name: 'Vuelo en Globo en Teotihuacán',
              description: `Reserva para ${adults} adulto(s) y ${children} niño(s).`,
            },
            unit_amount: Math.round(booking.total * 100), // centavos
          },
          quantity: 1,
        },
      ],

      success_url: `${FRONTEND}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND}/cancel`,

      metadata: {
        nombreCliente: contact.name || 'No proporcionado',
        emailCliente: contact.email || 'No proporcionado',
        telefonoCliente: contact.phone || 'No proporcionado',
        fechaVuelo: flightDate,
        adultos: String(adults),
        ninos: String(children),
        adicionales: JSON.stringify(addons.map(a => a?.name).filter(Boolean)),
        total: String(booking.total),
      },
    });

    return res.json({ id: session.id });
  } catch (err) {
    console.error('❌ Error Stripe Checkout:', err);
    return res.status(500).json({
      error: 'No se pudo crear la sesión de pago.',
      details: err?.message || 'Error desconocido',
    });
  }
});

// ---------- INICIAR SERVIDOR ----------
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en ${PORT}`);
  console.log('Allowed Origins:', allowedOrigins);
});
