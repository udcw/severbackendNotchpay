const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const { authenticateUser, supabase } = require("../middleware/auth");

const router = express.Router();

// 🔥 CONFIGURATION NOTCHPAY LIVE
const NOTCHPAY_CONFIG = {
  publicKey: process.env.NOTCHPAY_PUBLIC_KEY,
  secretKey: process.env.NOTCHPAY_SECRET_KEY,
  baseUrl: process.env.NOTCHPAY_BASE_URL || "https://api.notchpay.co",
  webhookSecret: process.env.NOTCHPAY_WEBHOOK_SECRET,
  mode: "LIVE"
};

// 🔥 INITIER UN PAIEMENT (CORRIGÉ)
router.post("/initialize", authenticateUser, async (req, res) => {
  console.log("=== 🚀 INITIALISATION PAIEMENT LIVE ===");
  
  try {
    const { amount = 1000, description = "Abonnement Premium Kamerun News" } = req.body;
    const userId = req.user.id;

    if (amount < 100) {
      return res.status(400).json({
        success: false,
        message: "Le montant doit être d'au moins 100 FCFA"
      });
    }

    console.log(`👤 Utilisateur: ${req.user.email}`);
    console.log(`💰 Montant: ${amount} FCFA`);

    // Vérifier les clés LIVE
    if (!NOTCHPAY_CONFIG.publicKey || !NOTCHPAY_CONFIG.publicKey.includes('pk_live_')) {
      console.error("❌ Clés LIVE non configurées !");
      return res.status(500).json({
        success: false,
        message: "Configuration NotchPay incorrecte. Contactez l'administrateur.",
        mode: "ERROR"
      });
    }

    // Générer une référence UNIQUE
    const merchantReference = `KAMERUN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const amountInCents = Math.round(amount * 100);

    // Données client
    const customerName = req.user.user_metadata?.full_name || 
                        req.user.user_metadata?.name || 
                        req.user.email.split('@')[0];

    // Payload NotchPay LIVE
    const payload = {
      amount: amountInCents,
      currency: "XAF",
      description: description,
      reference: merchantReference, // VOTRE référence marchand
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
        mode: "LIVE"
      }
    };

    console.log("📤 Envoi à NotchPay LIVE...");
    console.log("📝 Référence marchand:", merchantReference);

    // Appel à NotchPay
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

    const data = response.data;
    console.log("✅ Réponse NotchPay:", data);

    // Extraire l'URL de paiement
    let paymentUrl = data.transaction?.authorization_url || 
                    data.authorization_url || 
                    data.checkout_url ||
                    data.links?.authorization_url ||
                    data.links?.checkout;

    if (!paymentUrl) {
      throw new Error("URL de paiement non reçue");
    }

    // Vérifier que c'est une URL LIVE
    if (paymentUrl.includes('/test.')) {
      console.warn("⚠️ Attention: URL de test avec des clés LIVE !");
    }

    // Enregistrer la transaction
    const { data: transaction, error: dbError } = await supabase
      .from('transactions')
      .insert({
        user_id: userId,
        reference: merchantReference, // Votre référence
        notchpay_reference: data.transaction?.reference, // Référence NotchPay (peut être null)
        amount: amount,
        currency: 'XAF',
        status: 'pending',
        payment_method: 'notchpay',
        metadata: {
          notchpay_response: data,
          payment_url: paymentUrl,
          mode: 'LIVE',
          customer_email: req.user.email
        }
      })
      .select()
      .single();

    if (dbError) {
      console.error("❌ Erreur DB:", dbError.message);
    }

    return res.json({
      success: true,
      message: "Paiement LIVE initialisé",
      data: {
        authorization_url: paymentUrl,
        checkout_url: paymentUrl,
        reference: merchantReference,
        transaction_id: transaction?.id,
        mode: "LIVE"
      }
    });

  } catch (error) {
    console.error("❌ Erreur:", error.message);
    console.error("📡 Détails:", error.response?.data);
    
    return res.status(500).json({
      success: false,
      message: error.response?.data?.message || "Erreur initialisation paiement",
      error: error.message
    });
  }
});

// 🔥 VÉRIFIER UN PAIEMENT (CORRIGÉ)
router.get("/verify/:reference", authenticateUser, async (req, res) => {
  try {
    const { reference } = req.params; // VOTRE référence (KAMERUN-...)
    const userId = req.user.id;

    console.log(`🔍 Vérification paiement: ${reference}`);

    // 1. Chercher la transaction par VOTRE référence
    const { data: transaction, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('reference', reference) // Cherche par VOTRE référence
      .eq('user_id', userId)
      .single();

    if (error || !transaction) {
      console.log("❌ Transaction non trouvée par référence marchand");
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

    // 3. Essayer de vérifier avec NotchPay
    try {
      // Essayer avec la référence NotchPay si disponible
      const verifyReference = transaction.notchpay_reference || reference;
      console.log(`🔍 Vérification chez NotchPay avec: ${verifyReference}`);
      
      const response = await axios.get(
        `${NOTCHPAY_CONFIG.baseUrl}/payments/${verifyReference}`,
        {
          headers: {
            "Authorization": NOTCHPAY_CONFIG.publicKey,
            "Accept": "application/json"
          },
          timeout: 10000
        }
      );

      console.log("✅ Réponse NotchPay:", response.data);
      
      const transactionData = response.data.transaction || response.data;
      const status = transactionData.status;
      const isComplete = status === 'complete' || status === 'success';
      const isPending = status === 'pending';

      // Mettre à jour la transaction
      await supabase
        .from('transactions')
        .update({
          status: status,
          notchpay_reference: transactionData.reference || transaction.notchpay_reference,
          metadata: {
            ...transaction.metadata,
            verification_response: response.data,
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

        await supabase
          .from('subscriptions')
          .insert({
            user_id: userId,
            plan: 'premium',
            transaction_reference: reference,
            status: 'active',
            starts_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
          });
      }

      return res.json({
        success: true,
        paid: isComplete,
        pending: isPending,
        status: status,
        message: isComplete ? "Paiement confirmé" : "Paiement en cours"
      });

    } catch (notchpayError) {
      console.log("⚠️ NotchPay n'a pas encore le paiement");
      
      // Retourner pending pour continuer à vérifier
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

// 🔥 WEBHOOK (CORRIGÉ)
router.post("/webhook", async (req, res) => {
  console.log("=== 📩 WEBHOOK NOTCHPAY LIVE ===");
  
  try {
    // Parser le body
    let payload;
    if (typeof req.body === 'string') {
      try {
        payload = JSON.parse(req.body);
      } catch (e) {
        console.error("❌ Erreur parsing JSON:", e);
        return res.status(400).json({ success: false, message: "JSON invalide" });
      }
    } else {
      payload = req.body;
    }
    
    console.log("📦 Payload reçu:", JSON.stringify(payload, null, 2));

    if (!payload || !payload.event || !payload.data) {
      console.error("❌ Structure payload invalide");
      return res.status(400).json({ 
        success: false, 
        message: "Structure du payload invalide" 
      });
    }

    const { event, data } = payload;
    const transaction = data.transaction;
    
    if (!transaction) {
      console.error("❌ Transaction manquante");
      return res.status(400).json({ 
        success: false, 
        message: "Transaction manquante" 
      });
    }

    // IMPORTANT: NotchPay envoie deux références !
    const merchantReference = transaction.reference_merchant || transaction.reference;
    const notchpayReference = transaction.reference;
    
    console.log(`🔄 Événement: ${event}`);
    console.log(`📝 Référence marchand: ${merchantReference}`);
    console.log(`🔑 Référence NotchPay: ${notchpayReference}`);
    console.log(`💰 Statut: ${transaction.status}`);
    console.log(`💵 Montant: ${transaction.amount} ${transaction.currency}`);

    if (!merchantReference) {
      console.error("❌ Référence marchand manquante");
      return res.status(400).json({ 
        success: false, 
        message: "Référence marchand manquante" 
      });
    }

    // Chercher la transaction par référence marchand (VOTRE référence)
    const { data: existingTransaction, error: findError } = await supabase
      .from('transactions')
      .select('*')
      .eq('reference', merchantReference)
      .single();

    if (findError) {
      console.log(`📝 Transaction non trouvée, création avec référence: ${merchantReference}`);
      
      const userId = transaction.metadata?.userId || 'unknown';
      
      await supabase
        .from('transactions')
        .insert({
          reference: merchantReference,
          notchpay_reference: notchpayReference,
          user_id: userId,
          amount: transaction.amount / 100,
          currency: transaction.currency || 'XAF',
          status: transaction.status,
          payment_method: 'notchpay',
          metadata: {
            webhook_payload: payload,
            notchpay_transaction: transaction,
            mode: "LIVE",
            processed_at: new Date().toISOString()
          },
          created_at: new Date().toISOString()
        });
    } else {
      console.log(`✅ Transaction trouvée, ID: ${existingTransaction.id}`);
      
      // Mettre à jour la transaction
      await supabase
        .from('transactions')
        .update({
          status: transaction.status,
          notchpay_reference: notchpayReference || existingTransaction.notchpay_reference,
          metadata: {
            ...existingTransaction.metadata,
            webhook_payload: payload,
            notchpay_transaction: transaction,
            webhook_processed_at: new Date().toISOString()
          },
          updated_at: new Date().toISOString(),
          completed_at: (transaction.status === 'complete' || transaction.status === 'success') ? 
            new Date().toISOString() : null
        })
        .eq('id', existingTransaction.id);
    }

    // Si paiement réussi
    const successStatuses = ['complete', 'success', 'completed'];
    if (successStatuses.includes(transaction.status)) {
      console.log(`💰 Paiement REUSSI pour ${merchantReference}`);
      
      let userId = transaction.metadata?.userId;
      
      if (!userId && existingTransaction) {
        userId = existingTransaction.user_id;
      }
      
      if (userId && !userId.startsWith('unknown')) {
        console.log(`👤 Mise à jour utilisateur ${userId} en PREMIUM`);
        
        await supabase
          .from('profiles')
          .update({
            is_premium: true,
            premium_activated_at: new Date().toISOString(),
            payment_reference: merchantReference,
            last_payment_date: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('id', userId);

        await supabase
          .from('subscriptions')
          .upsert({
            user_id: userId,
            plan: 'premium',
            transaction_reference: merchantReference,
            status: 'active',
            starts_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
            updated_at: new Date().toISOString()
          });
      }
    }

    console.log("✅ Webhook traité avec succès");
    return res.json({ 
      success: true, 
      message: "Webhook traité",
      reference: merchantReference,
      status: transaction.status
    });

  } catch (error) {
    console.error("❌ Erreur webhook:", error.message);
    console.error(error.stack);
    return res.status(500).json({ 
      success: false, 
      message: "Erreur interne" 
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
      public_key: publicKey ? `${publicKey.substring(0, 25)}...` : "NON DÉFINIE",
      base_url: NOTCHPAY_CONFIG.baseUrl,
      status: publicKey ? "CONFIGURÉ" : "NON CONFIGURÉ"
    }
  });
});

// 🔥 ROUTE DE TEST
router.get("/test", (req, res) => {
  return res.json({
    success: true,
    message: "API Payments fonctionnelle",
    timestamp: new Date().toISOString(),
    endpoints: {
      initialize: "POST /api/payments/initialize",
      verify: "GET /api/payments/verify/:reference",
      webhook: "POST /api/payments/webhook",
      config: "GET /api/payments/config"
    }
  });
});

module.exports = router;