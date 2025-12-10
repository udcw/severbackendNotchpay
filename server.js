require('dotenv').config();
const express = require("express");
const cors = require("cors");
const paymentRoutes = require("./routes/payments");

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use("/api/payments", paymentRoutes);

// Routes de base
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "✅ Serveur NotchPay fonctionnel",
    version: "3.0.0",
    mode: process.env.NODE_ENV === 'production' ? 'LIVE' : 'TEST',
    endpoints: {
      initialize: "POST /api/payments/initialize",
      verify: "GET /api/payments/verify/:reference",
      webhook: "POST /api/payments/webhook",
      webhook_notchpay: "POST /api/payments/webhook/notchpay",
      config: "GET /api/payments/config",
      health: "GET /health",
      test_webhook: "GET /test-webhook"
    },
    instructions: "Le système de paiement est opérationnel"
  });
});

app.get("/test-webhook", (req, res) => {
  res.json({
    message: "Pour tester le webhook, utilisez Postman ou curl avec :",
    curl_command: `curl -X POST https://severbackendnotchpay.onrender.com/api/payments/webhook/notchpay \\
      -H "Content-Type: application/json" \\
      -d '{
        "event": "payment.complete",
        "data": {
          "reference": "TRX-TEST-12345",
          "status": "complete",
          "amount": 25,
          "currency": "XAF",
          "customer": {
            "email": "test@example.com"
          },
          "metadata": {
            "userId": "test-user-id",
            "userEmail": "test@example.com"
          }
        }
      }'`
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    mode: process.env.NODE_ENV || 'development',
    webhook_url: "https://severbackendnotchpay.onrender.com/api/payments/webhook/notchpay"
  });
});

// Routes non trouvées
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route non trouvée",
    path: req.path,
    method: req.method
  });
});

// Gestionnaire d'erreurs
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
  console.log(`🔧 Webhook NotchPay: https://severbackendnotchpay.onrender.com/api/payments/webhook/notchpay`);
  
  // Vérification des variables d'environnement (sans afficher les valeurs sensibles)
  const envVars = {
    NODE_ENV: process.env.NODE_ENV,
    PORT: process.env.PORT || '4000 (default)',
    SUPABASE_URL: process.env.SUPABASE_URL ? '✓ Configuré' : '✗ Manquant',
    NOTCHPAY_PUBLIC_KEY: process.env.NOTCHPAY_PUBLIC_KEY ? 
      '✓ Configuré (' + (process.env.NOTCHPAY_PUBLIC_KEY.includes('SBX') ? 'TEST' : 'LIVE') + ')' : 
      '✗ Manquant'
  };
  
  console.log(`⚙️ Variables d'environnement:`, envVars);
});
