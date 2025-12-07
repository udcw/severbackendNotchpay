require('dotenv').config();
const express = require("express");
const cors = require("cors");
const paymentRoutes = require("./routes/payments");

const app = express();
const PORT = process.env.PORT || 4000;

// CORS très permissif pour le développement
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use("/api/payments", paymentRoutes);

// Route principale
app.get("/", (req, res) => {
  res.json({ 
    message: "✅ Serveur NotchPay fonctionnel",
    mode: "TEST",
    status: "OK",
    endpoints: {
      initialize: "POST /api/payments/initialize",
      verify: "GET /api/payments/verify/:reference",
      config: "GET /api/payments/config",
      test: "POST /api/payments/test-payment"
    }
  });
});
// Ajoutez dans server.js
app.get("/test-webhook", (req, res) => {
  const testData = {
    event: "payment.complete",
    data: {
      amount: 1000,
      status: "complete",
      reference: "trx.TEST123",
      merchant_reference: "KAMERUN-TEST-123",
      metadata: {
        userId: "test-user-123",
        userEmail: "test@example.com"
      }
    }
  };
  
  res.json({
    message: "Test webhook",
    curl_command: `curl -X POST https://severbackendnotchpay.onrender.com/api/payments/webhook -H "Content-Type: application/json" -d '${JSON.stringify(testData)}'`
  });
});
// Route de santé
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString()
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route non trouvée"
  });
});

// Gestion d'erreurs
app.use((err, req, res, next) => {
  console.error('❌ Erreur:', err);
  res.status(500).json({
    success: false,
    message: 'Erreur interne',
    error: err.message
  });
});

// Démarrer
app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`🔗 http://localhost:${PORT}`);
  console.log(`🔐 Mode: TEST (Sandbox)`);
});