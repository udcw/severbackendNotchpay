require('dotenv').config();
const express = require("express");
const cors = require("cors");
const paymentRoutes = require("./routes/payments");

const app = express();
const PORT = process.env.PORT || 4000;

// CORS pour tous les domaines
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Middleware pour parser JSON
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes de paiement
app.use("/api/payments", paymentRoutes);

// Route racine - TRÈS IMPORTANTE !
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "✅ Serveur NotchPay fonctionnel",
    version: "2.0.0",
    mode: "TEST",
    endpoints: {
      initialize: "POST /api/payments/initialize",
      verify: "GET /api/payments/verify/:reference",
      webhook: "POST /api/payments/webhook",
      config: "GET /api/payments/config",
      health: "GET /health"
    },
    instructions: "Pour un vrai paiement, remplacez les clés TEST par des clés LIVE"
  });
});

// Route de santé
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Route 404 - pour les routes non trouvées
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route non trouvée",
    path: req.path,
    method: req.method
  });
});

// Gestionnaire d'erreurs global
app.use((err, req, res, next) => {
  console.error('❌ Erreur serveur:', err);
  res.status(500).json({
    success: false,
    message: 'Erreur interne du serveur',
    error: process.env.NODE_ENV === 'production' ? undefined : err.message
  });
});

// Démarrer le serveur
app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`🔗 URL: http://localhost:${PORT}`);
  console.log(`🌍 Accessible depuis: https://severbackendnotchpay.onrender.com`);
  console.log(`📡 Mode: ${process.env.NODE_ENV || 'development'}`);
});
