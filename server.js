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
// CONFIGURACIÓN DE CORS
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
// FUNCIONES AUXILIARES
// ============================================
const validarBooking = (booking) => {
  const errores = [];

  if (!booking || typeof booking !== 'object') {
    errores.push('Datos de reserva inválidos');
    return errores;
  }

  // Validar total
  const total = Number(booking.total);
  if (!total || total <= 0 || isNaN(total)) {
    errores.push('Total debe ser mayor a 0');
  }

  // Validar pasajeros
  const adults = Number(booking.adults) || 0;
  const children = Number(booking.children) || 0;
  if (adults + children <= 0) {
    errores.push('Debe haber al menos un pasajero');
  }

  // Validar contacto
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

  // Validar fecha
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
    service: 'WEFly Stripe Server',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    stripe: 'connected'
  });
});

// Crear sesión de checkout
app.post('/create-checkout-session', async (req, res) => {
  const startTime = Date.now();

  try {
    const booking = req.body;

    // Log de la petición
    console.log('\n📝 Nueva solicitud de checkout recibida');
    console.log('Origin:', req.headers.origin || 'Sin origin');

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

    // Formatear fecha
    const flightDate = booking.date 
      ? new Date(booking.date).toISOString().split('T')[0]
      : 'No especificada';

    console.log(`📋 Reserva: ${contact.name} | ${contact.email}`);
    console.log(`👥 Pasajeros: ${adults} adulto(s), ${children} niño(s) = ${pax} total`);
    console.log(`📅 Fecha: ${flightDate}`);
    console.log(`💰 Total: $${booking.total} MXN`);

    // Preparar descripción de servicios
    let serviceDescription = `Vuelo en Globo para ${pax} pasajero(s)`;
    if (booking.addons && booking.addons.length > 0) {
      const addonsNames = booking.addons.map(a => a.name).join(', ');
      serviceDescription += ` + ${addonsNames}`;
    }

    // Crear sesión de Stripe
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: contact.email,
      billing_address_collection: 'required',
      phone_number_collection: { enabled: true },

      line_items: [{
        price_data: {
          currency: 'mxn',
          product_data: {
            name: 'Vuelo en Globo Aerostático - Teotihuacán',
            description: serviceDescription,
            images: ['[https://wefly.com.mx/assets/images/logo20we20fly-399x399.webp](https://wefly.com.mx/assets/images/logo20we20fly-399x399.webp)'],
          },
          unit_amount: Math.round(booking.total * 100), // Stripe usa centavos
        },
        quantity: 1,
      }],

      success_url: `https://wefly.com.mx/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://wefly.com.mx/cancel`,

      metadata: {
        nombreCliente: contact.name,
        emailCliente: contact.email,
        telefonoCliente: contact.phone,
        motivoVuelo: contact.reason || 'No especificado',
        fechaVuelo: flightDate,
        adultos: String(adults),
        ninos: String(children),
        totalPasajeros: String(pax),
        totalMXN: String(booking.total),
        addons: booking.addons ? JSON.stringify(booking.addons.map(a => a.name)) : '[]',
      },

      // Configuraciones adicionales
      expires_at: Math.floor(Date.now() / 1000) + (30 * 60), // Expira en 30 min
      locale: 'es',
    });

    const duration = Date.now() - startTime;
    console.log(`✅ Sesión creada: ${session.id} (${duration}ms)`);
    console.log(`🔗 URL: ${session.url}\n`);

    return res.json({ 
      id: session.id,
      url: session.url 
    });

  } catch (err) {
    console.error('\n❌ Error al crear sesión de checkout:', {
      mensaje: err.message,
      tipo: err.type,
      codigo: err.code,
      statusCode: err.statusCode
    });

    // Errores específicos de Stripe
    if (err.type === 'StripeInvalidRequestError') {
      return res.status(400).json({ 
        error: 'Solicitud inválida',
        mensaje: 'Los datos enviados no son válidos para Stripe',
        detalles: err.message 
      });
    }

    if (err.type === 'StripeAPIError') {
      return res.status(500).json({ 
        error: 'Error de Stripe',
        mensaje: 'Stripe no pudo procesar la solicitud',
      });
    }

    return res.status(500).json({ 
      error: 'Error al procesar el pago',
      mensaje: 'Por favor intenta de nuevo o contacta soporte'
    });
  }
});

// Verificar estado de sesión
app.get('/checkout-session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    console.log(`🔍 Consultando sesión: ${sessionId}`);

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    res.json({
      status: session.payment_status,
      customerEmail: session.customer_email,
      amountTotal: session.amount_total / 100,
      currency: session.currency,
      metadata: session.metadata,
      created: new Date(session.created * 1000).toISOString()
    });

  } catch (err) {
    console.error('❌ Error al recuperar sesión:', err.message);
    res.status(404).json({ 
      error: 'Sesión no encontrada',
      mensaje: 'El ID de sesión no existe o expiró'
    });
  }
});

// ============================================
// WEBHOOK DE STRIPE (IMPORTANTE)
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

  // Manejar eventos
  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object;
      console.log('💰 ¡Pago completado exitosamente!');
      console.log({
        sessionId: session.id,
        email: session.customer_email,
        monto: `$${session.amount_total / 100} ${session.currency.toUpperCase()}`,
        metadata: session.metadata
      });

      // 🔥 AQUÍ IMPLEMENTA TU LÓGICA:
      // - Guardar reserva en base de datos
      // - Enviar email de confirmación
      // - Notificar a tu equipo
      // - Actualizar inventario

      // Ejemplo:
      // await guardarReservaEnDB(session);
      // await enviarEmailConfirmacion(session.customer_email, session.metadata);
      // await notificarEquipo(session);

      break;

    case 'checkout.session.expired':
      console.log('⏱️  Sesión de checkout expirada:', event.data.object.id);
      break;

    case 'payment_intent.succeeded':
      console.log('✅ Intento de pago exitoso:', event.data.object.id);
      break;

    case 'payment_intent.payment_failed':
      const paymentIntent = event.data.object;
      console.log('❌ Pago fallido:', {
        id: paymentIntent.id,
        error: paymentIntent.last_payment_error?.message
      });
      break;

    default:
      console.log(`ℹ️  Evento no manejado: ${event.type}`);
  }

  // Confirmar recepción del webhook
  res.json({ received: true });
});

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
║     🎈 WEFly Stripe Server 🎈        ║
╚════════════════════════════════════════╝

🚀 Estado:      ACTIVO
📍 Puerto:      ${PORT}
🔐 Stripe:      ${process.env.STRIPE_SECRET_KEY ? 'Configurado' : 'NO CONFIGURADO'}
🪝 Webhook:     ${process.env.STRIPE_WEBHOOK_SECRET ? 'Configurado' : 'NO CONFIGURADO'}
🌍 Entorno:     ${process.env.NODE_ENV || 'development'}
⏰ Iniciado:    ${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}

🔗 Endpoints disponibles:
   GET  /                          → Health check
   POST /create-checkout-session   → Crear sesión de pago
   GET  /checkout-session/:id      → Consultar sesión
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