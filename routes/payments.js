const express = require("express");
const axios = require("axios");
const { authenticateUser, supabase } = require("../middleware/auth");

const router = express.Router();

// CONFIGURATION NOTCHPAY
const NOTCHPAY_CONFIG = {
  publicKey:
    process.env.NOTCHPAY_PUBLIC_KEY ||
    "pk.SBXvy0Fe1pGfFWwABmBAw7aSu8xcSaHZNiW2aRxWZe9oF2m59rbjtRa0je1UhqJfQ3NGn3TzyqrYHbLFLKElE1nKVSZQJcQ9wAOczNBYG66zHX4svoGmTpaWLDrVY",
  secretKey:
    process.env.NOTCHPAY_SECRET_KEY ||
    "sk.OjkG6OCmWq6LmMU2arL79NjZtDI8XQq4QKrIRnG1yQL5Sjv5SQzw6LDuzqhwNRx151maxwzehBTVjzGqsGjOr7y0s1k7auKRfIrmOgDXnYjziLUL8ILQQtDxQY00k",
  baseUrl: "https://api.notchpay.co",
  webhookSecret: process.env.NOTCHPAY_WEBHOOK_SECRET,
};

// DÉTECTER LE MODE
function detectMode(publicKey) {
  if (!publicKey) return "TEST";
  if (publicKey.includes("pk_live_")) return "LIVE";
  if (publicKey.includes("pk_test_")) return "TEST";
  if (publicKey.includes("SBX")) return "TEST"; // Clé Sandbox
  return "TEST";
}

const currentMode = detectMode(NOTCHPAY_CONFIG.publicKey);
console.log(`Mode NotchPay détecté: ${currentMode}`);

// FONCTION D'ACTIVATION PREMIUM - SEULEMENT APRÈS PAIEMENT RÉUSSI DE 25 FCFA
async function processPremiumActivation(userId, reference, status) {
  try {
    console.log(`Activation premium pour: ${userId}, référence: ${reference}`);

    if (!userId || userId === "unknown") {
      console.error("ID utilisateur manquant");
      return false;
    }

    // Chercher la transaction par notre référence (merchant_reference)
    const { data: transaction } = await supabase
      .from("transactions")
      .select("status, amount")
      .eq("reference", reference) // C'est notre merchant_reference
      .eq("user_id", userId)
      .single();

    if (!transaction) {
      console.error("Transaction non trouvée pour cet utilisateur");
      return false;
    }

    if (transaction.status !== "complete" && transaction.status !== "success") {
      console.error(
        `Statut de transaction invalide pour activation: ${transaction.status}`
      );
      return false;
    }

    // Vérifier que le montant est EXACTEMENT 25 FCFA
    if (Math.abs(transaction.amount - 25) > 0.01) {
      console.error(
        `Montant incorrect pour activation premium: ${transaction.amount} FCFA (attendu: 25 FCFA)`
      );
      return false;
    }

    // Activer premium
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
      console.error("Erreur mise à jour profil:", profileError);
      return false;
    }

    // Vérifier que la mise à jour a fonctionné
    const { data: updatedProfile } = await supabase
      .from("profiles")
      .select("is_premium, email")
      .eq("id", userId)
      .single();

    console.log(
      `Profil ${updatedProfile?.email || userId} mis à jour: is_premium=${
        updatedProfile?.is_premium
      }`
    );

    return true;
  } catch (error) {
    console.error("Erreur activation premium:", error);
    return false;
  }
}

// INITIALISER UN PAIEMENT DE 25 FCFA FIXE
router.post("/initialize", authenticateUser, async (req, res) => {
  console.log("=== INITIALISATION PAIEMENT 25 FCFA ===");

  try {
    const { description = "Abonnement Premium Kamerun News" } = req.body;
    const userId = req.user.id;
    const userEmail = req.user.email;
    const amount = 25; // MONTANT FIXE DE 25 FCFA

    console.log(`Utilisateur: ${userEmail} (${userId})`);
    console.log(`Montant FIXE: ${amount} FCFA`);
    console.log(`Description: ${description}`);

    // Générer une référence unique
    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 10);
    const reference = `KAMERUN-${timestamp}-${randomStr}`.toUpperCase();

    // IMPORTANT: NotchPay attend le montant en centimes pour 25 FCFA
    const amountForNotchpay = 2500; // 25 FCFA * 100 = 2500 centimes

    // Créer l'enregistrement dans Supabase
    const { data: transaction, error: txError } = await supabase
      .from("transactions")
      .insert({
        user_id: userId,
        reference: reference,
        amount: amount, // 25 FCFA
        currency: "XAF",
        status: "pending",
        metadata: {
          user_email: userEmail,
          description: description,
          mode: currentMode,
          fixed_amount: "25 FCFA",
          notchpay_amount_in_cents: amountForNotchpay,
          created_at: new Date().toISOString(),
        },
      })
      .select()
      .single();

    if (txError) {
      console.error("Erreur création transaction:", txError);
      return res.status(500).json({
        success: false,
        message: "Erreur création transaction",
        error: txError.message,
      });
    }

    console.log(`Transaction créée: ${reference} - 25 FCFA (${amountForNotchpay} centimes)`);

    // Données pour NotchPay - MONTANT EN CENTIMES
    const customerName =
      req.user.user_metadata?.full_name ||
      req.user.user_metadata?.name ||
      userEmail.split("@")[0];

    const payload = {
      amount: amountForNotchpay, // 2500 centimes = 25 FCFA
      currency: "XAF",
      description: description,
      reference: reference, // Notre référence (sera merchant_reference chez NotchPay)
      email: userEmail,
      customer: {
        name: customerName,
        email: userEmail,
      },
      callback_url: `https://severbackendnotchpay.onrender.com/api/payments/callback/${reference}`,
      webhook_url: `https://severbackendnotchpay.onrender.com/api/payments/webhook/notchpay`,
      metadata: {
        userId: userId,
        userEmail: userEmail,
        product: "Abonnement Premium Kamerun News",
        mode: currentMode,
        fixed_amount: "25 FCFA",
      },
    };

    console.log("Envoi à NotchPay:", JSON.stringify(payload, null, 2));

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

      const data = response.data;
      console.log("Réponse NotchPay reçue:", JSON.stringify(data, null, 2));

      // Extraire l'URL de paiement
      let paymentUrl =
        data.authorization_url ||
        data.checkout_url ||
        data.transaction?.authorization_url ||
        data.links?.authorization_url;

      if (!paymentUrl) {
        console.error("Pas d'URL de paiement dans la réponse:", data);

        if (currentMode === "TEST") {
          paymentUrl = `https://checkout.notchpay.co/?payment=${reference}`;
          console.log(`URL de fallback TEST: ${paymentUrl}`);
        } else {
          throw new Error("URL de paiement non reçue");
        }
      }

      console.log(`URL de paiement: ${paymentUrl}`);

      // Mettre à jour la transaction avec l'URL
      await supabase
        .from("transactions")
        .update({
          metadata: {
            ...transaction.metadata,
            payment_url: paymentUrl,
            notchpay_response: data,
            notchpay_reference: data.transaction?.reference || data.reference,
            updated_at: new Date().toISOString(),
          },
        })
        .eq("id", transaction.id);

      return res.json({
        success: true,
        message: "Paiement de 25 FCFA initialisé avec succès",
        mode: currentMode,
        data: {
          authorization_url: paymentUrl,
          reference: reference,
          transaction_id: transaction.id,
          amount: 25,
          amount_in_cents: amountForNotchpay,
          currency: "XAF",
          description: "Abonnement Premium Kamerun News",
        },
      });
    } catch (error) {
      console.error("Erreur API NotchPay:", error.message);

      if (error.response) {
        console.error(
          "Détails de l'erreur:",
          JSON.stringify(error.response.data, null, 2)
        );
      } else if (error.request) {
        console.error("Aucune réponse reçue:", error.request);
      } else {
        console.error("Erreur de configuration:", error.message);
      }

      await supabase
        .from("transactions")
        .update({
          status: "failed",
          metadata: {
            ...transaction.metadata,
            error: error.message,
            notchpay_error: error.response?.data,
          },
        })
        .eq("id", transaction.id);

      return res.status(500).json({
        success: false,
        message: "Erreur lors de l'initialisation du paiement",
        error: error.message,
        mode: currentMode,
      });
    }
  } catch (error) {
    console.error("Erreur globale:", error);
    return res.status(500).json({
      success: false,
      message: "Erreur interne du serveur",
      error: error.message,
    });
  }
});

// WEBHOOK NOTCHPAY - CORRIGÉ POUR GÉRER LES CENTIMES ET LES RÉFÉRENCES
router.post("/webhook/notchpay", async (req, res) => {
  console.log("=== WEBHOOK NOTCHPAY REÇU ===");

  try {
    const payload = req.body;
    console.log("Données reçues:", JSON.stringify(payload, null, 2));

    // Extraire les informations
    let transactionData = payload.data || payload.transaction || payload;
    
    // IMPORTANT: NotchPay envoie merchant_reference (notre référence) et reference (sa référence interne)
    let merchantReference = transactionData.merchant_reference;
    let notchpayReference = transactionData.reference;
    let status = transactionData.status || payload.event?.replace("payment.", "");

    if (payload.event && payload.event.includes(".")) {
      status = payload.event.split(".")[1];
    }

    console.log(`Traitement webhook:`);
    console.log(`- Notre référence (merchant_reference): ${merchantReference}`);
    console.log(`- Référence NotchPay: ${notchpayReference}`);
    console.log(`- Statut: ${status}`);
    console.log(`- Montant reçu: ${transactionData.amount} centimes`);

    if (!merchantReference && !notchpayReference) {
      console.error("Aucune référence dans le webhook");
      return res
        .status(400)
        .json({ success: false, message: "Référence manquante" });
    }

    // Chercher la transaction par NOTRE référence (merchant_reference)
    const { data: transaction, error: txError } = await supabase
      .from("transactions")
      .select("*")
      .eq("reference", merchantReference)
      .maybeSingle();

    if (txError) {
      console.error("Erreur recherche transaction:", txError);
    }

    if (!transaction) {
      console.log(`Transaction non trouvée avec merchant_reference: ${merchantReference}, création...`);

      const userId =
        transactionData.metadata?.userId ||
        payload.metadata?.userId ||
        "unknown";

      // IMPORTANT: NotchPay envoie le montant en centimes, convertir en FCFA
      const amountInFcfa = transactionData.amount ? transactionData.amount / 100 : 25;

      const { data: newTx } = await supabase
        .from("transactions")
        .insert({
          reference: merchantReference || notchpayReference,
          amount: amountInFcfa, // Stocker en FCFA
          currency: transactionData.currency || "XAF",
          status: status || "unknown",
          user_id: userId !== "unknown" ? userId : null,
          metadata: {
            webhook_data: payload,
            created_from_webhook: true,
            received_at: new Date().toISOString(),
            notchpay_reference: notchpayReference,
            merchant_reference: merchantReference,
            amount_in_cents: transactionData.amount,
          },
        })
        .select()
        .single();

      console.log(`Transaction créée depuis webhook: ${newTx?.id}`);

      // Si paiement réussi et utilisateur connu, activer premium
      if (
        (status === "complete" || status === "success" || status === "completed") &&
        userId !== "unknown" &&
        amountInFcfa === 25
      ) {
        await processPremiumActivation(userId, merchantReference || notchpayReference, status);
      }

      return res
        .status(200)
        .json({ received: true, message: "Transaction créée depuis webhook" });
    }

    console.log(
      `Transaction trouvée: ${transaction.id}, utilisateur: ${transaction.user_id}, montant actuel: ${transaction.amount} FCFA`
    );

    // Convertir le montant NotchPay (centimes) en FCFA
    const amountInFcfa = transactionData.amount ? transactionData.amount / 100 : transaction.amount;

    // Mettre à jour la transaction
    const updateData = {
      status: status || "processed",
      amount: amountInFcfa, // Mettre à jour avec le montant converti
      metadata: {
        ...transaction.metadata,
        webhook_data: payload,
        webhook_received_at: new Date().toISOString(),
        notchpay_status: status,
        notchpay_reference: notchpayReference,
        last_webhook: new Date().toISOString(),
        amount_in_cents: transactionData.amount,
      },
      updated_at: new Date().toISOString(),
    };

    // Si paiement réussi, ajouter completed_at
    if (status === "complete" || status === "success" || status === "completed") {
      updateData.completed_at = new Date().toISOString();
    }

    await supabase
      .from("transactions")
      .update(updateData)
      .eq("id", transaction.id);

    // Traiter l'activation premium UNIQUEMENT si paiement réussi
    if (
      status === "complete" ||
      status === "success" ||
      status === "completed"
    ) {
      // Vérifier que l'utilisateur existe et que le montant est 25 FCFA
      if (transaction.user_id && amountInFcfa === 25) {
        const activated = await processPremiumActivation(
          transaction.user_id, 
          merchantReference, 
          status
        );
        console.log(`Activation premium: ${activated ? "succès" : "échec"}`);
      } else {
        console.log(
          `Transaction ${merchantReference} non éligible pour activation premium: montant=${amountInFcfa} FCFA, user=${transaction.user_id}`
        );
      }
    }

    console.log(`Webhook traité pour ${merchantReference}, statut: ${status}, montant: ${amountInFcfa} FCFA`);

    return res.status(200).json({
      success: true,
      message: "Webhook traité avec succès",
      reference: merchantReference,
      notchpay_reference: notchpayReference,
      status: status,
      amount_fcfa: amountInFcfa,
    });
  } catch (error) {
    console.error("Erreur traitement webhook:", error);
    return res.status(200).json({
      received: true,
      error: error.message,
    });
  }
});

// VÉRIFIER UN PAIEMENT (pour le frontend après redirection)
router.get("/verify/:reference", authenticateUser, async (req, res) => {
  try {
    const { reference } = req.params;
    const userId = req.user.id;

    console.log(`Vérification manuelle: ${reference} pour ${userId}`);

    // Chercher la transaction par NOTRE référence
    const { data: transaction, error: txError } = await supabase
      .from("transactions")
      .select("*")
      .eq("reference", reference)
      .eq("user_id", userId)
      .maybeSingle();

    if (txError) {
      console.error("Erreur recherche transaction:", txError);
      return res.status(500).json({
        success: false,
        message: "Erreur base de données",
      });
    }

    if (!transaction) {
      console.log(`Transaction ${reference} non trouvée`);
      return res.status(404).json({
        success: false,
        message: "Transaction non trouvée",
      });
    }

    console.log(`Transaction trouvée, statut: ${transaction.status}, montant: ${transaction.amount} FCFA`);

    // Si déjà complet, vérifier le profil
    if (transaction.status === "complete" || transaction.status === "success") {
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
        message: profile?.is_premium
          ? "Paiement de 25 FCFA confirmé - Compte premium actif"
          : "Paiement confirmé - Activation en cours...",
      });
    }

    // Vérifier avec NotchPay
    try {
      console.log(`Vérification chez NotchPay pour: ${reference}`);

      // Essayer avec notre référence d'abord, puis avec la référence NotchPay
      let notchpayRef = transaction.metadata?.notchpay_reference || reference;

      const response = await axios.get(
        `${NOTCHPAY_CONFIG.baseUrl}/payments/${notchpayRef}`,
        {
          headers: {
            Authorization: NOTCHPAY_CONFIG.publicKey,
            Accept: "application/json",
          },
          timeout: 10000,
        }
      );

      const data = response.data;
      const notchpayStatus = data.status || data.transaction?.status;
      const notchpayAmount = data.amount || data.transaction?.amount;

      console.log(`Statut NotchPay: ${notchpayStatus}, Montant: ${notchpayAmount} centimes`);

      // Convertir le montant
      const amountInFcfa = notchpayAmount ? notchpayAmount / 100 : transaction.amount;

      // Mettre à jour la transaction
      await supabase
        .from("transactions")
        .update({
          status: notchpayStatus || "checked",
          amount: amountInFcfa,
          metadata: {
            ...transaction.metadata,
            last_verification: new Date().toISOString(),
            notchpay_status: notchpayStatus,
            notchpay_amount: notchpayAmount,
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", transaction.id);

      // Si paiement réussi chez NotchPay, activer premium
      if (notchpayStatus === "complete" || notchpayStatus === "success") {
        const activated = await processPremiumActivation(
          userId,
          reference,
          notchpayStatus
        );

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
          amount_fcfa: amountInFcfa,
          message: activated
            ? `Paiement de ${amountInFcfa} FCFA confirmé - Compte premium activé`
            : "Paiement confirmé mais problème d'activation",
        });
      }

      // Statuts divers
      if (notchpayStatus === "pending") {
        return res.json({
          success: true,
          paid: false,
          pending: true,
          status: "pending",
          message: "Paiement en attente chez NotchPay",
        });
      }

      if (notchpayStatus === "failed" || notchpayStatus === "cancelled") {
        return res.json({
          success: false,
          paid: false,
          pending: false,
          status: "failed",
          message: "Paiement échoué",
        });
      }

      return res.json({
        success: true,
        paid: false,
        pending: true,
        status: notchpayStatus || "unknown",
        message: "Statut indéterminé",
      });
    } catch (notchpayError) {
      console.error("Erreur vérification NotchPay:", notchpayError.message);

      return res.json({
        success: true,
        paid: false,
        pending: true,
        status: "pending",
        message: "En attente de confirmation NotchPay",
      });
    }
  } catch (error) {
    console.error("Erreur vérification:", error);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de la vérification",
      error: error.message,
    });
  }
});

// CONFIGURATION (sans accès aux clés sensibles)
router.get("/config", authenticateUser, (req, res) => {
  const isLive = currentMode === "LIVE";

  return res.json({
    success: true,
    config: {
      mode: currentMode,
      base_url: NOTCHPAY_CONFIG.baseUrl,
      webhook_url: "https://severbackendnotchpay.onrender.com/api/payments/webhook/notchpay",
      status: "ACTIF",
      message: isLive
        ? "Mode LIVE - Paiements réels activés"
        : "Mode TEST - Paiements de démonstration",
      fixed_amount: "25 FCFA",
      amount_in_cents: 2500,
    },
  });
});

// VÉRIFIER LE STATUT PREMIUM DE L'UTILISATEUR
router.get("/user-status", authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: profile, error } = await supabase
      .from("profiles")
      .select("is_premium, payment_reference, last_payment_date, email, created_at")
      .eq("id", userId)
      .single();

    if (error) {
      console.error("Erreur recherche profil:", error);
      return res.status(404).json({
        success: false,
        message: "Profil non trouvé",
      });
    }

    return res.json({
      success: true,
      is_premium: profile.is_premium || false,
      payment_reference: profile.payment_reference,
      last_payment_date: profile.last_payment_date,
      email: profile.email,
      account_created: profile.created_at,
    });
  } catch (error) {
    console.error("Erreur vérification statut:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ROUTE POUR REDIRIGER APRÈS PAIEMENT (pour le frontend)
router.get("/callback/:reference", async (req, res) => {
  try {
    const { reference } = req.params;

    // Rediriger vers le frontend avec la référence
    const frontendUrl = `https://kamerun-news.com/payment-callback?reference=${reference}`;

    res.redirect(frontendUrl);
  } catch (error) {
    console.error("Erreur redirection:", error);
    res.redirect(`https://kamerun-news.com/payment-error`);
  }
});

// TEST DU WEBHOOK (pour debug)
router.post("/test-webhook", async (req, res) => {
  console.log("=== TEST WEBHOOK MANUEL ===");
  
  // Simuler un payload de webhook réussi
  const testPayload = {
    "event": "payment.complete",
    "data": {
      "amount": 2500, // 25 FCFA en centimes
      "description": "Abonnement Premium Kamerun News",
      "reference": "trx.test12345", // Référence NotchPay
      "merchant_reference": "KAMERUN-TEST-REFERENCE", // Notre référence
      "status": "complete",
      "currency": "XAF",
      "metadata": {
        "userId": "test-user-id",
        "userEmail": "test@example.com",
        "product": "Abonnement Premium Kamerun News"
      },
      "created_at": new Date().toISOString()
    }
  };

  try {
    // Simuler le webhook
    console.log("Payload de test:", JSON.stringify(testPayload, null, 2));
    
    // Calculer le montant en FCFA
    const amountInFcfa = testPayload.data.amount / 100;
    console.log(`Montant en centimes: ${testPayload.data.amount}`);
    console.log(`Montant en FCFA: ${amountInFcfa}`);
    
    return res.json({
      success: true,
      message: "Webhook testé",
      test_data: {
        merchant_reference: testPayload.data.merchant_reference,
        notchpay_reference: testPayload.data.reference,
        amount_centimes: testPayload.data.amount,
        amount_fcfa: amountInFcfa,
        status: testPayload.data.status
      },
      note: "Ceci est un test, aucune transaction réelle n'a été modifiée"
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;