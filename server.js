require('dotenv').config();
// --- 1. Importar las herramientas ---
const express = require('express');
const cors = require('cors');
// La clave secreta se leerá desde las variables de entorno de Render
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// --- 2. Crear la aplicación del servidor ---
const app = express();

// --- 3. Configurar CORS de forma más permisiva y funcional ---
const allowedOrigins = [
  '[https://wefly.com.mx](https://wefly.com.mx)',
  '[https://www.wefly.com.mx](https://www.wefly.com.mx)',
  'http://localhost:3000',
  'http://localhost:5000',
  '[http://127.0.0.1:3000](http://127.0.0.1:3000)',
  '[http://127.0.0.1:5000](http://127.0.0.1:5000)'
];

const corsOptions = {
  origin: (origin, callback) => {
    // Permitir peticiones sin origen (Postman, apps móviles, etc.)
    if (!origin) {
      return callback(null, true);
    }

    // Permitir dominios de la lista
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // Permitir dominios de prueba de Google (usercontent.goog)
    if (origin.includes('.usercontent.goog')) {
      return callback(null, true);
    }

    // Permitir dominios de Render para pruebas
    if (origin.includes('.onrender.com')) {
      return callback(null, true);
    }

    // Si nada coincide, permitir de todos modos (TEMPORAL para debugging)
    console.log('⚠️ Origen no en lista blanca:', origin);
    return callback(null, true);
  },
  credentials: true, // Importante si usas cookies o auth
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));


// --- 4. Configurar Middleware Adicional ---
app.use(express.json()); // Permite al servidor entender los datos JSON

// --- 5. Crear el Endpoint de Pago ---
app.post('/create-checkout-session', async (req, res) => {
  try {
    const bookingDetails = req.body;

    // --- VALIDACIÓN DE SEGURIDAD MEJORADA ---
    if (!bookingDetails.total || typeof bookingDetails.total !== 'number' || bookingDetails.total <= 0) {
      console.error('❌ Intento de pago con total inválido:', bookingDetails.total);
      return res.status(400).json({
        error: 'El total de la reserva no es válido.'
      });
    }

    // --- VALIDACIÓN DE DATOS CORRECTA ---
    const totalPassengers = (bookingDetails.adults || 0) + (bookingDetails.children || 0);
    if (totalPassengers <= 0) {
        console.error('❌ Faltan datos de la reserva: no hay pasajeros seleccionados.');
        return res.status(400).json({
            error: 'Debes seleccionar al menos un pasajero.'
        });
    }

    console.log('✅ Creando sesión de Stripe para:', bookingDetails);

    // Crear la sesión de Stripe Checkout con el formato price_data correcto
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'mxn',
          product_data: {
            name: 'Vuelo en Globo en Teotihuacán',
            description: `Reserva para ${bookingDetails.adults} adulto(s) y ${bookingDetails.children} niño(s).`,
          },
          unit_amount: Math.round(bookingDetails.total * 100), // Usamos 'unit_amount' dentro de 'price_data'
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL || 'https://wefly.com.mx'}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'https://wefly.com.mx'}/cancel`,
      metadata: {
        nombreCliente: bookingDetails.contact.name,
        emailCliente: bookingDetails.contact.email,
        telefonoCliente: bookingDetails.contact.phone,
        fechaVuelo: bookingDetails.date ? bookingDetails.date.split('T')[0] : 'No especificada',
        adultos: bookingDetails.adults,
        ninos: bookingDetails.children,
        adicionales: JSON.stringify(bookingDetails.addons.map(a => a.name)),
        total: bookingDetails.total.toString()
      }
    });

    console.log('✅ Sesión creada exitosamente:', session.id);
    res.json({ id: session.id });

  } catch (error) {
    console.error("❌ Error al crear la sesión de Stripe:", error.message);
    res.status(500).json({
      error: 'No se pudo crear la sesión de pago.',
      details: error.message
    });
  }
});


// --- 6. Iniciar el servidor ---
// Render provee la variable PORT automáticamente.
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Servidor escuchando en el puerto ${PORT}`));
