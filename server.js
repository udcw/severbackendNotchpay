require('dotenv').config();
const express = require("express");
const cors = require("cors");
const paymentRoutes = require("./routes/payments");

const app = express();
const PORT = process.env.PORT || 4000;

// Middlewares
app.use(cors({
  origin: '*',
  credentials: true
}));

app.use("/api/payments/webhook", express.text({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use("/api/payments", paymentRoutes);

// Route de test
app.get("/", (req, res) => {
  res.json({ 
    message: "Serveur NotchPay en marche!",
    version: "1.0.0",
    status: "OK",
    timestamp: new Date().toISOString()
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
// Ajoutez cette route AVANT vos autres routes
app.get("/test-env", (req, res) => {
  res.json({
    notchpay_public_key: process.env.NOTCHPAY_PUBLIC_KEY ? 
      `${process.env.NOTCHPAY_PUBLIC_KEY.substring(0, 30)}...` : 
      "NON DÉFINIE",
    mode: process.env.NOTCHPAY_PUBLIC_KEY?.includes('pk_live_') ? "LIVE" : 
          process.env.NOTCHPAY_PUBLIC_KEY?.includes('SBX') ? "TEST" : 
          "INCONNU",
    backend_url: process.env.BACKEND_URL,
    supabase_url: process.env.SUPABASE_URL ? "DÉFINIE" : "NON DÉFINIE"
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

// Démarrer le serveur
app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
  console.log(`URL: http://localhost:${PORT}`);
  console.log(`NotchPay configuré: ${!!process.env.NOTCHPAY_PUBLIC_KEY}`);
});