require('dotenv').config();
const express = require("express");
const cors = require("cors");
const paymentRoutes = require("./routes/payments");

const app = express();
const PORT = process.env.PORT || 4000;

// Middlewares
app.use(cors({
  origin: ['http://localhost:8081', 'exp://*'], // Autoriser React Native
  credentials: true
}));

// IMPORTANT: Utiliser express.text() pour le webhook
app.use("/api/payments/webhook", express.text({ type: 'application/json' }));
app.use(express.json()); // Pour toutes les autres routes
app.use(express.urlencoded({ extended: true }));

// Configuration NotchPay exportable
const NOTCHPAY_CONFIG = {
  publicKey: process.env.NOTCHPAY_PUBLIC_KEY,
  secretKey: process.env.NOTCHPAY_SECRET_KEY,
  baseUrl: process.env.NOTCHPAY_BASE_URL || "https://api.notchpay.co",
  webhookSecret: process.env.NOTCHPAY_WEBHOOK_SECRET
};

// Routes
app.use("/api/payments", paymentRoutes);


// Route de test
app.get("/", (req, res) => {
  res.json({ 
    message: "Serveur NotchPay en marche!",
    version: "1.0.0",
    status: "OK",
    timestamp: new Date().toISOString(),
    notchpay: {
      configured: !!process.env.NOTCHPAY_PUBLIC_KEY,
      baseUrl: NOTCHPAY_CONFIG.baseUrl
    }
  });
});

// Route de vérification de santé
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Gestion des erreurs
app.use((err, req, res, next) => {
  console.error('Erreur serveur:', err);
  res.status(500).json({
    success: false,
    message: 'Erreur interne du serveur',
    error: process.env.NODE_ENV === 'production' ? undefined : err.message
  });
});

// Export pour les tests ou autres utilisations
module.exports = {
  NOTCHPAY_CONFIG,
  app
};

// Démarrer le serveur uniquement si exécuté directement
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
    console.log(`URL: http://localhost:${PORT}`);
    console.log(`NotchPay configuré: ${!!process.env.NOTCHPAY_PUBLIC_KEY}`);
    console.log(`CORS autorisé pour: localhost:8081, exp://*`);
  });
}