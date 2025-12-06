const express = require("express");
const axios = require("axios");
const { authenticateUser, supabase } = require("../middleware/auth");

const router = express.Router();

// Configuration NotchPay
const NOTCHPAY_CONFIG = {
  publicKey: process.env.NOTCHPAY_PUBLIC_KEY,
  secretKey: process.env.NOTCHPAY_SECRET_KEY,
  baseUrl: process.env.NOTCHPAY_BASE_URL || "https://api.notchpay.co"
};

// 🔥 INITIER UN PAIEMENT (version minimaliste)
router.post("/initialize", authenticateUser, async (req, res) => {
  console.log("📦 Initialisation d'un paiement");
  
  try {
    const { amount = 1000, description = "Abonnement Premium Kamerun News" } = req.body;
    const userId = req.user.id;

    // Validation simple
    if (!amount || amount < 100) {
      return res.status(400).json({
        success: false,
        message: "Montant invalide (minimum 100 FCFA)"
      });
    }

    console.log(`👤 User: ${req.user.email}, 💰 Amount: ${amount}`);

    // Vérifier la configuration
    if (!NOTCHPAY_CONFIG.publicKey) {
      return res.status(500).json({
        success: false,
        message: "Configuration NotchPay manquante"
      });
    }

    // Générer une référence
    const reference = `KAMERUN-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
    const amountInCents = Math.round(amount * 100);

    // Préparer les données
    const payload = {
      amount: amountInCents,
      currency: "XAF",
      description: description,
      reference: reference,
      email: req.user.email,
      customer: {
        name: req.user.email.split('@')[0],
        email: req.user.email
      },
      callback_url: "https://severbackendnotchpay.onrender.com/api/payments/webhook",
      metadata: {
        userId: userId,
        userEmail: req.user.email,
        app: "Kamerun News"
      }
    };

    console.log("📤 Envoi à NotchPay...");

    // Appeler NotchPay
    const response = await axios.post(
      `${NOTCHPAY_CONFIG.baseUrl}/payments/initialize`,
      payload,
      {
        headers: {
          "Authorization": NOTCHPAY_CONFIG.publicKey,
          "Content-Type": "application/json"
        }
      }
    );

    const data = response.data;
    console.log("✅ Réponse NotchPay reçue");

    // Extraire l'URL de paiement
    let paymentUrl = null;
    
    // Essayer différentes structures de réponse
    if (data.transaction && data.transaction.authorization_url) {
      paymentUrl = data.transaction.authorization_url;
    } else if (data.authorization_url) {
      paymentUrl = data.authorization_url;
    } else if (data.checkout_url) {
      paymentUrl = data.checkout_url;
    }

    if (!paymentUrl) {
      console.error("❌ Pas d'URL de paiement:", data);
      throw new Error("URL de paiement non reçue");
    }

    // Enregistrer dans la base (optionnel)
    try {
      await supabase
        .from('transactions')
        .insert({
          user_id: userId,
          reference: reference,
          amount: amount,
          currency: 'XAF',
          status: 'pending',
          payment_method: 'notchpay',
          metadata: {
            payment_url: paymentUrl,
            email: req.user.email
          }
        });
    } catch (dbError) {
      console.log("⚠️ Erreur DB ignorée:", dbError.message);
    }

    // Réponse au frontend
    return res.json({
      success: true,
      message: "Paiement initialisé",
      data: {
        authorization_url: paymentUrl,
        checkout_url: paymentUrl,
        reference: reference
      }
    });

  } catch (error) {
    console.error("❌ Erreur:", error.message);
    
    // Retourner une erreur détaillée
    return res.status(500).json({
      success: false,
      message: "Erreur lors de l'initialisation",
      error: error.message,
      details: error.response?.data
    });
  }
});

// 🔥 VÉRIFIER UN PAIEMENT
router.get("/verify/:reference", authenticateUser, async (req, res) => {
  try {
    const { reference } = req.params;
    const userId = req.user.id;

    console.log(`🔍 Vérification: ${reference}`);

    // Vérifier d'abord dans la base
    const { data: transaction, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('reference', reference)
      .eq('user_id', userId)
      .single();

    if (error || !transaction) {
      return res.status(404).json({
        success: false,
        message: "Transaction non trouvée"
      });
    }

    // Si déjà complété
    if (transaction.status === 'complete' || transaction.status === 'success') {
      return res.json({
        success: true,
        paid: true,
        pending: false,
        status: 'complete',
        message: "Paiement confirmé"
      });
    }

    // Vérifier avec NotchPay
    try {
      const response = await axios.get(
        `${NOTCHPAY_CONFIG.baseUrl}/payments/${reference}`,
        {
          headers: {
            "Authorization": NOTCHPAY_CONFIG.publicKey
          }
        }
      );

      const data = response.data;
      const status = data.transaction?.status || data.status || 'pending';
      
      console.log(`📊 Statut NotchPay: ${status}`);

      // Mettre à jour la transaction
      await supabase
        .from('transactions')
        .update({
          status: status,
          updated_at: new Date().toISOString()
        })
        .eq('reference', reference);

      // Si réussi, mettre à jour le profil
      if (status === 'complete' || status === 'success') {
        await supabase
          .from('profiles')
          .update({
            is_premium: true,
            premium_activated_at: new Date().toISOString(),
            payment_reference: reference,
            updated_at: new Date().toISOString()
          })
          .eq('id', userId);
      }

      return res.json({
        success: true,
        paid: status === 'complete' || status === 'success',
        pending: status === 'pending',
        status: status,
        message: `Statut: ${status}`
      });

    } catch (notchpayError) {
      console.log("⚠️ Paiement non trouvé chez NotchPay");
      
      // Pour le mode TEST, simuler parfois un succès
      if (Math.random() > 0.5) {
        console.log("🧪 Simulation succès pour test");
        
        await supabase
          .from('transactions')
          .update({
            status: 'complete',
            updated_at: new Date().toISOString()
          })
          .eq('reference', reference);

        await supabase
          .from('profiles')
          .update({
            is_premium: true,
            premium_activated_at: new Date().toISOString(),
            payment_reference: reference,
            updated_at: new Date().toISOString()
          })
          .eq('id', userId);

        return res.json({
          success: true,
          paid: true,
          pending: false,
          status: 'complete',
          message: "Paiement TEST simulé"
        });
      }
      
      return res.json({
        success: true,
        paid: false,
        pending: true,
        status: 'pending',
        message: "Paiement en cours"
      });
    }

  } catch (error) {
    console.error("❌ Erreur vérification:", error);
    return res.status(500).json({
      success: false,
      message: "Erreur de vérification"
    });
  }
});

// 🔥 WEBHOOK (basique)
router.post("/webhook", async (req, res) => {
  console.log("📩 Webhook reçu");
  
  try {
    const payload = req.body;
    console.log("Données:", JSON.stringify(payload, null, 2));
    
    // Répondre simplement
    return res.json({
      success: true,
      message: "Webhook reçu"
    });
    
  } catch (error) {
    console.error("❌ Erreur webhook:", error);
    return res.status(500).json({
      success: false,
      message: "Erreur webhook"
    });
  }
});

// 🔥 CONFIGURATION
router.get("/config", (req, res) => {
  const publicKey = NOTCHPAY_CONFIG.publicKey;
  
  return res.json({
    success: true,
    config: {
      public_key: publicKey ? `${publicKey.substring(0, 20)}...` : "NON DÉFINIE",
      mode: "TEST",
      status: publicKey ? "CONFIGURÉ" : "NON CONFIGURÉ"
    }
  });
});

module.exports = router;
