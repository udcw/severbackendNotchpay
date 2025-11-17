const express = require("express");
const axios = require("axios");
const NOTCHPAY = require("../config/notchpay"); // ← FIX

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
      reference: `REF-${Date.now()}`,
      description,
      callback: process.env.NOTCHPAY_CALLBACK_URL
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

module.exports = router;
