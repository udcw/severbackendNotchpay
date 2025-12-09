const express = require("express");
const axios = require("axios");
const { authenticateUser, supabase } = require("../middleware/auth");

const router = express.Router();

// Supprimez le deuxième `const express = require("express");` et la création du router

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

// 🔥 FONCTION D'ACTIVATION PREMIUM - SEULEMENT APRÈS PAIEMENT RÉUSSI
async function processPremiumActivation(userId, reference, status) {
  try {
    console.log(`🔄 Activation premium pour: ${userId}, référence: ${reference}`);
    
    if (!userId || userId === "unknown") {
      console.error("❌ ID utilisateur manquant");
      return false;
    }

    // Vérifier d'abord que le paiement est bien "complete" ou "success"
    const { data: transaction } = await supabase
      .from("transactions")
      .select("status, amount")
      .eq("reference", reference)
      .eq("user_id", userId)
      .single();

    if (!transaction) {
      console.error("❌ Transaction non trouvée pour cet utilisateur");
      return false;
    }

    if (transaction.status !== 'complete' && transaction.status !== 'success') {
      console.error(`❌ Statut de transaction invalide pour activation: ${transaction.status}`);
      return false;
    }

    // Vérifier que le montant est au moins 25 FCFA
    if (transaction.amount < 25) {
      console.error(`❌ Montant insuffisant pour activation premium: ${transaction.amount}`);
      return false;
    }

    // Mettre à jour le profil
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

    // Vérifier que la mise à jour a fonctionné
    const { data: updatedProfile } = await supabase
      .from("profiles")
      .select("is_premium, email")
      .eq("id", userId)
      .single();

    console.log(`✅ Profil ${updatedProfile?.email || userId} mis à jour: is_premium=${updatedProfile?.is_premium}`);

    return true;

  } catch (error) {
    console.error("❌ Erreur activation premium:", error);
    return false;
  }
}

// 🔥 INITIALISER UN PAIEMENT
router.post("/initialize", authenticateUser, async (req, res) => {
  console.log("=== 🚀 INITIALISATION PAIEMENT ===");

  try {
    const { amount = 25, description = "Abonnement Premium Kamerun News" } = req.body;
    const userId = req.user.id;
    const userEmail = req.user.email;

    console.log(`👤 Utilisateur: ${userEmail} (${userId})`);
    console.log(`💰 Montant demandé: ${amount} FCFA`);
    console.log(`📝 Description: ${description}`);

    // Validation stricte
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

    // Créer l'enregistrement dans Supabase
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
    console.log("📝 Payload:", JSON.stringify(payload, null, 2));

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
      console.log("✅ Réponse NotchPay reçue:", JSON.stringify(data, null, 2));

      // Extraire l'URL de paiement
      let paymentUrl = data.authorization_url || 
                      data.checkout_url || 
                      data.transaction?.authorization_url ||
                      data.links?.authorization_url;

      if (!paymentUrl) {
        console.error("❌ Pas d'URL de paiement dans la réponse:", data);
        
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
        console.error("📡 Détails de l'erreur:", JSON.stringify(error.response.data, null, 2));
      } else if (error.request) {
        console.error("📡 Aucune réponse reçue:", error.request);
      } else {
        console.error("📡 Erreur de configuration:", error.message);
      }

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

// 🔥 WEBHOOK NOTCHPAY - SEULE SOURCE D'ACTIVATION PREMIUM
router.post("/webhook/notchpay", async (req, res) => {
  console.log("=== 📩 WEBHOOK NOTCHPAY REÇU ===");
  
  try {
    const payload = req.body;
    console.log("📦 Données reçues:", JSON.stringify(payload, null, 2));

    // Extraire les informations
    let transactionData = payload.data || payload.transaction || payload;
    let reference = transactionData.reference || transactionData.merchant_reference;
    let status = transactionData.status || payload.event?.replace('payment.', '');
    
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
          user_id: userId !== "unknown" ? userId : null,
          metadata: {
            webhook_data: payload,
            created_from_webhook: true,
            received_at: new Date().toISOString()
          }
        })
        .select()
        .single();
      
      // NE PAS activer premium si la transaction vient d'être créée depuis le webhook
      // Attendre une vérification manuelle ou un deuxième webhook
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

    // Traiter l'activation premium UNIQUEMENT si paiement réussi
    if (status === 'complete' || status === 'success' || status === 'completed') {
      // Vérifier que l'utilisateur existe et que la transaction est valide
      if (transaction.user_id && transaction.amount >= 25) {
        await processPremiumActivation(transaction.user_id, reference, status);
      } else {
        console.log(`⚠️ Transaction ${reference} non éligible pour activation premium`);
      }
    }

    console.log(`✅ Webhook traité pour ${reference}`);

    return res.status(200).json({ 
      success: true, 
      message: "Webhook traité avec succès",
      reference: reference,
      status: status
    });

  } catch (error) {
    console.error("❌ Erreur traitement webhook:", error);
    return res.status(200).json({ 
      received: true, 
      error: error.message 
    });
  }
});

// 🔥 VÉRIFIER UN PAIEMENT (pour le frontend après redirection)
router.get("/verify/:reference", authenticateUser, async (req, res) => {
  try {
    const { reference } = req.params;
    const userId = req.user.id;

    console.log(`🔍 Vérification manuelle: ${reference} pour ${userId}`);

    // Chercher la transaction
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

    // Si déjà complet, vérifier le profil
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
          "Paiement confirmé - Activation en cours..."
      });
    }

    // Vérifier avec NotchPay
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
        const activated = await processPremiumActivation(userId, reference, notchpayStatus);
        
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
          message: activated ? 
            "Paiement confirmé - Compte premium activé" : 
            "Paiement confirmé mais problème d'activation"
        });
      }

      // Statuts divers
      if (notchpayStatus === 'pending') {
        return res.json({
          success: true,
          paid: false,
          pending: true,
          status: "pending",
          message: "Paiement en attente chez NotchPay"
        });
      }

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
      
      // En mode TEST, NE PAS simuler de succès automatique
      // L'utilisateur DOIT vraiment payer
      
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

// 🔥 CONFIGURATION (sans accès aux clés sensibles)
router.get("/config", authenticateUser, (req, res) => {
  const isLive = currentMode === "LIVE";
  
  return res.json({
    success: true,
    config: {
      mode: currentMode,
      base_url: NOTCHPAY_CONFIG.baseUrl,
      webhook_url: "https://severbackendnotchpay.onrender.com/api/payments/webhook/notchpay",
      status: "ACTIF",
      message: isLive ? 
        "✅ Mode LIVE - Paiements réels activés" : 
        "🧪 Mode TEST - Paiements de démonstration"
    }
  });
});

// 🔥 VÉRIFIER LE STATUT PREMIUM DE L'UTILISATEUR
router.get("/user-status", authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;

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

// 🔥 ROUTE POUR REDIRIGER APRÈS PAIEMENT (pour le frontend)
router.get("/callback/:reference", async (req, res) => {
  try {
    const { reference } = req.params;
    
    // Rediriger vers le frontend avec la référence
    const frontendUrl = `https://kamerun-news.com/payment-callback?reference=${reference}`;
    
    res.redirect(frontendUrl);
  } catch (error) {
    console.error("❌ Erreur redirection:", error);
    res.redirect(`https://kamerun-news.com/payment-error`);
  }
});

module.exports = router;
