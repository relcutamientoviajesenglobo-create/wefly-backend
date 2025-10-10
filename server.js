// ==========================================
// SERVIDOR DE PAGOS - WEFLY
// ==========================================

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
    // Permitir peticiones sin origen (Postman, apps móviles)
    if (!origin) {
      console.log('✅ Petición sin origen (permitida)');
      return callback(null, true);
    }
    
    // Permitir dominios en lista blanca
    if (allowedOrigins.includes(origin)) {
      console.log('✅ Origen permitido:', origin);
      return callback(null, true);
    }
    
    // Permitir dominios de prueba de Google
    if (origin.includes('.usercontent.goog')) {
      console.log('✅ Dominio de prueba Google:', origin);
      return callback(null, true);
    }
    
    // Permitir dominios de Render
    if (origin.includes('.onrender.com')) {
      console.log('✅ Dominio Render:', origin);
      return callback(null, true);
    }
    
    // Rechazar otros orígenes
    console.log('⚠️ Origen rechazado:', origin);
    callback(new Error(`Origen no permitido por CORS: ${origin}`), false);
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
  res.send('🚀 Servidor WeFly · CORS OK · Stripe configurado');
});

app.get('/health', (_req, res) => {
  const stripeConfigured = !!process.env.STRIPE_SECRET_KEY;
  res.json({ 
    ok: true,
    stripe: stripeConfigured,
    timestamp: new Date().toISOString()
  });
});

// ==========================================
// ENDPOINT: CREAR SESIÓN DE CHECKOUT
// ==========================================

app.post('/create-checkout-session', async (req, res) => {
  try {
    const booking = req.body || {};
    
    console.log('📋 Datos recibidos:', JSON.stringify(booking, null, 2));

    // Extraer y limpiar datos
    const contact = booking.contact || {};
    const addons = Array.isArray(booking.addons) ? booking.addons : [];
    
    // Convertir a números (por si vienen como strings)
    const total = parseFloat(booking.total);
    const adults = parseInt(booking.adults || 0);
    const children = parseInt(booking.children || 0);
    const pax = adults + children;

    // ==========================================
    // VALIDACIONES
    // ==========================================
    
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
        error: 'Debes seleccionar al menos un pasajero.',
        adults: adults,
        children: children
      });
    }

    if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) {
      console.error('❌ Email inválido:', contact.email);
      return res.status(400).json({ 
        error: 'Email de contacto inválido.',
        received: contact.email
      });
    }

    // ==========================================
    // PREPARAR DATOS PARA STRIPE
    // ==========================================
    
    const FRONTEND = process.env.FRONTEND_URL || 'https://wefly.com.mx';
    const flightDate = booking.date 
      ? String(booking.date).split('T')[0] 
      : new Date().toISOString().split('T')[0];

    console.log('💳 Creando sesión de Stripe...');
    console.log('   Total:', total, 'MXN');
    console.log('   Adultos:', adults);
    console.log('   Niños:', children);
    console.log('   Email:', contact.email || 'sin email');

    // ==========================================
    // CREAR SESIÓN DE STRIPE CHECKOUT
    // ==========================================
    
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
        timestamp: new Date().toISOString()
      },
    });

    console.log('✅ Sesión creada exitosamente');
    console.log('   Session ID:', session.id);
    console.log('   URL:', session.url);

    return res.json({ 
      id: session.id,
      url: session.url
    });

  } catch (err) {
    console.error('❌ Error al crear sesión de Stripe:', err.message);
    console.error('   Stack:', err.stack);
    
    return res.status(500).json({
      error: 'No se pudo crear la sesión de pago.',
      details: err?.message || 'Error desconocido',
    });
  }
});

// ==========================================
// ENDPOINT: VERIFICAR ESTADO DEL PAGO
// ==========================================

app.get('/payment-status/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    console.log('🔍 Verificando sesión:', sessionId);
    
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    
    console.log('✅ Sesión encontrada');
    console.log('   Estado:', session.payment_status);
    console.log('   Total:', session.amount_total / 100, 'MXN');
    
    res.json({
      status: session.payment_status,
      customerEmail: session.customer_details?.email,
      amountTotal: session.amount_total / 100,
      metadata: session.metadata
    });
    
  } catch (error) {
    console.error('❌ Error al verificar pago:', error.message);
    res.status(500).json({ 
      error: 'No se pudo verificar el pago',
      details: error.message 
    });
  }
});

// ==========================================
// WEBHOOK DE STRIPE (OPCIONAL)
// ==========================================
// Descomentar si quieres recibir eventos de Stripe

/*
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    
    console.log('🔔 Webhook recibido:', event.type);

    // Manejar diferentes tipos de eventos
    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object;
        console.log('✅ Pago completado:', session.id);
        // Aquí puedes guardar en tu base de datos
        break;
      
      case 'payment_intent.succeeded':
        console.log('✅ Pago exitoso');
        break;
      
      case 'payment_intent.payment_failed':
        console.log('❌ Pago fallido');
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('❌ Error en webhook:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});
*/

// ==========================================
// MANEJO DE ERRORES GLOBAL
// ==========================================

app.use((err, req, res, next) => {
  console.error('❌ Error del servidor:', err.message);
  console.error('   Path:', req.path);
  console.error('   Stack:', err.stack);
  
  res.status(err.status || 500).json({ 
    error: err.message || 'Error interno del servidor',
    path: req.path
  });
});

// ==========================================
// RUTA 404
// ==========================================

app.use((req, res) => {
  res.status(404).json({ 
    error: 'Ruta no encontrada',
    path: req.path,
    method: req.method
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
  console.log(`   Entorno: ${process.env.NODE_ENV || 'development'}`);
  console.log('   ========================================');
  console.log('   🌍 Orígenes permitidos:');
  allowedOrigins.forEach(origin => console.log(`      - ${origin}`));
  console.log('   ========================================');
  console.log(`   🔑 Stripe: ${process.env.STRIPE_SECRET_KEY ? '✅ Configurado' : '❌ NO configurado'}`);
  console.log(`   🌐 Frontend: ${process.env.FRONTEND_URL || 'https://wefly.com.mx'}`);
  console.log('   ========================================\n');
});