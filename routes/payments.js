const express = require("express");
const axios = require("axios");
const { authenticateUser, supabase } = require("../middleware/auth");

const router = express.Router();

// 🔥 CONFIGURATION NOTCHPAY - PASSER EN MODE LIVE !
const NOTCHPAY_CONFIG = {
  publicKey: process.env.NOTCHPAY_PUBLIC_KEY,
  secretKey: process.env.NOTCHPAY_SECRET_KEY,
  baseUrl: process.env.NOTCHPAY_BASE_URL || "https://api.notchpay.co",
  mode: process.env.NOTCHPAY_MODE || "LIVE", // FORCER LE MODE LIVE
};

// 🔥 VALIDATION DES CLÉS
const validateKeys = () => {
  const publicKey = NOTCHPAY_CONFIG.publicKey;
  const secretKey = NOTCHPAY_CONFIG.secretKey;
  
  if (!publicKey || !secretKey) {
    console.error("❌ Clés NotchPay manquantes !");
    return false;
  }
  
  const isTestMode = publicKey.includes("SBX") || publicKey.includes("test");
  const isLiveMode = publicKey.includes("pk_live_");
  
  console.log(`🔐 Validation clés: ${isLiveMode ? 'LIVE' : isTestMode ? 'TEST' : 'INCONNU'}`);
  
  return { isLiveMode, isTestMode };
};

// 🔥 INITIER UN PAIEMENT (VERSION CORRIGÉE)
router.post("/initialize", authenticateUser, async (req, res) => {
  console.log("=== 🚀 INITIALISATION PAIEMENT ===");

  try {
    const { amount = 1000, description = "Abonnement Premium Kamerun News" } = req.body;
    const userId = req.user.id;

    // Validation
    if (amount !== 25) {
      console.error(`❌ Montant incorrect: ${amount} (devrait être 1000)`);
      return res.status(400).json({
        success: false,
        message: "Le montant doit être de 1000 FCFA",
      });
    }

    console.log(`👤 Utilisateur: ${req.user.email}`);
    console.log(`💰 Montant: ${amount} FCFA`);
    
    // Vérifier les clés
    const keyValidation = validateKeys();
    if (!keyValidation) {
      return res.status(500).json({
        success: false,
        message: "Configuration NotchPay manquante",
      });
    }
    
    const { isLiveMode, isTestMode } = keyValidation;
    const mode = isLiveMode ? "LIVE" : "TEST";
    
    console.log(`🔐 Mode: ${mode}`);

    // Générer une référence
    const reference = `KAMERUN-${Date.now()}-${Math.random()
      .toString(36)
      .substr(2, 9)}`;
    
    // IMPORTANT : Ne pas multiplier par 100 ! NotchPay attend déjà des XAF
    const amountForNotchpay = amount;

    // Données client
    const customerName = req.user.user_metadata?.full_name ||
                        req.user.user_metadata?.name ||
                        req.user.email.split("@")[0];

    // Payload NotchPay
    const payload = {
      amount: amountForNotchpay, // 1000 XAF
      currency: "XAF",
      description: description,
      reference: reference,
      email: req.user.email,
      customer: {
        name: customerName,
        email: req.user.email,
        phone: "",
      },
      callback_url: `${process.env.BACKEND_URL || "https://severbackendnotchpay.onrender.com"}/api/payments/webhook`,
      metadata: {
        userId: userId,
        userEmail: req.user.email,
        product: "Abonnement Premium",
        app: "Kamerun News",
        mode: mode,
        amount_xaf: amount,
      },
    };

    console.log("📤 Envoi à NotchPay...");
    console.log("📝 Référence:", reference);
    console.log("💰 Montant envoyé:", amountForNotchpay);
    console.log("🔐 Mode réel:", mode);

    try {
      const response = await axios.post(
        `${NOTCHPAY_CONFIG.baseUrl}/payments/initialize`,
        payload,
        {
          headers: {
            Authorization: NOTCHPAY_CONFIG.publicKey,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          timeout: 30000,
        }
      );

      console.log("✅ Réponse NotchPay reçue");

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
          data: data,
        });
      }

      console.log("🔗 URL de paiement:", paymentUrl.substring(0, 50) + "...");

      // Enregistrer la transaction dans Supabase
      const { data: transaction, error: dbError } = await supabase
        .from("transactions")
        .insert({
          user_id: userId,
          reference: reference,
          amount: amount,
          currency: "XAF",
          status: "pending",
          payment_method: "notchpay",
          metadata: {
            notchpay_response: data,
            payment_url: paymentUrl,
            mode: mode,
            customer_email: req.user.email,
            created_at: new Date().toISOString(),
          },
        })
        .select()
        .single();

      if (dbError) {
        console.error("❌ Erreur Supabase:", dbError.message);
      }

      return res.json({
        success: true,
        message: "Paiement initialisé avec succès",
        mode: mode,
        data: {
          authorization_url: paymentUrl,
          checkout_url: paymentUrl,
          reference: reference,
          transaction_id: transaction?.id,
        },
      });
    } catch (error) {
      console.error("❌ Erreur API NotchPay:", error.message);

      if (error.response) {
        console.error("📡 Détails erreur:", {
          status: error.response.status,
          data: error.response.data,
        });

        return res.status(error.response.status || 500).json({
          success: false,
          message: error.response.data?.message || "Erreur NotchPay",
          error: error.response.data,
          mode: mode,
        });
      }

      return res.status(500).json({
        success: false,
        message: "Erreur de communication avec NotchPay",
        error: error.message,
        mode: mode,
      });
    }
  } catch (error) {
    console.error("❌ Erreur globale:", error.message);
    return res.status(500).json({
      success: false,
      message: "Erreur interne du serveur",
      error: error.message,
    });
  }
});

// 🔥 VÉRIFIER UN PAIEMENT (VERSION CORRIGÉE)
router.get("/verify/:reference", authenticateUser, async (req, res) => {
  try {
    const { reference } = req.params;
    const userId = req.user.id;

    console.log(`🔍 Vérification transaction: ${reference}`);

    // 1. Chercher la transaction
    const { data: transaction, error } = await supabase
      .from("transactions")
      .select("*")
      .eq("reference", reference)
      .eq("user_id", userId)
      .single();

    if (error || !transaction) {
      return res.status(404).json({
        success: false,
        message: "Transaction non trouvée",
      });
    }

    console.log("✅ Transaction trouvée:", {
      id: transaction.id,
      montant: transaction.amount,
      statut: transaction.status,
      mode: transaction.metadata?.mode
    });

    // 2. Si déjà complété
    if (transaction.status === "complete" || transaction.status === "success" || transaction.status === "terminé") {
      console.log("ℹ️ Transaction déjà complétée");
      return res.json({
        success: true,
        paid: true,
        pending: false,
        status: "complete",
        message: "Paiement déjà confirmé",
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
            Accept: "application/json",
          },
          timeout: 10000,
        }
      );

      const data = response.data;
      console.log("📊 Réponse NotchPay:", JSON.stringify(data, null, 2));

      // Récupérer le statut
      const transactionData = data.transaction || data;
      const status = transactionData.status || "pending";
      const isComplete = status === "complete" || status === "success" || status === "terminé";
      const isPending = status === "pending" || status === "en attente";
      const isFailed = ["failed", "cancelled", "canceled", "expired", "échoué"].includes(status);

      console.log(`📊 Statut NotchPay: ${status}`);

      // Mettre à jour la transaction
      await supabase
        .from("transactions")
        .update({
          status: status,
          metadata: {
            ...transaction.metadata,
            verification_response: data,
            verified_at: new Date().toISOString(),
            notchpay_status: status,
          },
          updated_at: new Date().toISOString(),
          completed_at: isComplete ? new Date().toISOString() : null,
        })
        .eq("id", transaction.id);

      // Si paiement réussi
      if (isComplete) {
        console.log(`✅ Paiement réussi détecté pour l'utilisateur ${userId}`);
        
        // Mettre à jour le profil
        const { error: profileError } = await supabase
          .from("profiles")
          .update({
            is_premium: true,
            premium_activated_at: new Date().toISOString(),
            payment_reference: reference,
            last_payment_date: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", userId);

        if (profileError) {
          console.error("❌ Erreur mise à jour profil:", profileError);
        } else {
          console.log(`✅ Profil ${userId} mis à jour vers Premium`);
        }

        // Créer l'abonnement
        await supabase
          .from("subscriptions")
          .insert({
            user_id: userId,
            plan: "premium",
            transaction_reference: reference,
            status: "active",
            starts_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
          })
          .catch((err) => {
            console.log("⚠️ Erreur création abonnement:", err.message);
          });
      }

      return res.json({
        success: true,
        paid: isComplete,
        pending: isPending,
        failed: isFailed,
        status: status,
        message: isComplete
          ? "Paiement confirmé"
          : isFailed
          ? "Paiement échoué"
          : "Paiement en cours",
        user_upgraded: isComplete,
      });
    } catch (notchpayError) {
      console.error("⚠️ Erreur vérification NotchPay:", notchpayError.message);

      // En mode LIVE, ne pas simuler de succès
      const keyValidation = validateKeys();
      if (keyValidation && keyValidation.isTestMode) {
        console.log("🧪 Mode TEST: Simulation possible");
        
        // Pour le mode TEST seulement, simuler parfois un succès
        if (Math.random() > 0.5) {
          console.log("🧪 Simulation succès TEST");

          await supabase
            .from("transactions")
            .update({
              status: "complete",
              updated_at: new Date().toISOString(),
            })
            .eq("id", transaction.id);

          await supabase
            .from("profiles")
            .update({
              is_premium: true,
              premium_activated_at: new Date().toISOString(),
              payment_reference: reference,
              updated_at: new Date().toISOString(),
            })
            .eq("id", userId);

          return res.json({
            success: true,
            paid: true,
            pending: false,
            status: "complete",
            message: "Paiement TEST simulé",
            user_upgraded: true,
          });
        }
      }

      return res.json({
        success: true,
        paid: false,
        pending: true,
        status: "pending",
        message: "Paiement en cours de traitement chez NotchPay",
        user_upgraded: false,
      });
    }
  } catch (error) {
    console.error("❌ Erreur vérification:", error.message);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de la vérification",
      error: error.message,
    });
  }
});

// 🔥 WEBHOOK CORRIGÉ POUR MODE LIVE
router.post("/webhook", async (req, res) => {
  console.log("=== 📩 WEBHOOK NOTCHPAY REÇU ===");

  try {
    let payload;
    if (typeof req.body === "string") {
      try {
        payload = JSON.parse(req.body);
      } catch (e) {
        console.error("❌ Erreur parsing JSON:", e);
        payload = req.body;
      }
    } else {
      payload = req.body;
    }

    console.log("📦 Données webhook:", JSON.stringify(payload, null, 2));

    // 🔥 DÉTECTION DE L'ÉVÉNEMENT
    const event = payload.événement || payload.event;
    const data = payload.données || payload.data;
    
    if (!event || !data) {
      console.error("❌ Webhook mal formaté");
      return res.status(400).json({
        success: false,
        message: "Webhook mal formaté",
      });
    }

    console.log(`🔔 Événement: ${event}`);
    console.log(`📊 Statut: ${data.statut || data.status}`);
    console.log(`💰 Montant: ${data.montant || data.amount}`);
    console.log(`📝 Référence: ${data.merchant_reference || data.reference}`);

    // 🔥 RÉCUPÉRER LA RÉFÉRENCE
    const reference = data.merchant_reference || data.trxref || data.référence;
    
    if (!reference) {
      console.error("❌ Référence manquante dans le webhook");
      return res.status(400).json({
        success: false,
        message: "Référence manquante",
      });
    }

    console.log(`🔍 Recherche transaction: ${reference}`);

    // 🔥 CHERCHER LA TRANSACTION
    const { data: transaction, error: transactionError } = await supabase
      .from("transactions")
      .select("*")
      .eq("reference", reference)
      .single();

    if (transactionError || !transaction) {
      console.error("❌ Transaction non trouvée:", transactionError?.message);
      return res.status(404).json({
        success: false,
        message: "Transaction non trouvée",
      });
    }

    console.log("✅ Transaction trouvée:", transaction.id);

    // 🔥 DÉTERMINER LE STATUT
    const status = data.statut || data.status;
    const isComplete = status === "complete" || status === "success" || status === "terminé";
    const isFailed = status === "failed" || status === "cancelled" || status === "échoué";

    console.log(`📊 Statut à appliquer: ${status} (complet: ${isComplete})`);

    // 🔥 METTRE À JOUR LA TRANSACTION
    const { error: updateError } = await supabase
      .from("transactions")
      .update({
        status: status,
        metadata: {
          ...transaction.metadata,
          webhook_data: payload,
          webhook_received_at: new Date().toISOString(),
          notchpay_status: status,
        },
        updated_at: new Date().toISOString(),
        completed_at: isComplete ? new Date().toISOString() : null,
      })
      .eq("reference", reference);

    if (updateError) {
      console.error("❌ Erreur mise à jour transaction:", updateError.message);
    } else {
      console.log("✅ Transaction mise à jour");
    }

    // 🔥 SI PAIEMENT RÉUSSI, METTRE À JOUR L'UTILISATEUR
    if (isComplete) {
      const userId = transaction.user_id;
      console.log(`🎯 Activation Premium pour l'utilisateur: ${userId}`);

      // Mettre à jour le profil
      const { error: profileError } = await supabase
        .from("profiles")
        .update({
          is_premium: true,
          premium_activated_at: new Date().toISOString(),
          payment_reference: reference,
          last_payment_date: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", userId);

      if (profileError) {
        console.error("❌ Erreur mise à jour profil:", profileError.message);
      } else {
        console.log(`✅ Utilisateur ${userId} mis à jour vers Premium`);
      }

      // Créer l'abonnement
      await supabase
        .from("subscriptions")
        .insert({
          user_id: userId,
          plan: "premium",
          transaction_reference: reference,
          status: "active",
          starts_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .catch((err) => {
          console.log("⚠️ Erreur création abonnement:", err.message);
        });
    }

    // 🔥 RÉPONDRE À NOTCHPAY
    return res.json({
      success: true,
      message: "Webhook traité avec succès",
      transaction_updated: true,
      user_upgraded: isComplete,
    });
  } catch (error) {
    console.error("❌ Erreur webhook:", error);
    return res.status(500).json({
      success: false,
      message: "Erreur lors du traitement du webhook",
    });
  }
});

// 🔥 CONFIGURATION
router.get("/config", (req, res) => {
  const keyValidation = validateKeys();
  
  if (!keyValidation) {
    return res.json({
      success: false,
      config: {
        mode: "ERROR",
        message: "Clés NotchPay non configurées"
      }
    });
  }
  
  const { isLiveMode, isTestMode } = keyValidation;
  const mode = isLiveMode ? "LIVE" : isTestMode ? "TEST" : "INCONNU";
  
  return res.json({
    success: true,
    config: {
      mode: mode,
      status: isLiveMode ? "🚀 PRÊT POUR LES VRAIS PAIEMENTS" : "🧪 MODE TEST",
      message: isLiveMode 
        ? "✅ Mode LIVE - Les vrais paiements sont activés"
        : "⚠️ Mode TEST - Remplacez par des clés LIVE pour accepter de vrais paiements"
    }
  });
});

// 🔥 ROUTE DE DÉPANNAGE : Forcer l'activation manuelle
router.post("/force-upgrade/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { reference } = req.body;

    console.log(`🔧 Activation manuelle pour: ${userId}, référence: ${reference}`);

    // Mettre à jour le profil
    const { error: profileError } = await supabase
      .from("profiles")
      .update({
        is_premium: true,
        premium_activated_at: new Date().toISOString(),
        payment_reference: reference,
        last_payment_date: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId);

    if (profileError) {
      console.error("❌ Erreur activation manuelle:", profileError);
      return res.status(500).json({
        success: false,
        message: "Erreur lors de l'activation manuelle",
        error: profileError.message,
      });
    }

    // Créer l'abonnement
    await supabase
      .from("subscriptions")
      .insert({
        user_id: userId,
        plan: "premium",
        transaction_reference: reference,
        status: "active",
        starts_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .catch((err) => {
        console.log("⚠️ Erreur création abonnement:", err.message);
      });

    console.log(`✅ Activation manuelle réussie pour ${userId}`);

    return res.json({
      success: true,
      message: "Utilisateur activé manuellement en Premium",
    });
  } catch (error) {
    console.error("❌ Erreur activation manuelle:", error);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de l'activation manuelle",
      error: error.message,
    });
  }
});

module.exports = router;
