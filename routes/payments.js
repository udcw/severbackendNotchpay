const express = require("express");
const axios = require("axios");
const { authenticateUser, supabase } = require("../middleware/auth");

const router = express.Router();

// 🔥 CONFIGURATION NOTCHPAY - MODE LIVE
const NOTCHPAY_CONFIG = {
  publicKey: process.env.NOTCHPAY_PUBLIC_KEY,
  secretKey: process.env.NOTCHPAY_SECRET_KEY,
  baseUrl: process.env.NOTCHPAY_BASE_URL || "https://api.notchpay.co",
  mode: process.env.NOTCHPAY_MODE || "LIVE", // 🔥 Changé à LIVE
};

// 🔥 VALIDATION DES CLÉS - MODE LIVE
const validateKeys = () => {
  const publicKey = NOTCHPAY_CONFIG.publicKey;
  const secretKey = NOTCHPAY_CONFIG.secretKey;
  
  if (!publicKey || !secretKey) {
    console.error("❌ Clés NotchPay manquantes !");
    return false;
  }
  
  // 🔥 Détection du mode LIVE
  const isTestMode = publicKey.includes("SBX") || publicKey.includes("test");
  const isLiveMode = publicKey.includes("pk_live_") || NOTCHPAY_CONFIG.mode === "LIVE";
  
  console.log(`🔐 Validation clés: ${isLiveMode ? 'LIVE' : isTestMode ? 'TEST' : 'INCONNU'}`);
  
  return { isLiveMode, isTestMode };
};

// 🔥 CRÉER UN PROFIL SI N'EXISTE PAS
const ensureProfileExists = async (userId, email) => {
  try {
    console.log(`🔍 Vérification profil pour: ${userId}`);
    
    const { data: existingProfile, error } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", userId)
      .maybeSingle();
    
    if (error && error.code !== 'PGRST116') {
      console.error("❌ Erreur vérification profil:", error);
    }
    
    if (!existingProfile) {
      console.log(`📝 Création du profil pour: ${userId}`);
      
      const { data: newProfile, error: createError } = await supabase
        .from("profiles")
        .insert({
          id: userId,
          email: email,
          is_premium: false,
          first_name: "",
          last_name: "",
          tribe: "",
          phone: "",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .select()
        .single();
      
      if (createError) {
        console.error("❌ Erreur création profil:", createError);
        return { success: false, error: createError };
      }
      
      console.log(`✅ Profil créé: ${newProfile.id}`);
      return { success: true, profile: newProfile };
    }
    
    return { success: true, profile: existingProfile };
  } catch (error) {
    console.error("❌ Erreur ensureProfileExists:", error);
    return { success: false, error: error.message };
  }
};

// 🔥 INITIER UN PAIEMENT - MODE LIVE (1000 FCFA)
router.post("/initialize", authenticateUser, async (req, res) => {
  console.log("=== 🚀 INITIALISATION PAIEMENT LIVE ===");

  try {
    // 🔥 MONTANT LIVE: 1000 FCFA
    const { amount = 1000, description = "Abonnement Premium Kamerun News" } = req.body;
    const userId = req.user.id;
    const userEmail = req.user.email;

    // 🔥 VÉRIFIER SI LE PROFIL EXISTE
    const profileCheck = await ensureProfileExists(userId, userEmail);
    if (!profileCheck.success) {
      return res.status(500).json({
        success: false,
        message: "Erreur lors de la vérification du profil utilisateur",
      });
    }

    // 🔥 VÉRIFICATION DU MONTANT POUR LE MODE LIVE
    const keyValidation = validateKeys();
    const { isLiveMode } = keyValidation;
    
    if (isLiveMode && amount !== 1000) {
      console.error(`❌ Montant incorrect pour LIVE: ${amount} (devrait être 1000 FCFA)`);
      return res.status(400).json({
        success: false,
        message: "Le montant doit être de 1000 FCFA pour les paiements réels",
      });
    }

    console.log(`👤 Utilisateur: ${userEmail}`);
    console.log(`💰 Montant LIVE: ${amount} FCFA`);
    console.log(`🔐 Mode: ${isLiveMode ? 'LIVE' : 'TEST'}`);

    // Montant pour NotchPay (en unités XAF)
    const amountForNotchpay = amount;

    // 🔥 GÉNÉRER UNE RÉFÉRENCE UNIQUE POUR LIVE
    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 12);
    const reference = `KAMERUN-LIVE-${timestamp}-${randomString}`;
    
    console.log(`📝 Référence LIVE générée: ${reference}`);
    console.log(`💰 Montant envoyé à NotchPay: ${amountForNotchpay} XAF`);

    // Données client
    const customerName = req.user.user_metadata?.full_name ||
                        req.user.user_metadata?.name ||
                        userEmail.split("@")[0];

    // 🔥 PAYLOAD POUR MODE LIVE
    const payload = {
      amount: amountForNotchpay,
      currency: "XAF",
      description: description,
      reference: reference,
      email: userEmail,
      customer: {
        name: customerName,
        email: userEmail,
        phone: req.body.phone || "",
      },
      callback_url: `${process.env.BACKEND_URL}/api/payments/webhook`,
      metadata: {
        userId: userId,
        userEmail: userEmail,
        product: "Abonnement Premium Kamerun News",
        app: "Kamerun News",
        amount_xaf: amount,
      },
    };

    console.log("📤 Envoi à NotchPay (LIVE)...");

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

      console.log("✅ Réponse NotchPay LIVE reçue");

      const data = response.data;
      console.log("📊 Données NotchPay LIVE:", JSON.stringify(data, null, 2));

      // 🔥 RÉCUPÉRATION DE L'URL DE PAIEMENT
      let paymentUrl = data.authorization_url || 
                      data.transaction?.authorization_url ||
                      data.checkout_url ||
                      data.transaction?.checkout_url ||
                      data.links?.authorization_url ||
                      data.links?.checkout ||
                      data.url;

      if (!paymentUrl) {
        console.error("❌ Aucune URL de paiement trouvée dans la réponse LIVE");
        return res.status(500).json({
          success: false,
          message: "URL de paiement non reçue de NotchPay (LIVE)",
          data: data,
        });
      }

      console.log("🔗 URL de paiement LIVE:", paymentUrl);

      // 🔥 ENREGISTRER LA TRANSACTION DANS SUPABASE
      const transactionId = `txn_live_${timestamp}_${randomString}`;
      
      const { data: transaction, error: dbError } = await supabase
        .from("transactions")
        .insert({
          id: transactionId,
          user_id: userId,
          reference: reference,
          amount: amount,
          currency: "XAF",
          status: "pending",
          payment_method: "notchpay",
          metadata: {
            notchpay_response: data,
            payment_url: paymentUrl,
            mode: "LIVE",
            customer_email: userEmail,
            created_at: new Date().toISOString(),
          },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (dbError) {
        console.error("❌ Erreur Supabase (transaction LIVE):", dbError.message);
      }

      return res.json({
        success: true,
        message: "Paiement LIVE initialisé avec succès",
        mode: "LIVE",
        data: {
          authorization_url: paymentUrl,
          checkout_url: paymentUrl,
          reference: reference,
          transaction_id: transaction?.id || transactionId,
          amount: amount,
        },
      });
    } catch (error) {
      console.error("❌ Erreur API NotchPay LIVE:", error.message);

      if (error.response) {
        console.error("📡 Détails erreur LIVE:", {
          status: error.response.status,
          data: error.response.data,
        });

        return res.status(error.response.status || 500).json({
          success: false,
          message: error.response.data?.message || "Erreur NotchPay LIVE",
          error: error.response.data,
          mode: "LIVE",
        });
      }

      return res.status(500).json({
        success: false,
        message: "Erreur de communication avec NotchPay (LIVE)",
        error: error.message,
        mode: "LIVE",
      });
    }
  } catch (error) {
    console.error("❌ Erreur globale LIVE:", error.message);
    return res.status(500).json({
      success: false,
      message: "Erreur interne du serveur",
      error: error.message,
    });
  }
});

// 🔥 VÉRIFIER UN PAIEMENT - MODE LIVE
router.get("/verify/:reference", authenticateUser, async (req, res) => {
  try {
    const { reference } = req.params;
    const userId = req.user.id;
    const userEmail = req.user.email;

    console.log(`🔍 Vérification transaction LIVE: ${reference}`);

    // 🔥 VÉRIFIER SI LE PROFIL EXISTE
    await ensureProfileExists(userId, userEmail);

    // Chercher la transaction
    const { data: transaction, error } = await supabase
      .from("transactions")
      .select("*")
      .eq("reference", reference)
      .eq("user_id", userId)
      .single();

    if (error || !transaction) {
      console.error("❌ Transaction LIVE non trouvée:", error?.message);
      return res.status(404).json({
        success: false,
        message: "Transaction non trouvée",
      });
    }

    console.log("✅ Transaction LIVE trouvée:", {
      id: transaction.id,
      montant: transaction.amount,
      statut: transaction.status,
      mode: transaction.metadata?.mode
    });

    // Si déjà complété
    if (transaction.status === "complete" || transaction.status === "success") {
      console.log("ℹ️ Transaction LIVE déjà complétée");
      return res.json({
        success: true,
        paid: true,
        pending: false,
        status: "complete",
        message: "Paiement déjà confirmé",
        user_upgraded: true,
      });
    }

    // 🔥 VÉRIFICATION AVEC NOTCHPAY EN MODE LIVE
    try {
      console.log(`🔍 Vérification chez NotchPay (LIVE): ${reference}`);

      const response = await axios.get(
        `${NOTCHPAY_CONFIG.baseUrl}/payments/${reference}`,
        {
          headers: {
            Authorization: NOTCHPAY_CONFIG.publicKey,
            Accept: "application/json",
          },
          timeout: 15000,
        }
      );

      const data = response.data;
      console.log("📊 Réponse NotchPay LIVE:", JSON.stringify(data, null, 2));

      // Récupérer le statut
      const transactionData = data.transaction || data;
      const status = transactionData.status || "pending";
      const isComplete = status === "complete" || status === "success";
      const isPending = status === "pending";
      const isFailed = ["failed", "cancelled", "canceled", "expired"].includes(status);

      console.log(`📊 Statut NotchPay LIVE: ${status}`);

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
        console.log(`✅ Paiement LIVE réussi pour l'utilisateur ${userId}`);
        
        const { error: profileError } = await supabase
          .from("profiles")
          .update({
            is_premium: true,
            payment_reference: reference,
            last_payment_date: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", userId);

        if (profileError) {
          console.error("❌ Erreur mise à jour profil LIVE:", profileError);
        } else {
          console.log(`✅ Profil ${userId} mis à jour vers Premium (LIVE)`);
        }
      }

      return res.json({
        success: true,
        paid: isComplete,
        pending: isPending,
        failed: isFailed,
        status: status,
        message: isComplete
          ? "Paiement LIVE confirmé (1000 FCFA)"
          : isFailed
          ? "Paiement LIVE échoué"
          : "Paiement LIVE en cours",
        user_upgraded: isComplete,
      });
    } catch (notchpayError) {
      console.error("⚠️ Erreur vérification NotchPay LIVE:", notchpayError.message);

      if (notchpayError.response?.status === 404) {
        console.log("⚠️ Transaction non trouvée chez NotchPay (404)");
        return res.json({
          success: true,
          paid: false,
          pending: true,
          status: "pending",
          message: "Transaction en cours de traitement chez NotchPay",
          user_upgraded: false,
        });
      }

      return res.status(500).json({
        success: false,
        message: "Erreur lors de la vérification chez NotchPay (LIVE)",
        error: notchpayError.message,
      });
    }
  } catch (error) {
    console.error("❌ Erreur vérification LIVE:", error.message);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de la vérification",
      error: error.message,
    });
  }
});

// 🔥 WEBHOOK POUR MODE LIVE
router.post("/webhook", async (req, res) => {
  console.log("=== 📩 WEBHOOK NOTCHPAY LIVE REÇU ===");

  try {
    const payload = req.body;
    console.log("📦 Données webhook LIVE:", JSON.stringify(payload, null, 2));

    // Récupérer la référence
    const reference = payload.reference || payload.data?.reference || payload.transaction?.reference;
    
    if (!reference) {
      console.error("❌ Référence manquante dans le webhook LIVE");
      return res.status(400).json({ success: false, message: "Référence manquante" });
    }

    console.log(`🔍 Recherche transaction LIVE: ${reference}`);

    // Chercher la transaction
    const { data: transactions, error: transactionError } = await supabase
      .from("transactions")
      .select("*")
      .eq("reference", reference)
      .limit(1);

    if (transactionError || !transactions || transactions.length === 0) {
      console.error("❌ Transaction LIVE non trouvée:", transactionError?.message);
      return res.status(404).json({ success: false, message: "Transaction non trouvée" });
    }

    const transaction = transactions[0];
    console.log("✅ Transaction LIVE trouvée:", transaction.id);

    // Déterminer le statut
    const status = payload.status || payload.data?.status || "pending";
    const isComplete = status === "complete" || status === "success";

    console.log(`📊 Statut à appliquer: ${status} (complet: ${isComplete})`);

    // Mettre à jour la transaction
    await supabase
      .from("transactions")
      .update({
        status: status,
        metadata: {
          ...transaction.metadata,
          webhook_data: payload,
          webhook_received_at: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
        completed_at: isComplete ? new Date().toISOString() : null,
      })
      .eq("id", transaction.id);

    // Si paiement réussi, mettre à jour l'utilisateur
    if (isComplete) {
      const userId = transaction.user_id;
      console.log(`🎯 Activation Premium LIVE pour l'utilisateur: ${userId}`);

      // Vérifier et créer le profil si n'existe pas
      await ensureProfileExists(userId, transaction.metadata?.customer_email);

      const { error: profileError } = await supabase
        .from("profiles")
        .update({
          is_premium: true,
          payment_reference: reference,
          last_payment_date: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", userId);

      if (profileError) {
        console.error("❌ Erreur mise à jour profil LIVE:", profileError.message);
      } else {
        console.log(`✅ Utilisateur ${userId} mis à jour vers Premium (LIVE)`);
      }
    }

    return res.json({ success: true, message: "Webhook LIVE traité" });
  } catch (error) {
    console.error("❌ Erreur webhook LIVE:", error);
    return res.status(500).json({ success: false, message: "Erreur lors du traitement" });
  }
});

// 🔥 CONFIGURATION - MODE LIVE
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
  const mode = isLiveMode ? "LIVE" : "TEST";
  
  return res.json({
    success: true,
    config: {
      mode: mode,
      amount: isLiveMode ? 1000 : 25,
      currency: "XAF",
      status: isLiveMode ? "🚀 MODE LIVE ACTIVÉ" : "🧪 MODE TEST",
      message: isLiveMode 
        ? "✅ Prêt pour les vrais paiements - 1000 FCFA"
        : "⚠️ Mode TEST - Paiements simulés à 25 FCFA"
    }
  });
});

module.exports = router;
