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

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
    
      // --- INICIO DE LÍNEAS NUEVAS ---
      // Hacemos que la dirección de facturación (que incluye el nombre) sea obligatoria.
      billing_address_collection: 'required', 
      // Habilitamos la recolección del número de teléfono.
      phone_number_collection: { enabled: true }, 
      // Pasamos el email para que aparezca pre-llenado en el formulario de Stripe.
      customer_email: bookingDetails.contact.email, 
      // --- FIN DE LÍNEAS NUEVAS ---
    
      line_items: [{
        price_data: {
          currency: 'mxn',
          product_data: {
            name: 'Vuelo en Globo We Fly',
            description: `Reserva para ${bookingDetails.adults} adulto(s) y ${bookingDetails.children} niño(s).`
          },
          unit_amount: Math.round(bookingDetails.total * 100),
        },
        quantity: 1,
      }],
      metadata: {
        nombreCliente: bookingDetails.contact.name,
        emailCliente: bookingDetails.contact.email,
        telefonoCliente: bookingDetails.contact.phone,
        fechaVuelo: bookingDetails.date.split('T')[0],
        adultos: bookingDetails.adults,
        ninos: bookingDetails.children,
        adicionales: JSON.stringify(bookingDetails.addons.map(a => a.name)),
      },
      success_url: `https://wefly.com.mx/gracias-por-tu-compra`,
      cancel_url: `https://wefly.com.mx/pago-cancelado`,
    });

    res.json({ id: session.id });

  } catch (error) {
    console.error("Error al crear la sesión de Stripe:", error);
    res.status(500).json({ error: 'No se pudo crear la sesión de pago.' });
  }
});

// --- 6. Iniciar el servidor ---
// Render provee la variable PORT automáticamente.
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Servidor escuchando en el puerto ${PORT}`));
