require('dotenv').config();
const express = require('express');
const cors = require('cors');

// ============================================
// VALIDACIONES INICIALES
// ============================================
// Valida que la clave secreta de Stripe exista antes de iniciar
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('❌ FATAL ERROR: La variable STRIPE_SECRET_KEY no está definida en el entorno.');
  process.exit(1); // Detiene el servidor si no hay clave
}
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Secreto del Webhook (OBLIGATORIO para verificar eventos de Stripe)
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
if (!endpointSecret) {
    console.warn('⚠️ ADVERTENCIA: STRIPE_WEBHOOK_SECRET no está definido. Los webhooks no serán verificados.');
}

const app = express();

// ============================================
// CONFIGURACIÓN DE CORS (Versión Final y Corregida)
// ============================================
const allowedOrigins = [
  'https://wefly.com.mx',
  'https://www.wefly.com.mx',
  'http://localhost:3000', // Puertos locales para pruebas
  'http://127.0.0.1:3000',
  'http://localhost:5500', // Puerto común para Live Server
  'http://127.0.0.1:5500'
];

const corsOptions = {
  origin: (origin, callback) => {
    // Permite peticiones de la lista de dominios o sin origen (ej. Postman, curl)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true); // Permitir
    } else {
       console.warn(`⚠️ Origen bloqueado por CORS: ${origin}`); // Loguear origen bloqueado
      callback(new Error(`Origen no permitido por CORS: ${origin}`), false); // Bloquear
    }
  },
   methods: ['GET', 'POST', 'OPTIONS'], // Asegurar OPTIONS para preflight
   allowedHeaders: ['Content-Type', 'Authorization']
};
app.use(cors(corsOptions)); // Aplicar configuración de CORS PRIMERO

// ============================================
// MIDDLEWARE
// ============================================
// Middleware para parsear JSON, EXCEPTO para la ruta del webhook
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') {
    next(); // Saltar parsing JSON para webhook, usar raw body
  } else {
    express.json()(req, res, next); // Usar parsing JSON para todas las demás rutas
  }
});

// ============================================
// RUTAS
// ============================================

// Ruta raíz para health check
app.get('/', (_req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'WEFly Stripe Server',
    timestamp: new Date().toISOString()
  });
});

// --- Endpoint para crear Payment Intent (para Stripe Elements) ---
app.post('/create-payment-intent', async (req, res) => {
  try {
    const booking = req.body || {};
    const contact = booking.contact || {}; // Asegurar que contact existe

    // --- Validaciones robustas ---
    if (typeof booking.total !== 'number' || booking.total <= 0) {
      console.error('Error de validación: Total inválido', booking.total);
      return res.status(400).json({ error: 'El total de la reserva no es válido.' });
    }
    const pax = (Number(booking.adults) || 0) + (Number(booking.children) || 0);
    if (pax <= 0) {
      console.error('Error de validación: No hay pasajeros');
      return res.status(400).json({ error: 'Debes seleccionar al menos un pasajero.' });
    }
     // Validar email si existe
     if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) {
        console.error('Error de validación: Email inválido', contact.email);
        return res.status(400).json({ error: 'Email de contacto inválido.' });
     }


    console.log(`✅ Creando Payment Intent para: $${booking.total} MXN`);
    console.log(`   Cliente: ${contact.name || 'N/A'}, Email: ${contact.email || 'N/A'}`);


    // Crear el Payment Intent en Stripe
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(booking.total * 100), // Total en centavos
      currency: 'mxn',
      automatic_payment_methods: { enabled: true }, // Stripe gestiona los métodos de pago
      // Opcional: descripción que puede aparecer en el extracto bancario (limitado)
      // statement_descriptor_suffix: 'WEFLY VueloGlobo', 
      metadata: { // Guardar información relevante de la reserva
        nombreCliente: contact.name || 'No proporcionado',
        emailCliente: contact.email || 'No proporcionado',
        telefonoCliente: contact.phone || 'No proporcionado',
        fechaVuelo: booking.date ? String(booking.date).split('T')[0] : 'No especificada',
        totalPasajeros: String(pax),
        totalPagadoMXN: String(booking.total),
        addons: booking.addons ? JSON.stringify(booking.addons.map(a => a.name)) : '[]',
      },
      // Puedes añadir receipt_email si quieres que Stripe envíe un recibo básico
       receipt_email: contact.email || undefined, 
    });

    console.log('✅ Payment Intent creado:', paymentIntent.id);
    // Enviar SOLO el client_secret al frontend
    res.send({
      clientSecret: paymentIntent.client_secret,
    });

  } catch (err) {
    console.error('❌ Error al crear Payment Intent:', err.message);
    res.status(500).json({ error: 'No se pudo iniciar el proceso de pago.' });
  }
});

// --- Endpoint de Webhook (IMPORTANTE para confirmar pagos) ---
// Usa express.raw() para obtener el cuerpo sin parsear
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    if (!endpointSecret) {
         console.error('❌ Webhook no procesado: Falta STRIPE_WEBHOOK_SECRET');
        return res.status(400).send('Webhook secret no configurado.');
    }

    try {
        // Verificar la firma del webhook
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        console.error(`❌ Error en verificación de Webhook: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log(`🎯 Webhook recibido: ${event.type}`);

    // Manejar el evento específico
    switch (event.type) {
        case 'payment_intent.succeeded':
            const paymentIntentSucceeded = event.data.object;
            console.log('💰 PaymentIntent Succeeded:', paymentIntentSucceeded.id);
            // Loguear datos importantes para tu lógica de negocio
            console.log('   Email (si Stripe lo tiene):', paymentIntentSucceeded.receipt_email || paymentIntentSucceeded.customer_details?.email); 
            console.log('   Monto:', paymentIntentSucceeded.amount / 100, paymentIntentSucceeded.currency.toUpperCase());
            console.log('   Metadata:', paymentIntentSucceeded.metadata);
            
            // 🔥 AQUÍ IMPLEMENTA TU LÓGICA DE NEGOCIO POST-PAGO:
            // -----------------------------------------------------
            // 1. **Evitar duplicados:** Busca en tu base de datos si ya procesaste este paymentIntentSucceeded.id. Si sí, responde 200 OK y sal.
            //    const yaProcesado = await db.buscarPago(paymentIntentSucceeded.id);
            //    if (yaProcesado) { break; } // Salir si ya se procesó
            
            // 2. **Obtener datos de la reserva:** Usa la metadata para encontrar/crear la reserva.
            //    const reserva = await db.crearOActualizarReserva(paymentIntentSucceeded.metadata);
            
            // 3. **Marcar como pagada:** Actualiza el estado de la reserva.
            //    await db.marcarReservaPagada(reserva.id, paymentIntentSucceeded.id);
            
            // 4. **Enviar confirmaciones:**
            //    await enviarEmailConfirmacionCliente(paymentIntentSucceeded.metadata.emailCliente, reserva);
            //    await notificarEquipoVentas(reserva);
            
            // 5. **Actualizar inventario/disponibilidad** si aplica.
            // -----------------------------------------------------
            console.log('   (Simulando lógica post-pago...)'); 
            
            break;
            
        case 'payment_intent.payment_failed':
            const paymentIntentFailed = event.data.object;
            console.log('❌ PaymentIntent Failed:', paymentIntentFailed.id);
            console.log('   Error:', paymentIntentFailed.last_payment_error?.message);
            // Opcional: Notificar al cliente o al equipo sobre el fallo. Podrías enviar un email.
            // await enviarEmailPagoFallido(paymentIntentFailed.metadata.emailCliente, paymentIntentFailed.last_payment_error?.message);
            break;
            
         case 'charge.succeeded':
             // Útil para obtener detalles del cargo si necesitas el ID del cargo (`ch_...`)
             const chargeSucceeded = event.data.object;
             console.log('✅ Charge Succeeded:', chargeSucceeded.id, 'for PaymentIntent:', chargeSucceeded.payment_intent);
             // Puedes guardar chargeSucceeded.receipt_url si quieres ofrecer un enlace al recibo de Stripe.
             break;
             
        // ... maneja otros eventos que puedan ser relevantes para tu flujo ...
        // ej. 'payment_intent.processing', 'payment_intent.canceled'
        
        default:
            console.log(`🤷 Evento no manejado: ${event.type}`);
    }

    // Devolver un 200 a Stripe para confirmar que recibiste el evento
    res.json({ received: true });
});

// ============================================
// MANEJO DE ERRORES GLOBAL (Debe ir al final)
// ============================================
app.use((err, req, res, next) => {
  // Manejar errores específicos de CORS que pueden ocurrir ANTES de las rutas
  if (err.message && err.message.includes('No permitido por CORS')) {
    console.error(`❌ Error de CORS bloqueado: Origen ${req.headers.origin || 'desconocido'}`);
    // No enviar detalles del error al cliente por seguridad
    return res.status(403).json({ error: 'Acceso denegado.' }); 
  }
  
  // Otros errores que lleguen aquí
  console.error('❌ Error no manejado en la aplicación:', err.stack || err.message);
  
  // Enviar respuesta genérica en producción
  const isDevelopment = process.env.NODE_ENV === 'development';
  res.status(500).json({ 
    error: 'Error interno del servidor.',
    // Solo mostrar detalles en desarrollo por seguridad
    details: isDevelopment ? err.message : undefined 
  });
});

// ============================================
// INICIO DEL SERVIDOR
// ============================================
const PORT = process.env.PORT || 4242;

app.listen(PORT, () => {
  console.log(`
🚀 Servidor WEFly Stripe Elements está ACTIVO 🚀
--------------------------------------------------
  Puerto:      ${PORT}
  Entorno:     ${process.env.NODE_ENV || 'development'}
  Stripe Key:  ${process.env.STRIPE_SECRET_KEY ? 'Cargada correctamente' : '¡¡NO CONFIGURADA!!'}
  Webhook Key: ${endpointSecret ? 'Cargada correctamente' : '¡¡NO CONFIGURADA!! (Requerida para producción)'}
  Orígenes CORS permitidos: ${allowedOrigins.join(', ')}
  Iniciado:    ${new Date().toLocaleString('es-MX')}
--------------------------------------------------
  Endpoints:
    GET  /                          -> Health Check
    POST /create-payment-intent   -> Iniciar Pago (Stripe Elements)
    POST /webhook                   -> Recibir eventos de Stripe
--------------------------------------------------
  `);
});

// Manejo opcional para cierre limpio
process.on('SIGTERM', () => {
  console.log('SIGTERM recibido. Cerrando servidor...');
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('SIGINT recibido (Ctrl+C). Cerrando servidor...');
  process.exit(0);
});