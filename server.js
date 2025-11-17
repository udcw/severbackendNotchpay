require('dotenv').config(); // Charger les variables .env
const express = require("express");
const cors = require("cors");
const paymentRoutes = require("./routes/payments");

const app = express();
const PORT = process.env.PORT || 4000;

// 👉 Exporté AVANT d'utiliser server.js dans payments.js
module.exports = {
  publicKey: process.env.NOTCHPAY_PUBLIC_KEY,
  secretKey: process.env.NOTCHPAY_SECRET_KEY,
  baseUrl: process.env.NOTCHPAY_BASE_URL || "https://api.notchpay.co"
};

// Middlewares
app.use(cors());
app.use(express.json());

// Routes
app.use("/api/payments", paymentRoutes);

// Test route
app.get("/", (req, res) => {
  res.json({ message: "Serveur NotchPay en marche!" });
});

// Start server
app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
