const express = require("express");
const axios = require("axios");
const NOTCHPAY = require("../server"); // Import config NotchPay

const router = express.Router();

// 🔥 INITIER UN PAIEMENT
router.post("/initialize", async (req, res) => {
  try {
    const { email, amount, name, phone, description = "Abonnement Premium" } = req.body;

    if (!email || !amount || !name) {
      return res.status(400).json({
        success: false,
        message: "Email, montant et nom sont requis"
      });
    }

    const payload = {
      email,
      amount,
      currency: "XAF",
      description,
      reference: `REF-${Date.now()}`,
      callback: process.env.NOTCHPAY_CALLBACK_URL || " https://alijah-hyperdiastolic-sybil.ngrok-free.dev/payment-webview-callback"
    };

    const response = await axios.post(
      `${NOTCHPAY.baseUrl}/payments/initialize`,
      payload,
      {
        headers: {
          Authorization: NOTCHPAY.publicKey,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("Response NotchPay:", response.data);

    return res.json({
      success: true,
      payment: response.data,
      paymentUrl: response.data.transaction?.authorization_url || response.data.transaction?.url
    });

  } catch (err) {
    console.error("Erreur NotchPay:", err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      error: err.response?.data || "Erreur interne"
    });
  }
});

// 🔥 VÉRIFIER UN PAIEMENT
router.get("/verify/:reference", async (req, res) => {
  try {
    const { reference } = req.params;

    const response = await axios.get(
      `${NOTCHPAY.baseUrl}/payments/${reference}`,
      {
        headers: {
          Authorization: NOTCHPAY.publicKey
        }
      }
    );

    return res.json({
      success: true,
      transaction: response.data.transaction
    });

  } catch (err) {
    console.error("Erreur verify:", err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      error: err.response?.data || "Erreur interne"
    });
  }
});

// 🔥 WEBHOOK NOTCHPAY
router.post("/webhook", async (req, res) => {
  console.log("Webhook reçu :", req.body);

  const { event, data } = req.body;

  if (event === "payment.complete") {
    console.log("Paiement Réussi :", data.transaction.reference);
  }

  if (event === "payment.failed") {
    console.log("Paiement Échoué :", data.transaction.reference);
  }

  return res.sendStatus(200);
});

module.exports = router;
