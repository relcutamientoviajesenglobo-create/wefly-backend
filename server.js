require('dotenv').config();

const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

// ---------- MIDDLEWARE DE LOGGING ----------
app.use((req, res, next) => {
  console.log('📥 Petición recibida:', req.method, req.path);
  console.log('🌍 Origen:', req.headers.origin || 'sin origen');
  next();
});

// ---------- CORS CORREGIDO ----------
const DEFAULT_ALLOWED_ORIGINS = [
  'https://wefly.com.mx',                    // ✅ SIN corchetes ni paréntesis
  'https://www.wefly.com.mx',                // ✅ SIN corchetes ni paréntesis
  'http://localhost:3000',
  'http://localhost:5000',
  'http://127.0.0.1:3000'
];

const allowedOrigins = (process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : DEFAULT_ALLOWED_ORIGINS
);

const corsOptions = {
  origin(origin, callback) {
    // Permitir peticiones sin origen (Postman, apps móviles)
    if (!origin) {
      return callback(null, true);
    }
    
    // Permitir dominios en la lista blanca
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    
    // Permitir dominios de prueba de Google (.usercontent.goog)
    if (origin.includes('.usercontent.goog')) {
      console.log('✅ Permitiendo dominio de prueba Google:', origin);
      return callback(null, true);
    }
    
    // Permitir dominios de Render para pruebas
    if (origin.includes('.onrender.com')) {
      console.log('✅ Permitiendo dominio Render:', origin);
      return callback(null, true);
    }
    
    // Registrar orígenes rechazados
    console.log('⚠️ Origen rechazado:', origin);
    callback(new Error(`Origen no permitido por CORS: ${origin}`), false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

// ---------- RUTAS BÁSICAS ----------
app.get('/', (_req, res) => {
  res.send('Servidor WEFly · CORS OK · Stripe listo 🚀');
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------- ENDPOINT DE CHECKOUT ----------
app.post('/create-checkout-session', async (req, res) => {
  try {
    const booking = req.body || {};
    
    console.log('📥 Datos recibidos del frontend:', JSON.stringify(booking, null, 2));

    // Extraer y limpiar datos
    const contact = booking.contact || {};
    const addons = Array.isArray(booking.addons) ? booking.addons : [];
    
    // Convertir a números (por si vienen como strings)
    const total = parseFloat(booking.total);
    const adults = parseInt(booking.adults || 0);
    const children = parseInt(booking.children || 0);
    const pax = adults + children;

    // Validaciones
    if (isNaN(total) || total <= 0) {
      console.error('❌ Total inválido:', booking.total);
      return res.status(400).json({ error: 'El total de la reserva no es válido.' });
    }

    if (pax <= 0) {
      console.error('❌ Pasajeros inválidos');
      return res.status(400).json({ error: 'Debes seleccionar al menos un pasajero.' });
    }

    if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) {
      console.error('❌ Email inválido:', contact.email);
      return res.status(400).json({ error: 'Email de contacto inválido.' });
    }

    const FRONTEND = process.env.FRONTEND_URL || 'https://wefly.com.mx';
    const flightDate = booking.date ? String(booking.date).split('T')[0] : 'No especificada';

    console.log('💳 Creando sesión de Stripe con:', {
      total,
      adults,
      children,
      email: contact.email
    });

    // Crear sesión de Stripe
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
              description: `Reserva para ${adults} adulto(s) y ${children} niño(s). Fecha: ${flightDate}`,
            },
            unit_amount: Math.round(total * 100), // Convertir pesos a centavos
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
        totalPesos: String(total),
      },
    });

    console.log('✅ Sesión creada exitosamente:', session.id);
    console.log('🔗 URL de checkout:', session.url);

    return res.json({ 
      id: session.id,
      url: session.url // También enviar la URL por si acaso
    });

  } catch (err) {
    console.error('❌ Error completo:', err);
    return res.status(500).json({
      error: 'No se pudo crear la sesión de pago.',
      details: err?.message || 'Error desconocido',
    });
  }
});