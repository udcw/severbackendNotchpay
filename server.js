const express = require('express');
const cors = require('cors');
const paymentRoutes = require('./routes/payments');

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/payments', paymentRoutes);

// Route de test
app.get('/', (req, res) => {
  res.json({ message: 'Serveur NotchPay en marche!' });
});

// Démarrage du serveur
app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});