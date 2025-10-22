require('dotenv').config();
const express = require('express');
const cors = require('cors');

// ============================================
// VALIDACIONES INICIALES
// ============================================
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('❌ ERROR FATAL: STRIPE_SECRET_KEY no definida en .env');
  process.exit(1);
}

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express();

// ============================================
// CONFIGURACIÓN DE CORS (CORREGIDA)
// ============================================
const allowedOrigins = [
  '[https://wefly.com.mx](https://wefly.com.mx)',
  '[https://www.wefly.com.mx](https://www.wefly.com.mx)',
  'http://localhost:3000',
  '[http://127.0.0.1:3000](http://127.0.0.1:3000)',
  'http://localhost:5500',
  '[http://127.0.0.1:5500](http://127.0.0.1:5500)'
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    // Permitir dominios de vista previa (como el de Canvas)
    if (origin.endsWith('.usercontent.goog')) {
         return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`⚠️  Origen bloqueado por CORS: ${origin}`);
      callback(new Error('No permitido por CORS'));
    }
  },
  credentials: true
}));

// Middleware para raw body (necesario para webhooks de Stripe)
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ============================================
// FUNCIONES AUXILIARES (Tu validador)
// ============================================
const validarBooking = (booking) => {
  const errores = [];
  if (!booking || typeof booking !== 'object') {
    errores.push('Datos de reserva inválidos');
    return errores;
  }
  const total = Number(booking.total);
  if (!total || total <= 0 || isNaN(total)) {
    errores.push('Total debe ser mayor a 0');
  }
  const adults = Number(booking.adults) || 0;
  const children = Number(booking.children) || 0;
  if (adults + children <= 0) {
    errores.push('Debe haber al menos un pasajero');
  }
  const contact = booking.contact || {};
  if (!contact.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) {
    errores.push('Email inválido o vacío');
  }
  if (!contact.name || contact.name.trim().length < 2) {
    errores.push('Nombre debe tener al menos 2 caracteres');
  }
  if (!contact.phone || contact.phone.trim().length < 10) {
    errores.push('Teléfono debe tener al menos 10 dígitos');
  }
  if (!booking.date) {
    errores.push('Fecha de vuelo requerida');
  }
  return errores;
};

// ============================================
// RUTAS
// ============================================

// Health check
app.get('/', (_req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'WEFly Stripe Server (Elements)',
    version: '2.0.0',
    stripe: 'connected'
  });
});

// --- NUEVO ENDPOINT PARA STRIPE ELEMENTS ---
app.post('/create-payment-intent', async (req, res) => {
  const startTime = Date.now();
  try {
    const booking = req.body;
    console.log('\n📝 Nueva solicitud de Payment Intent recibida');

    // Validar datos
    const errores = validarBooking(booking);
    if (errores.length > 0) {
      console.error('❌ Validación fallida:', errores);
      return res.status(400).json({ 
        error: 'Datos inválidos',
        detalles: errores 
      });
    }

    const contact = booking.contact;
    const adults = Number(booking.adults) || 0;
    const children = Number(booking.children) || 0;
    const pax = adults + children;
    const flightDate = booking.date 
      ? new Date(booking.date).toISOString().split('T')[0]
      : 'No especificada';

    console.log(`💰 Creando Payment Intent por $${booking.total} MXN`);

    // Crear el PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(booking.total * 100), // Stripe usa centavos
      currency: 'mxn',
      payment_method_types: ['card'],
      description: `Reserva Vuelo en Globo para ${pax} pasajero(s)`,
      receipt_email: contact.email,
      metadata: {
        nombreCliente: contact.name,
        emailCliente: contact.email,
        telefonoCliente: contact.phone,
        motivoVuelo: contact.reason || 'No especificado',
        fechaVuelo: flightDate,
        totalPasajeros: String(pax),
        totalMXN: String(booking.total),
        addons: booking.addons ? JSON.stringify(booking.addons.map(a => a.name)) : '[]',
      }
    });

    const duration = Date.now() - startTime;
    console.log(`✅ Payment Intent creado: ${paymentIntent.id} (${duration}ms)`);

    // Enviar solo el client_secret al frontend
    return res.json({ 
      clientSecret: paymentIntent.client_secret 
    });

  } catch (err) {
    console.error('\n❌ Error al crear Payment Intent:', {
      mensaje: err.message,
      tipo: err.type,
    });
    return res.status(500).json({ 
      error: 'Error al procesar el pago',
      detalles: err.message
    });
  }
});


// ============================================
// WEBHOOK DE STRIPE (Sigue siendo vital)
// ============================================
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.warn('⚠️  STRIPE_WEBHOOK_SECRET no configurado');
    return res.status(500).send('Webhook no configurado correctamente');
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('❌ Webhook signature inválida:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`\n🎯 Webhook recibido: ${event.type}`);

  // Manejar eventos (AHORA NOS INTERESA 'payment_intent.succeeded')
  switch (event.type) {
    case 'payment_intent.succeeded':
      const paymentIntent = event.data.object;
      console.log('💰 ¡Pago completado exitosamente!');
      console.log({
        intentId: paymentIntent.id,
        email: paymentIntent.receipt_email,
        monto: `$${paymentIntent.amount / 100} ${paymentIntent.currency.toUpperCase()}`,
        metadata: paymentIntent.metadata
      });

      // 🔥 AQUÍ IMPLEMENTA TU LÓGICA (igual que antes):
      // - Guardar reserva en base de datos
      // - Enviar email de confirmación

      break;

    case 'payment_intent.payment_failed':
      console.log('❌ Pago fallido:', {
        id: event.data.object.id,
        error: event.data.object.last_payment_error?.message
      });
      break;

    // Aún es bueno escuchar el de checkout por si acaso
    case 'checkout.session.completed':
      console.log('ℹ️  Evento de Checkout Session completado (flujo antiguo o diferente)');
      break;

    default:
      console.log(`ℹ️  Evento no manejado: ${event.type}`);
  }

  res.json({ received: true });
});

// ... (El resto de tu excelente código de manejo de errores y startup) ...

// ============================================
// MANEJO DE ERRORES GLOBAL
// ============================================
app.use((err, req, res, next) => {
  console.error('\n❌ Error no manejado:');
  console.error(err.stack);

  res.status(500).json({ 
    error: 'Error interno del servidor',
    mensaje: process.env.NODE_ENV === 'development' 
      ? err.message 
      : 'Algo salió mal. Por favor contacta soporte.'
  });
});

// Ruta 404
app.use((req, res) => {
  res.status(404).json({
    error: 'Ruta no encontrada',
    path: req.path
  });
});

// ============================================
// INICIO DEL SERVIDOR
// ============================================
const PORT = process.env.PORT || 4242;

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   🎈 WEFly Stripe Server (Elements) 🎈 ║
╚════════════════════════════════════════╝

🚀 Estado:      ACTIVO
📍 Puerto:      ${PORT}
🔐 Stripe:      ${process.env.STRIPE_SECRET_KEY ? 'Configurado' : 'NO CONFIGURADO'}
🪝 Webhook:     ${process.env.STRIPE_WEBHOOK_SECRET ? 'Configurado' : 'NO CONFIGURADO'}
🌍 Entorno:     ${process.env.NODE_ENV || 'development'}
⏰ Iniciado:    ${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}

🔗 Endpoints disponibles:
   GET  /                          → Health check
   POST /create-payment-intent     → Crear intención de pago (Elements)
   POST /webhook                   → Webhook de Stripe

📝 Logs: Todos los eventos se registran en consola
  `);
});

// Manejo de cierre graceful
process.on('SIGTERM', () => {
  console.log('\n👋 Señal SIGTERM recibida. Cerrando servidor...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n👋 Señal SIGINT recibida. Cerrando servidor...');
  process.exit(0);
});

// Manejo de errores no capturados
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promesa rechazada no manejada:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Excepción no capturada:', error);
  process.exit(1);
});