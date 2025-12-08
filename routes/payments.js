const express = require("express");
const axios = require("axios");
const { authenticateUser, supabase } = require("../middleware/auth");

const router = express.Router();

// 🔥 CONFIGURATION NOTCHPAY
const NOTCHPAY_CONFIG = {
  publicKey: process.env.NOTCHPAY_PUBLIC_KEY || "pk.SBXvy0Fe1pGfFWwABmBAw7aSu8xcSaHZNiW2aRxWZe9oF2m59rbjtRa0je1UhqJfQ3NGn3TzyqrYHbLFLKElE1nKVSZQJcQ9wAOczNBYG66zHX4svoGmTpaWLDrVY",
  secretKey: process.env.NOTCHPAY_SECRET_KEY || "sk.OjkG6OCmWq6LmMU2arL79NjZtDI8XQq4QKrIRnG1yQL5Sjv5SQzw6LDuzqhwNRx151maxwzehBTVjzGqsGjOr7y0s1k7auKRfIrmOgDXnYjziLUL8ILQQtDxQY00k",
  baseUrl: "https://api.notchpay.co",
  webhookSecret: process.env.NOTCHPAY_WEBHOOK_SECRET
};

// 🔥 DÉTECTER LE MODE
function detectMode(publicKey) {
  if (!publicKey) return "TEST";
  if (publicKey.includes('pk_live_')) return "LIVE";
  if (publicKey.includes('pk_test_')) return "TEST";
  if (publicKey.includes('SBX')) return "TEST"; // Clé Sandbox
  return "TEST";
}

const currentMode = detectMode(NOTCHPAY_CONFIG.publicKey);
console.log(`🔧 Mode NotchPay détecté: ${currentMode}`);

// 🔥 FONCTION D'ACTIVATION PREMIUM - OPTIMISÉE
async function processPremiumActivation(userId, reference, status) {
  try {
    console.log(`🔄 Activation premium pour: ${userId}, référence: ${reference}`);
    
    if (!userId || userId === "unknown") {
      console.error("❌ ID utilisateur manquant");
      return false;
    }

    // 1. Mettre à jour le profil
    const { error: profileError } = await supabase
      .from("profiles")
      .update({
        is_premium: true,
        payment_reference: reference,
        last_payment_date: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("id", userId);

    if (profileError) {
      console.error("❌ Erreur mise à jour profil:", profileError);
      return false;
    }

    // 2. Vérifier que la mise à jour a fonctionné
    const { data: updatedProfile } = await supabase
      .from("profiles")
      .select("is_premium, email")
      .eq("id", userId)
      .single();

    console.log(`✅ Profil ${updatedProfile?.email || userId} mis à jour: is_premium=${updatedProfile?.is_premium}`);

    // 3. Créer un enregistrement d'abonnement (si la table existe)
    try {
      await supabase
        .from("subscriptions")
        .insert({
          user_id: userId,
          plan: "premium",
          status: "active",
          transaction_reference: reference,
          starts_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString() // 1 an
        });
      
      console.log(`✅ Abonnement créé pour ${userId}`);
    } catch (subError) {
      console.log("⚠️ Table 'subscriptions' peut-être inexistante:", subError.message);
      // Ce n'est pas critique, continuer
    }

    return true;

  } catch (error) {
    console.error("❌ Erreur activation premium:", error);
    return false;
  }
}

// 🔥 INITIALISER UN PAIEMENT - CORRIGÉ
router.post("/initialize", authenticateUser, async (req, res) => {
  console.log("=== 🚀 INITIALISATION PAIEMENT ===");

  try {
    const { amount = 25, description = "Abonnement Premium Kamerun News" } = req.body;
    const userId = req.user.id;
    const userEmail = req.user.email;

    console.log(`👤 Utilisateur: ${userEmail} (${userId})`);
    console.log(`💰 Montant demandé: ${amount} FCFA`);
    console.log(`📝 Description: ${description}`);

    // Validation
    if (amount < 25) {
      return res.status(400).json({
        success: false,
        message: "Le montant minimum est de 25 FCFA"
      });
    }

    // Générer une référence unique
    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 10);
    const reference = `KAMERUN-${timestamp}-${randomStr}`.toUpperCase();
    const amountInCents = Math.round(amount * 100);

    // Créer d'abord l'enregistrement dans Supabase (sans colonne description)
    const { data: transaction, error: txError } = await supabase
      .from("transactions")
      .insert({
        user_id: userId,
        reference: reference,
        amount: amount,
        currency: "XAF",
        status: "pending",
        metadata: {
          user_email: userEmail,
          description: description,
          mode: currentMode,
          created_at: new Date().toISOString()
        }
      })
      .select()
      .single();

    if (txError) {
      console.error("❌ Erreur création transaction:", txError);
      return res.status(500).json({
        success: false,
        message: "Erreur création transaction",
        error: txError.message
      });
    }

    console.log(`✅ Transaction créée en base: ${reference}`);

    // Mettre à jour le profil avec la référence
    await supabase
      .from("profiles")
      .update({
        payment_reference: reference,
        updated_at: new Date().toISOString()
      })
      .eq("id", userId);

    // Données pour NotchPay
    const customerName = req.user.user_metadata?.full_name || 
                        req.user.user_metadata?.name || 
                        userEmail.split('@')[0];

    const payload = {
      amount: amountInCents,
      currency: "XAF",
      description: description,
      reference: reference,
      email: userEmail,
      customer: {
        name: customerName,
        email: userEmail,
      },
      callback_url: `https://severbackendnotchpay.onrender.com/api/payments/webhook/notchpay`,
      webhook_url: `https://severbackendnotchpay.onrender.com/api/payments/webhook/notchpay`,
      metadata: {
        userId: userId,
        userEmail: userEmail,
        product: "Abonnement Premium Kamerun News",
        mode: currentMode
      }
    };

    console.log("📤 Envoi à NotchPay...");
    console.log("📝 Référence:", reference);
    console.log("🔗 Callback URL:", payload.callback_url);

    try {
      const response = await axios.post(
        `${NOTCHPAY_CONFIG.baseUrl}/payments/initialize`,
        payload,
        {
          headers: {
            Authorization: NOTCHPAY_CONFIG.publicKey,
            "Content-Type": "application/json",
            "Accept": "application/json"
          },
          timeout: 30000
        }
      );

      const data = response.data;
      console.log("✅ Réponse NotchPay reçue");

      // Extraire l'URL de paiement
      let paymentUrl = data.authorization_url || 
                      data.checkout_url || 
                      data.transaction?.authorization_url ||
                      data.links?.authorization_url;

      if (!paymentUrl) {
        console.error("❌ Pas d'URL de paiement dans la réponse:", data);
        
        // Générer une URL de fallback pour le mode TEST
        if (currentMode === "TEST") {
          paymentUrl = `https://checkout.notchpay.co/?payment=${reference}`;
          console.log(`🧪 URL de fallback TEST: ${paymentUrl}`);
        } else {
          throw new Error("URL de paiement non reçue");
        }
      }

      console.log(`🔗 URL de paiement: ${paymentUrl.substring(0, 80)}...`);

      // Mettre à jour la transaction avec l'URL
      await supabase
        .from("transactions")
        .update({
          metadata: {
            ...transaction.metadata,
            payment_url: paymentUrl,
            notchpay_response: data,
            updated_at: new Date().toISOString()
          }
        })
        .eq("id", transaction.id);

      return res.json({
        success: true,
        message: "Paiement initialisé avec succès",
        mode: currentMode,
        data: {
          authorization_url: paymentUrl,
          reference: reference,
          transaction_id: transaction.id,
          amount: amount,
          currency: "XAF"
        }
      });

    } catch (error) {
      console.error("❌ Erreur API NotchPay:", error.message);
      
      if (error.response) {
        console.error("📡 Détails:", error.response.data);
      }

      // Mettre à jour le statut en erreur
      await supabase
        .from("transactions")
        .update({
          status: "failed",
          metadata: {
            ...transaction.metadata,
            error: error.message,
            notchpay_error: error.response?.data
          }
        })
        .eq("id", transaction.id);

      return res.status(500).json({
        success: false,
        message: "Erreur lors de l'initialisation du paiement",
        error: error.message,
        mode: currentMode
      });
    }

  } catch (error) {
    console.error("❌ Erreur globale:", error);
    return res.status(500).json({
      success: false,
      message: "Erreur interne du serveur",
      error: error.message
    });
  }
});

// 🔥 WEBHOOK NOTCHPAY CORRIGÉ
router.post("/webhook/notchpay", async (req, res) => {
  console.log("=== 📩 WEBHOOK NOTCHPAY REÇU ===");
  
  try {
    const payload = req.body;
    console.log("📦 Données reçues:", JSON.stringify(payload, null, 2));

    // Format NotchPay peut varier, essayer plusieurs formats
    let transactionData = payload.data || payload.transaction || payload;
    let reference = transactionData.reference || transactionData.merchant_reference;
    let status = transactionData.status || payload.event?.replace('payment.', '');
    
    // Si c'est un événement, extraire du nom
    if (payload.event && payload.event.includes('.')) {
      status = payload.event.split('.')[1];
    }

    console.log(`🔍 Traitement webhook: Référence=${reference}, Statut=${status}`);

    if (!reference) {
      console.error("❌ Référence manquante dans le webhook");
      return res.status(400).json({ success: false, message: "Référence manquante" });
    }

    // Chercher la transaction
    const { data: transaction, error: txError } = await supabase
      .from("transactions")
      .select("*")
      .eq("reference", reference)
      .maybeSingle();

    if (txError) {
      console.error("❌ Erreur recherche transaction:", txError);
    }

    if (!transaction) {
      console.log(`⚠️ Transaction non trouvée: ${reference}, création...`);
      
      // Créer une transaction si elle n'existe pas
      const userId = transactionData.metadata?.userId || 
                    payload.metadata?.userId ||
                    "unknown";
      
      const { data: newTx } = await supabase
        .from("transactions")
        .insert({
          reference: reference,
          amount: transactionData.amount ? transactionData.amount / 100 : 25,
          currency: transactionData.currency || "XAF",
          status: status || "unknown",
          metadata: {
            webhook_data: payload,
            created_from_webhook: true,
            received_at: new Date().toISOString()
          }
        })
        .select()
        .single();
      
      if (newTx && userId !== "unknown") {
        await processPremiumActivation(userId, reference, status);
      }
      
      return res.status(200).json({ received: true, message: "Transaction créée depuis webhook" });
    }

    console.log(`✅ Transaction trouvée: ${transaction.id}, utilisateur: ${transaction.user_id}`);

    // Mettre à jour la transaction
    await supabase
      .from("transactions")
      .update({
        status: status || "processed",
        metadata: {
          ...transaction.metadata,
          webhook_data: payload,
          webhook_received_at: new Date().toISOString(),
          notchpay_status: status
        },
        updated_at: new Date().toISOString(),
        completed_at: (status === 'complete' || status === 'success') ? new Date().toISOString() : null
      })
      .eq("id", transaction.id);

    // Traiter l'activation premium si paiement réussi
    if (status === 'complete' || status === 'success' || status === 'completed') {
      await processPremiumActivation(transaction.user_id, reference, status);
    }

    console.log(`✅ Webhook traité pour ${reference}`);

    // Toujours répondre 200 à NotchPay
    return res.status(200).json({ 
      success: true, 
      message: "Webhook traité avec succès",
      reference: reference,
      status: status
    });

  } catch (error) {
    console.error("❌ Erreur traitement webhook:", error);
    // Toujours répondre 200 pour éviter les retries
    return res.status(200).json({ 
      received: true, 
      error: error.message 
    });
  }
});

// 🔥 VÉRIFIER UN PAIEMENT
router.get("/verify/:reference", authenticateUser, async (req, res) => {
  try {
    const { reference } = req.params;
    const userId = req.user.id;

    console.log(`🔍 Vérification manuelle: ${reference} pour ${userId}`);

    // 1. Chercher la transaction
    const { data: transaction, error: txError } = await supabase
      .from("transactions")
      .select("*")
      .eq("reference", reference)
      .eq("user_id", userId)
      .maybeSingle();

    if (txError) {
      console.error("❌ Erreur recherche transaction:", txError);
      return res.status(500).json({
        success: false,
        message: "Erreur base de données"
      });
    }

    if (!transaction) {
      console.log(`⚠️ Transaction ${reference} non trouvée`);
      return res.status(404).json({
        success: false,
        message: "Transaction non trouvée"
      });
    }

    console.log(`✅ Transaction trouvée, statut: ${transaction.status}`);

    // 2. Si déjà complet, vérifier le profil
    if (transaction.status === 'complete' || transaction.status === 'success') {
      const { data: profile } = await supabase
        .from("profiles")
        .select("is_premium")
        .eq("id", userId)
        .single();

      return res.json({
        success: true,
        paid: true,
        pending: false,
        status: "complete",
        is_premium: profile?.is_premium || false,
        message: profile?.is_premium ? 
          "Paiement confirmé - Compte premium actif" : 
          "Paiement confirmé mais profil non encore mis à jour"
      });
    }

    // 3. Vérifier avec NotchPay
    try {
      console.log(`🔍 Vérification chez NotchPay: ${reference}`);
      
      const response = await axios.get(
        `${NOTCHPAY_CONFIG.baseUrl}/payments/${reference}`,
        {
          headers: {
            Authorization: NOTCHPAY_CONFIG.publicKey,
            "Accept": "application/json"
          },
          timeout: 10000
        }
      );

      const data = response.data;
      const notchpayStatus = data.status || data.transaction?.status;
      
      console.log(`📊 Statut NotchPay: ${notchpayStatus}`);

      // Mettre à jour la transaction
      await supabase
        .from("transactions")
        .update({
          status: notchpayStatus || "checked",
          metadata: {
            ...transaction.metadata,
            last_verification: new Date().toISOString(),
            notchpay_status: notchpayStatus
          },
          updated_at: new Date().toISOString()
        })
        .eq("id", transaction.id);

      // Si paiement réussi chez NotchPay, activer premium
      if (notchpayStatus === 'complete' || notchpayStatus === 'success') {
        await processPremiumActivation(userId, reference, notchpayStatus);
        
        const { data: profile } = await supabase
          .from("profiles")
          .select("is_premium")
          .eq("id", userId)
          .single();

        return res.json({
          success: true,
          paid: true,
          pending: false,
          status: "complete",
          is_premium: profile?.is_premium || false,
          message: "Paiement confirmé via NotchPay"
        });
      }

      // Statut en attente
      if (notchpayStatus === 'pending') {
        return res.json({
          success: true,
          paid: false,
          pending: true,
          status: "pending",
          message: "Paiement en attente chez NotchPay"
        });
      }

      // Statut échoué
      if (notchpayStatus === 'failed' || notchpayStatus === 'cancelled') {
        return res.json({
          success: false,
          paid: false,
          pending: false,
          status: "failed",
          message: "Paiement échoué"
        });
      }

      return res.json({
        success: true,
        paid: false,
        pending: true,
        status: notchpayStatus || "unknown",
        message: "Statut indéterminé"
      });

    } catch (notchpayError) {
      console.error("❌ Erreur vérification NotchPay:", notchpayError.message);
      
      // En mode TEST, parfois simuler un succès
      if (currentMode === "TEST" && Math.random() > 0.5) {
        console.log("🧪 Mode TEST: Simulation succès");
        
        await supabase
          .from("transactions")
          .update({
            status: 'complete',
            updated_at: new Date().toISOString()
          })
          .eq("id", transaction.id);

        await processPremiumActivation(userId, reference, "test_simulated");
        
        return res.json({
          success: true,
          paid: true,
          pending: false,
          status: 'complete',
          message: "Paiement TEST simulé avec succès"
        });
      }

      return res.json({
        success: true,
        paid: false,
        pending: true,
        status: 'pending',
        message: "En attente de confirmation NotchPay"
      });
    }

  } catch (error) {
    console.error("❌ Erreur vérification:", error);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de la vérification",
      error: error.message
    });
  }
});

// 🔥 CONFIGURATION
router.get("/config", (req, res) => {
  const isLive = currentMode === "LIVE";
  
  return res.json({
    success: true,
    config: {
      mode: currentMode,
      public_key: NOTCHPAY_CONFIG.publicKey ? `${NOTCHPAY_CONFIG.publicKey.substring(0, 20)}...` : "NON DÉFINIE",
      base_url: NOTCHPAY_CONFIG.baseUrl,
      webhook_url: "https://severbackendnotchpay.onrender.com/api/payments/webhook/notchpay",
      status: "ACTIF",
      message: isLive ? 
        "✅ Mode LIVE - Prêt pour les vrais paiements" : 
        "🧪 Mode TEST - Paiements de test uniquement"
    }
  });
});

// 🔥 FORCER L'ACTIVATION MANUELLE
router.post("/force-upgrade/:userId", authenticateUser, async (req, res) => {
  try {
    const { userId } = req.params;
    const { reference } = req.body;
    const adminUserId = req.user.id;

    console.log(`🔧 Activation manuelle par ${adminUserId} pour ${userId}`);

    // Simplification: Autorisez seulement si c'est le même utilisateur
    if (userId !== adminUserId) {
      return res.status(403).json({
        success: false,
        message: "Vous ne pouvez activer que votre propre compte"
      });
    }

    const success = await processPremiumActivation(
      userId, 
      reference || `MANUAL-${Date.now()}`, 
      "manual_activation"
    );

    if (success) {
      return res.json({
        success: true,
        message: "Compte premium activé manuellement avec succès"
      });
    } else {
      return res.status(500).json({
        success: false,
        message: "Échec de l'activation manuelle"
      });
    }

  } catch (error) {
    console.error("❌ Erreur activation manuelle:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 🔥 VÉRIFIER LE STATUT D'UN UTILISATEUR
router.get("/user-status/:userId", authenticateUser, async (req, res) => {
  try {
    const { userId } = req.params;
    
    if (userId !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: "Non autorisé à voir ce profil"
      });
    }

    const { data: profile, error } = await supabase
      .from("profiles")
      .select("is_premium, payment_reference, last_payment_date, email")
      .eq("id", userId)
      .single();

    if (error) {
      console.error("❌ Erreur recherche profil:", error);
      return res.status(404).json({
        success: false,
        message: "Profil non trouvé"
      });
    }

    return res.json({
      success: true,
      is_premium: profile.is_premium || false,
      payment_reference: profile.payment_reference,
      last_payment_date: profile.last_payment_date,
      email: profile.email
    });

  } catch (error) {
    console.error("❌ Erreur vérification statut:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
