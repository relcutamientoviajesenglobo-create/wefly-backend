require('dotenv').config();
const express = require('express');
const cors = require('cors');

// Valida que la clave de Stripe exista antes de iniciar
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('❌ FATAL ERROR: La variable STRIPE_SECRET_KEY no está definida en el entorno.');
  process.exit(1); // Detiene el servidor si no hay clave
}
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

// --- Configuración de CORS (Versión Final y Corregida) ---
const allowedOrigins = [
  '[https://wefly.com.mx](https://wefly.com.mx)',
  '[https://www.wefly.com.mx](https://www.wefly.com.mx)'
];

const corsOptions = {
  origin: (origin, callback) => {
    // Permite peticiones de la lista de dominios o sin origen (ej. Postman)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`Origen no permitido por CORS: ${origin}`), false);
    }
  }
};
app.use(cors(corsOptions));
app.use(express.json());

// --- Rutas de diagnóstico ---
app.get('/', (_req, res) => res.send('Servidor WEFly · Stripe OK 🚀'));

// --- Endpoint de Checkout (Versión Final) ---
app.post('/create-checkout-session', async (req, res) => {
  try {
    const booking = req.body || {};
    const contact = booking.contact || {};

    // Validaciones robustas
    if (typeof booking.total !== 'number' || booking.total <= 0) {
      console.error('Error de validación: Total inválido', booking.total);
      return res.status(400).json({ error: 'El total de la reserva no es válido.' });
    }
    const pax = (Number(booking.adults) || 0) + (Number(booking.children) || 0);
    if (pax <= 0) {
      console.error('Error de validación: No hay pasajeros');
      return res.status(400).json({ error: 'Debes seleccionar al menos un pasajero.' });
    }

    const flightDate = booking.date ? String(booking.date).split('T')[0] : 'No especificada';

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
            name: 'Vuelo en Globo en Teotihuacán',
            description: `Reserva para ${pax} pasajero(s).`,
          },
          unit_amount: Math.round(booking.total * 100),
        },
        quantity: 1,
      }],
      success_url: `https://wefly.com.mx/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://wefly.com.mx/cancel`,
      metadata: {
        nombreCliente: contact.name || 'No proporcionado',
        telefonoCliente: contact.phone || 'No proporcionado',
        fechaVuelo: flightDate,
        totalPasajeros: pax,
        totalPagado: String(booking.total),
      },
    });

    return res.json({ id: session.id });

  } catch (err) {
    console.error('❌ Error al crear la sesión de Stripe:', err.message);
    return res.status(500).json({ error: 'No se pudo crear la sesión de pago.' });
  }
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Servidor escuchando en puerto ${PORT}`));
