const express = require("express");
const axios = require("axios");
const { authenticateUser, supabase } = require("../middleware/auth");

const router = express.Router();

// 🔥 CONFIGURATION NOTCHPAY - ACCEPTE LES CLÉS TEST
const NOTCHPAY_CONFIG = {
  publicKey: process.env.NOTCHPAY_PUBLIC_KEY || "pk.SBXvy0Fe1pGfFWwABmBAw7aSu8xcSaHZNiW2aRxWZe9oF2m59rbjtRa0je1UhqJfQ3NGn3TzyqrYHbLFLKElE1nKVSZQJcQ9wAOczNBYG66zHX4svoGmTpaWLDrVY",
  secretKey: process.env.NOTCHPAY_SECRET_KEY || "sk.OjkG6OCmWq6LmMU2arL79NjZtDI8XQq4QKrIRnG1yQL5Sjv5SQzw6LDuzqhwNRx151maxwzehBTVjzGqsGjOr7y0s1k7auKRfIrmOgDXnYjziLUL8ILQQtDxQY00k",
  baseUrl: process.env.NOTCHPAY_BASE_URL || "https://api.notchpay.co",
  mode: "TEST" // Accepte le mode TEST
};

// 🔥 INITIER UN PAIEMENT (FONCTIONNEL POUR TEST)
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
    console.log(`🔐 Mode: ${NOTCHPAY_CONFIG.mode}`);

    // Pas de vérification stricte des clés LIVE
    if (!NOTCHPAY_CONFIG.publicKey) {
      return res.status(500).json({
        success: false,
        message: "NOTCHPAY_PUBLIC_KEY non configurée",
        mode: "ERROR"
      });
    }

    // Générer une référence
    const reference = `KAMERUN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
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
      callback_url: `${process.env.BACKEND_URL || 'https://severbackendnotchpay.onrender.com'}/api/payments/webhook`,
      metadata: {
        userId: userId,
        userEmail: req.user.email,
        product: "Abonnement Premium",
        app: "Kamerun News",
        mode: NOTCHPAY_CONFIG.mode
      }
    };

    console.log("📤 Envoi à NotchPay...");
    console.log("📝 Référence:", reference);
    console.log("🔑 Clé utilisée:", NOTCHPAY_CONFIG.publicKey.substring(0, 20) + "...");

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

      // Extraire l'URL de paiement
      const data = response.data;
      console.log("📊 Données NotchPay:", JSON.stringify(data, null, 2));

      let paymentUrl = data.transaction?.authorization_url || 
                      data.authorization_url || 
                      data.checkout_url ||
                      data.links?.authorization_url ||
                      data.links?.checkout ||
                      data.url;

      if (!paymentUrl) {
        console.error("❌ Aucune URL de paiement trouvée");
        return res.status(500).json({
          success: false,
          message: "URL de paiement non reçue de NotchPay",
          data: data
        });
      }

      console.log("🔗 URL de paiement générée:", paymentUrl);

      // Vérifier si c'est une URL de test
      if (paymentUrl.includes('/test.')) {
        console.log("🧪 Mode TEST confirmé");
      } else {
        console.log("⚠️ URL ne semble pas être en mode test");
      }

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
            mode: NOTCHPAY_CONFIG.mode,
            customer_email: req.user.email,
            created_at: new Date().toISOString()
          }
        })
        .select()
        .single();

      if (dbError) {
        console.error("❌ Erreur Supabase:", dbError.message);
      }

      return res.json({
        success: true,
        message: "Paiement initialisé avec succès",
        mode: NOTCHPAY_CONFIG.mode,
        data: {
          authorization_url: paymentUrl,
          checkout_url: paymentUrl,
          reference: reference,
          transaction_id: transaction?.id,
          transaction_url: paymentUrl
        }
      });

    } catch (error) {
      console.error("❌ Erreur API NotchPay:", error.message);
      
      if (error.response) {
        console.error("📡 Détails erreur:", {
          status: error.response.status,
          data: error.response.data,
          headers: error.response.headers
        });
        
        return res.status(error.response.status || 500).json({
          success: false,
          message: error.response.data?.message || "Erreur NotchPay",
          error: error.response.data,
          mode: NOTCHPAY_CONFIG.mode
        });
      }
      
      return res.status(500).json({
        success: false,
        message: "Erreur de communication avec NotchPay",
        error: error.message,
        mode: NOTCHPAY_CONFIG.mode
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

    // 1. Chercher la transaction
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

    console.log("✅ Transaction trouvée:", transaction.status);

    // 2. Si déjà complété
    if (transaction.status === 'complete' || transaction.status === 'success') {
      return res.json({
        success: true,
        paid: true,
        pending: false,
        status: 'complete',
        message: "Paiement déjà confirmé"
      });
    }

    // 3. Vérifier avec NotchPay
    try {
      console.log(`🔍 Vérification chez NotchPay: ${reference}`);
      
      const response = await axios.get(
        `${NOTCHPAY_CONFIG.baseUrl}/payments/${reference}`,
        {
          headers: {
            "Authorization": NOTCHPAY_CONFIG.publicKey,
            "Accept": "application/json"
          },
          timeout: 10000
        }
      );

      const data = response.data;
      console.log("📊 Réponse NotchPay:", data);
      
      // NotchPay peut retourner les données de différentes manières
      const transactionData = data.transaction || data;
      const status = transactionData.status || 'pending';
      const isComplete = status === 'complete' || status === 'success';
      const isPending = status === 'pending';
      const isFailed = ['failed', 'cancelled', 'canceled', 'expired'].includes(status);

      console.log(`📊 Statut NotchPay: ${status}`);

      // Mettre à jour la transaction
      await supabase
        .from('transactions')
        .update({
          status: status,
          metadata: {
            ...transaction.metadata,
            verification_response: data,
            verified_at: new Date().toISOString()
          },
          updated_at: new Date().toISOString(),
          completed_at: isComplete ? new Date().toISOString() : null
        })
        .eq('id', transaction.id);

      // Si paiement réussi
      if (isComplete) {
        await supabase
          .from('profiles')
          .update({
            is_premium: true,
            premium_activated_at: new Date().toISOString(),
            payment_reference: reference,
            last_payment_date: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('id', userId);

        // Créer l'abonnement
        await supabase
          .from('subscriptions')
          .insert({
            user_id: userId,
            plan: 'premium',
            transaction_reference: reference,
            status: 'active',
            starts_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
          }).catch(err => {
            console.log("⚠️ Erreur création abonnement:", err.message);
          });
      }

      return res.json({
        success: true,
        paid: isComplete,
        pending: isPending,
        failed: isFailed,
        status: status,
        message: isComplete ? "Paiement confirmé" : 
                isFailed ? "Paiement échoué" : 
                "Paiement en cours",
        data: data
      });

    } catch (notchpayError) {
      console.log("⚠️ NotchPay n'a pas encore le paiement:", notchpayError.message);
      
      // Pour le mode TEST, simuler parfois un succès
      if (NOTCHPAY_CONFIG.mode === "TEST" && Math.random() > 0.7) {
        console.log("🧪 Mode TEST: Simulation succès");
        
        await supabase
          .from('transactions')
          .update({
            status: 'complete',
            updated_at: new Date().toISOString()
          })
          .eq('id', transaction.id);

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
        message: "Paiement en cours de traitement chez NotchPay"
      });
    }

  } catch (error) {
    console.error("❌ Erreur vérification:", error.message);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de la vérification",
      error: error.message
    });
  }
});

// 🔥 WEBHOOK SIMPLIFIÉ
router.post("/webhook", async (req, res) => {
  console.log("=== 📩 WEBHOOK REÇU ===");
  
  try {
    let payload;
    if (typeof req.body === 'string') {
      try {
        payload = JSON.parse(req.body);
      } catch (e) {
        console.error("❌ Erreur parsing JSON:", e);
        payload = req.body;
      }
    } else {
      payload = req.body;
    }
    
    console.log("📦 Données reçues:", JSON.stringify(payload, null, 2));
    
    return res.json({
      success: true,
      message: "Webhook reçu",
      data: payload
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
  const isLive = publicKey && publicKey.includes('pk_live_');
  const isTest = publicKey && (publicKey.includes('SBX') || publicKey.includes('test'));
  
  return res.json({
    success: true,
    config: {
      mode: isLive ? "LIVE" : isTest ? "TEST" : "INCONNU",
      public_key: publicKey ? `${publicKey.substring(0, 30)}...` : "NON DÉFINIE",
      base_url: NOTCHPAY_CONFIG.baseUrl,
      status: "ACTIF",
      message: isTest ? 
        "🧪 Mode TEST - Remplacez par des clés LIVE pour accepter de vrais paiements" : 
        "✅ Mode LIVE - Prêt pour les vrais paiements"
    }
  });
});

// 🔥 ROUTE DE TEST DIRECT
router.post("/test-payment", async (req, res) => {
  try {
    // Simuler un appel NotchPay
    const reference = `TEST-${Date.now()}`;
    
    return res.json({
      success: true,
      message: "Test réussi",
      data: {
        authorization_url: "https://pay.notchpay.co/test.example",
        checkout_url: "https://pay.notchpay.co/test.example",
        reference: reference,
        mode: "TEST"
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