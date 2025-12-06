const express = require("express");
const axios = require("axios");
const { authenticateUser, supabase } = require("../middleware/auth");

const router = express.Router();

// 🔥 CONFIGURATION NOTCHPAY - ACCEPTE LES CLÉS TEST
const NOTCHPAY_CONFIG = {
  publicKey: process.env.NOTCHPAY_PUBLIC_KEY,
  secretKey: process.env.NOTCHPAY_SECRET_KEY,
  baseUrl: process.env.NOTCHPAY_BASE_URL || "https://api.notchpay.co",
  mode: process.env.NOTCHPAY_MODE || "TEST" // MODE TEST PAR DÉFAUT
};

// 🔥 VÉRIFICATION SIMPLIFIÉE DES CLÉS
const validateNotchPayConfig = () => {
  if (!NOTCHPAY_CONFIG.publicKey) {
    throw new Error("NOTCHPAY_PUBLIC_KEY non définie");
  }
  
  // Accepter aussi bien les clés TEST que LIVE
  const isLiveKey = NOTCHPAY_CONFIG.publicKey.includes('pk_live_');
  const isTestKey = NOTCHPAY_CONFIG.publicKey.includes('pk.SBX') || 
                    NOTCHPAY_CONFIG.publicKey.includes('test');
  
  if (!isLiveKey && !isTestKey) {
    console.warn("⚠️ Format de clé inconnu, tentative de continuation...");
  }
  
  return {
    isLive: isLiveKey,
    isTest: isTestKey,
    mode: isLiveKey ? "LIVE" : "TEST"
  };
};

// 🔥 INITIER UN PAIEMENT (ACCEPTE TEST ET LIVE)
router.post("/initialize", authenticateUser, async (req, res) => {
  console.log("=== 🚀 INITIALISATION PAIEMENT ===");
  
  try {
    const { amount = 1000, description = "Abonnement Premium Kamerun News" } = req.body;
    const userId = req.user.id;

    // Validation
    if (amount < 100) {
      return res.status(400).json({
        success: false,
        message: "Le montant doit être d'au moins 100 FCFA"
      });
    }

    console.log(`👤 Utilisateur: ${req.user.email}`);
    console.log(`💰 Montant: ${amount} FCFA`);

    // Vérifier la configuration
    const configStatus = validateNotchPayConfig();
    console.log(`🔐 Mode: ${configStatus.mode}`);
    console.log(`🔑 Clé: ${NOTCHPAY_CONFIG.publicKey.substring(0, 20)}...`);

    // Générer une référence
    const reference = `KAMERUN-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
    const amountInCents = Math.round(amount * 100);

    // Données client
    const customerName = req.user.user_metadata?.full_name || 
                        req.user.user_metadata?.name || 
                        req.user.email.split('@')[0];

    // Payload NotchPay
    const payload = {
      amount: amountInCents,
      currency: "XAF",
      description: description,
      reference: reference,
      email: req.user.email,
      customer: {
        name: customerName,
        email: req.user.email,
        phone: ""
      },
      callback_url: "https://severbackendnotchpay.onrender.com/api/payments/webhook",
      metadata: {
        userId: userId,
        userEmail: req.user.email,
        product: "Abonnement Premium",
        app: "Kamerun News",
        mode: configStatus.mode
      }
    };

    console.log("📤 Envoi à NotchPay...");
    console.log("📝 Référence:", reference);

    try {
      const response = await axios.post(
        `${NOTCHPAY_CONFIG.baseUrl}/payments/initialize`,
        payload,
        {
          headers: {
            "Authorization": NOTCHPAY_CONFIG.publicKey,
            "Content-Type": "application/json",
            "Accept": "application/json"
          },
          timeout: 30000
        }
      );

      console.log("✅ Réponse NotchPay reçue");

      // Extraire l'URL
      const data = response.data;
      let paymentUrl = data.transaction?.authorization_url || 
                      data.authorization_url || 
                      data.checkout_url ||
                      data.links?.authorization_url ||
                      data.links?.checkout;

      if (!paymentUrl) {
        console.error("❌ Aucune URL de paiement:", data);
        throw new Error("URL de paiement non reçue");
      }

      console.log("🔗 URL de paiement générée");

      // Enregistrer la transaction
      const { data: transaction, error: dbError } = await supabase
        .from('transactions')
        .insert({
          user_id: userId,
          reference: reference,
          amount: amount,
          currency: 'XAF',
          status: 'pending',
          payment_method: 'notchpay',
          metadata: {
            notchpay_response: data,
            payment_url: paymentUrl,
            mode: configStatus.mode,
            created_at: new Date().toISOString()
          }
        })
        .select()
        .single();

      if (dbError) {
        console.error("❌ Erreur DB:", dbError.message);
      }

      return res.json({
        success: true,
        message: `Paiement ${configStatus.mode} initialisé`,
        mode: configStatus.mode,
        data: {
          authorization_url: paymentUrl,
          checkout_url: paymentUrl,
          reference: reference,
          transaction_id: transaction?.id
        }
      });

    } catch (error) {
      console.error("❌ Erreur API NotchPay:", error.message);
      console.error("📡 Détails:", error.response?.data);
      
      return res.status(500).json({
        success: false,
        message: error.response?.data?.message || "Erreur de communication avec NotchPay",
        error: error.message,
        mode: configStatus.mode
      });
    }

  } catch (error) {
    console.error("❌ Erreur globale:", error.message);
    return res.status(500).json({
      success: false,
      message: "Erreur interne du serveur",
      error: error.message
    });
  }
});

// 🔥 VÉRIFIER UN PAIEMENT
router.get("/verify/:reference", authenticateUser, async (req, res) => {
  try {
    const { reference } = req.params;
    const userId = req.user.id;

    console.log(`🔍 Vérification: ${reference}`);

    // Chercher la transaction
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
        message: "Paiement déjà confirmé"
      });
    }

    // Essayer de vérifier avec NotchPay
    try {
      const response = await axios.get(
        `${NOTCHPAY_CONFIG.baseUrl}/payments/${reference}`,
        {
          headers: {
            "Authorization": NOTCHPAY_CONFIG.publicKey,
            "Accept": "application/json"
          }
        }
      );

      const data = response.data;
      const status = data.transaction?.status || data.status;
      
      console.log(`📊 Statut NotchPay: ${status}`);

      // Mettre à jour
      await supabase
        .from('transactions')
        .update({
          status: status,
          updated_at: new Date().toISOString()
        })
        .eq('id', transaction.id);

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
        message: status === 'complete' ? "Paiement confirmé" : "En attente"
      });

    } catch (verifyError) {
      console.log("⚠️ Paiement non trouvé chez NotchPay, réessayez plus tard");
      return res.json({
        success: true,
        paid: false,
        pending: true,
        status: 'pending',
        message: "Paiement en cours de traitement"
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

// 🔥 WEBHOOK SIMPLIFIÉ
router.post("/webhook", async (req, res) => {
  console.log("📩 Webhook reçu");
  
  try {
    let payload;
    if (typeof req.body === 'string') {
      payload = JSON.parse(req.body);
    } else {
      payload = req.body;
    }
    
    console.log("Événement:", payload.event);
    
    // Traiter simplement
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
  try {
    const publicKey = NOTCHPAY_CONFIG.publicKey;
    
    if (!publicKey) {
      return res.json({
        success: false,
        message: "NOTCHPAY_PUBLIC_KEY non définie"
      });
    }
    
    const isLive = publicKey.includes('pk_live_');
    const isTest = publicKey.includes('pk.SBX') || publicKey.includes('test');
    
    return res.json({
      success: true,
      config: {
        mode: isLive ? "LIVE" : isTest ? "TEST" : "INCONNU",
        public_key: `${publicKey.substring(0, 25)}...`,
        status: "CONFIGURÉ"
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;