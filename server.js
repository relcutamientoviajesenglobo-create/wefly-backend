require('dotenv').config();

const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

// ==========================================
// MIDDLEWARE DE LOGGING
// ==========================================
app.use((req, res, next) => {
  console.log(`📥 ${req.method} ${req.path}`);
  console.log(`🌍 Origen: ${req.headers.origin || 'sin origen'}`);
  next();
});

// ==========================================
// CONFIGURACIÓN DE CORS
// ==========================================
const DEFAULT_ALLOWED_ORIGINS = [
  'https://wefly.com.mx',
  'https://www.wefly.com.mx',
  'http://localhost:3000',
  'http://localhost:5000',
  'http://127.0.0.1:3000'
];

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : DEFAULT_ALLOWED_ORIGINS;

const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }
    
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    
    if (origin.includes('.usercontent.goog')) {
      return callback(null, true);
    }
    
    if (origin.includes('.onrender.com')) {
      return callback(null, true);
    }
    
    console.log('⚠️ Origen rechazado:', origin);
    callback(new Error(`Origen no permitido: ${origin}`), false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

// ==========================================
// RUTAS BÁSICAS
// ==========================================
app.get('/', (_req, res) => {
  res.send('🚀 Servidor WeFly · Stripe OK');
});

app.get('/health', (_req, res) => {
  res.json({ 
    ok: true,
    stripe: !!process.env.STRIPE_SECRET_KEY,
    timestamp: new Date().toISOString()
  });
});

// ==========================================
// CREAR SESIÓN DE CHECKOUT
// ==========================================
app.post('/create-checkout-session', async (req, res) => {
  try {
    const booking = req.body || {};
    
    console.log('📋 Datos recibidos:', JSON.stringify(booking, null, 2));

    const contact = booking.contact || {};
    const addons = Array.isArray(booking.addons) ? booking.addons : [];
    
    const total = parseFloat(booking.total);
    const adults = parseInt(booking.adults || 0);
    const children = parseInt(booking.children || 0);
    const pax = adults + children;

    // VALIDACIONES
    if (isNaN(total) || total <= 0) {
      console.error('❌ Total inválido:', booking.total);
      return res.status(400).json({ 
        error: 'El total de la reserva no es válido.',
        received: booking.total
      });
    }

    if (pax <= 0) {
      console.error('❌ Pasajeros inválidos');
      return res.status(400).json({ 
        error: 'Debes seleccionar al menos un pasajero.'
      });
    }

    if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) {
      console.error('❌ Email inválido:', contact.email);
      return res.status(400).json({ 
        error: 'Email de contacto inválido.'
      });
    }

    const FRONTEND = process.env.FRONTEND_URL || 'https://wefly.com.mx';
    const flightDate = booking.date 
      ? String(booking.date).split('T')[0] 
      : new Date().toISOString().split('T')[0];

    console.log('💳 Creando sesión de Stripe...');

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
            unit_amount: Math.round(total * 100),
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
        timestamp: new Date().toISOString()
      },
    });

    console.log('✅ Sesión creada:', session.id);

    return res.json({ 
      id: session.id,
      url: session.url
    });

  } catch (err) {
    console.error('❌ Error:', err.message);
    
    return res.status(500).json({
      error: 'No se pudo crear la sesión de pago.',
      details: err?.message || 'Error desconocido',
    });
  }
});

// ==========================================
// VERIFICAR ESTADO DEL PAGO
// ==========================================
app.get('/payment-status/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    console.log('🔍 Verificando sesión:', sessionId);
    
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    
    console.log('✅ Estado:', session.payment_status);
    
    res.json({
      status: session.payment_status,
      customerEmail: session.customer_details?.email,
      amountTotal: session.amount_total / 100,
      metadata: session.metadata
    });
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ 
      error: 'No se pudo verificar el pago',
      details: error.message 
    });
  }
});

// ==========================================
// MANEJO DE ERRORES
// ==========================================
app.use((err, req, res, next) => {
  console.error('❌ Error del servidor:', err.message);
  res.status(err.status || 500).json({ 
    error: err.message || 'Error interno del servidor'
  });
});

app.use((req, res) => {
  res.status(404).json({ 
    error: 'Ruta no encontrada',
    path: req.path
  });
});

// ==========================================
// INICIAR SERVIDOR
// ==========================================
const PORT = process.env.PORT || 4242;

app.listen(PORT, () => {
  console.log('\n🚀 ========================================');
  console.log('   SERVIDOR WEFLY INICIADO');
  console.log('   ========================================');
  console.log(`   Puerto: ${PORT}`);
  console.log('   ========================================');
  console.log('   🌍 Orígenes permitidos:');
  allowedOrigins.forEach(origin => console.log(`      - ${origin}`));
  console.log('   ========================================');
  console.log(`   🔑 Stripe: ${process.env.STRIPE_SECRET_KEY ? '✅' : '❌'}`);
  console.log(`   🌐 Frontend: ${process.env.FRONTEND_URL || 'https://wefly.com.mx'}`);
  console.log('   ========================================\n');
});