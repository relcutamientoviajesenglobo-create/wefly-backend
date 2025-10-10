require('dotenv').config();
// --- 1. Importar las herramientas ---
const express = require('express');
const cors = require('cors');
// La clave secreta se leerá desde las variables de entorno de Render
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// --- 2. Crear la aplicación del servidor ---
const app = express();

// --- 3. Configurar CORS (Versión Final y Corregida) ---
const allowedOrigins = [
  '[https://wefly.com.mx](https://wefly.com.mx)',
  '[https://www.wefly.com.mx](https://www.wefly.com.mx)'
];
const corsOptions = {
  origin: allowedOrigins
};
app.use(cors(corsOptions));

app.use(express.json());

// --- 4. Crear el Endpoint de Pago (Versión Final y Corregida) ---
app.post('/create-checkout-session', async (req, res) => {
  try {
    const bookingDetails = req.body;

    // --- Validaciones de seguridad ---
    if (!bookingDetails.total || typeof bookingDetails.total !== 'number' || bookingDetails.total <= 0) {
      console.error('❌ Intento de pago con total inválido:', bookingDetails.total);
      return res.status(400).json({ error: 'El total de la reserva no es válido.' });
    }

    console.log('✅ Creando sesión de Stripe para:', bookingDetails);

    // --- Crear la sesión de Stripe con el formato correcto ---
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: bookingDetails.contact.email,
      billing_address_collection: 'required',
      phone_number_collection: { enabled: true },
      line_items: [{
        price_data: {
          currency: 'mxn',
          product_data: {
            name: 'Vuelo en Globo en Teotihuacán',
            description: `Reserva para ${bookingDetails.adults} adulto(s) y ${bookingDetails.children} niño(s).`,
          },
          unit_amount: Math.round(bookingDetails.total * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `https://wefly.com.mx/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://wefly.com.mx/cancel`,
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
      // --- INFORMACIÓN ADICIONAL PARA STRIPE ---
      customer_email: bookingDetails.contact.email,
      billing_address_collection: 'required',
      phone_number_collection: { enabled: true },
      // -----------------------------------------
      line_items: [{
        price_data: {
          currency: 'mxn',
          product_data: {
            name: 'Vuelo en Globo en Teotihuacán',
            description: `Reserva para ${bookingDetails.adults} adulto(s) y ${bookingDetails.children} niño(s).`,
          },
          unit_amount: Math.round(bookingDetails.total * 100),
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
