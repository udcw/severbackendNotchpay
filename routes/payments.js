const express = require("express");
const axios = require("axios");
const auth = require('../middleware/auth');
const { NOTCHPAY_CONFIG, authenticateUser, supabase } = require("../middleware/auth");

const router = express.Router();

// 🔥 INITIER UN PAIEMENT (protégé par authentification)
router.post("/initialize", authenticateUser, async (req, res) => {
  try {
    const { amount, phone, description = "Abonnement Premium Kamerun News" } = req.body;
    const userId = req.user.id;

    // Validation
    if (!amount || amount < 100) {
      return res.status(400).json({
        success: false,
        message: "Le montant doit être d'au moins 100 FCFA"
      });
    }

    // Récupérer les infos utilisateur
    const { data: userProfile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (profileError) {
      console.error('Erreur profil:', profileError);
      return res.status(400).json({
        success: false,
        message: "Impossible de récupérer le profil utilisateur"
      });
    }

    // Préparer les données NotchPay
    const reference = `KAMERUN-${userId}-${Date.now()}`;
    const amountInCents = Math.round(amount * 100); // NotchPay utilise les centimes

    const payload = {
      amount: amountInCents,
      currency: "XAF",
      description: description,
      reference: reference,
      email: req.user.email || userProfile.email,
      customer: {
        name: `${userProfile.first_name} ${userProfile.last_name}`,
        email: req.user.email || userProfile.email,
        phone: phone || userProfile.phone
      },
      callback_url: NOTCHPAY_CONFIG.callbackUrl,
      metadata: {
        userId: userId,
        userEmail: req.user.email,
        plan: "premium",
        type: "subscription",
        app: "Kamerun News"
      }
    };

    console.log("Payload NotchPay:", JSON.stringify(payload, null, 2));

    // Appeler l'API NotchPay
    const response = await axios.post(
      `${NOTCHPAY_CONFIG.baseUrl}/payments/initialize`,
      payload,
      {
        headers: {
          "Authorization": NOTCHPAY_CONFIG.publicKey,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        timeout: 10000 // Timeout de 10 secondes
      }
    );

    console.log("✅ Réponse NotchPay:", response.data);

    // Enregistrer la transaction en base
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
          notchpay_response: response.data,
          authorization_url: response.data.transaction?.authorization_url
        }
      })
      .select()
      .single();

    if (dbError) {
      console.error('Erreur DB:', dbError);
    }

    return res.json({
      success: true,
      message: "Paiement initialisé avec succès",
      data: {
        authorization_url: response.data.transaction?.authorization_url,
        reference: reference,
        transaction_id: transaction?.id,
        checkout_url: response.data.transaction?.authorization_url
      }
    });

  } catch (err) {
    console.error("❌ Erreur NotchPay:", {
      message: err.message,
      response: err.response?.data,
      status: err.response?.status
    });
    
    return res.status(err.response?.status || 500).json({
      success: false,
      message: err.response?.data?.message || "Erreur lors de l'initialisation du paiement",
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// 🔥 VÉRIFIER UN PAIEMENT
router.get("/verify/:reference", authenticateUser, async (req, res) => {
  try {
    const { reference } = req.params;
    const userId = req.user.id;

    if (!reference) {
      return res.status(400).json({
        success: false,
        message: "Référence de paiement requise"
      });
    }

    // Vérifier avec NotchPay
    const response = await axios.get(
      `${NOTCHPAY_CONFIG.baseUrl}/payments/${reference}`,
      {
        headers: {
          "Authorization": NOTCHPAY_CONFIG.publicKey,
          "Accept": "application/json"
        }
      }
    );

    const transaction = response.data.transaction;
    const isComplete = transaction?.status === 'complete';
    const isPending = transaction?.status === 'pending';
    const isFailed = ['failed', 'cancelled'].includes(transaction?.status);

    // Mettre à jour la transaction en base
    await supabase
      .from('transactions')
      .update({
        status: transaction?.status,
        metadata: {
          ...response.data,
          verified_at: new Date().toISOString()
        },
        completed_at: isComplete ? new Date().toISOString() : null
      })
      .eq('reference', reference)
      .eq('user_id', userId);

    // Si paiement réussi, mettre à jour le profil
    if (isComplete) {
      await supabase
        .from('profiles')
        .update({
          is_premium: true,
          premium_activated_at: new Date().toISOString(),
          last_payment_date: new Date().toISOString(),
          payment_reference: reference
        })
        .eq('id', userId);

      // Enregistrer l'abonnement
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
      failed: isFailed,
      status: transaction?.status,
      transaction: transaction,
      user_upgraded: isComplete
    });

  } catch (err) {
    console.error("❌ Erreur vérification:", err.response?.data || err.message);
    
    return res.status(err.response?.status || 500).json({
      success: false,
      message: err.response?.data?.message || "Erreur lors de la vérification du paiement"
    });
  }
});

// 🔥 LISTER LES TRANSACTIONS D'UN UTILISATEUR
router.get("/transactions", authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 20, offset = 0 } = req.query;

    const { data: transactions, error, count } = await supabase
      .from('transactions')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, parseInt(offset) + parseInt(limit) - 1);

    if (error) throw error;

    return res.json({
      success: true,
      data: transactions,
      pagination: {
        total: count,
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });

  } catch (err) {
    console.error("❌ Erreur transactions:", err);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de la récupération des transactions"
    });
  }
});

// 🔥 WEBHOOK NOTCHPAY (public - pas d'authentification)
router.post("/webhook", async (req, res) => {
  console.log("=== 📬 WEBHOOK REÇU ===");
  
  try {
    // 1. Lire le body comme JSON (Express.json() le parse déjà)
    const payload = req.body;
    const signature = req.headers['x-notchpay-signature'];
    
    console.log("Headers reçus:", JSON.stringify(req.headers, null, 2));
    console.log("Body reçu:", JSON.stringify(payload, null, 2));
    console.log("Signature reçue:", signature);
    
    // 2. TEMPORAIRE : Désactiver la vérification de signature
    // if (NOTCHPAY_CONFIG.webhookSecret && signature) {
    //   const crypto = require('crypto');
    //   const hmac = crypto.createHmac('sha256', NOTCHPAY_CONFIG.webhookSecret);
    //   const digest = hmac.update(JSON.stringify(payload)).digest('hex');
    //   
    //   if (signature !== digest) {
    //     console.error("❌ Signature invalide");
    //     return res.status(401).json({ success: false, message: "Signature invalide" });
    //   }
    // }
    
    console.log("✅ Vérification de signature désactivée (mode test)");
    
    // 3. Extraire les données
    const { event, data } = payload || {};
    const transaction = data?.transaction;
    
    if (!transaction?.reference) {
      console.error("❌ Transaction ou référence manquante");
      return res.status(400).json({ 
        success: false, 
        message: "Transaction ou référence manquante",
        received: payload
      });
    }
    
    console.log(`🔄 Traitement: ${event} - Référence: ${transaction.reference}`);
    console.log(`Status: ${transaction.status}, Montant: ${transaction.amount}`);
    
    // 4. Chercher la transaction dans la base
    const { data: existingTransaction, error: findError } = await supabase
      .from('transactions')
      .select('*')
      .eq('reference', transaction.reference)
      .single();
    
    if (findError) {
      console.log(`⚠️ Transaction ${transaction.reference} non trouvée, création...`);
      
      // Créer une nouvelle transaction
      const { error: createError } = await supabase
        .from('transactions')
        .insert({
          reference: transaction.reference,
          user_id: transaction.metadata?.userId || 'unknown',
          amount: transaction.amount ? transaction.amount / 100 : 0,
          currency: transaction.currency || 'XAF',
          status: transaction.status || 'pending',
          payment_method: 'notchpay',
          metadata: {
            webhook_payload: payload,
            notchpay_transaction: transaction,
            processed_at: new Date().toISOString()
          },
          created_at: new Date().toISOString()
        });
      
      if (createError) {
        console.error("❌ Erreur création transaction:", createError);
      }
    } else {
      // Mettre à jour la transaction existante
      console.log(`✅ Transaction trouvée, mise à jour du statut: ${transaction.status}`);
      
      await supabase
        .from('transactions')
        .update({
          status: transaction.status,
          metadata: {
            ...existingTransaction.metadata,
            webhook_payload: payload,
            notchpay_transaction: transaction,
            updated_at: new Date().toISOString()
          },
          completed_at: transaction.status === 'complete' ? new Date().toISOString() : null,
          updated_at: new Date().toISOString()
        })
        .eq('reference', transaction.reference);
    }
    
    // 5. Si paiement réussi, mettre à jour l'utilisateur
    if (transaction.status === 'complete' || transaction.status === 'success') {
      console.log(`💰 Paiement réussi pour ${transaction.reference}`);
      
      // Récupérer l'user_id depuis les metadata ou la transaction existante
      let userId = transaction.metadata?.userId;
      
      if (!userId && existingTransaction) {
        userId = existingTransaction.user_id;
      }
      
      if (userId && userId !== 'unknown') {
        // Mettre à jour le profil
        await supabase
          .from('profiles')
          .update({
            is_premium: true,
            premium_activated_at: new Date().toISOString(),
            last_payment_date: new Date().toISOString(),
            payment_reference: transaction.reference,
            updated_at: new Date().toISOString()
          })
          .eq('id', userId);
        
        console.log(`👤 Utilisateur ${userId} mis à jour vers PREMIUM`);
        
        // Créer l'abonnement
        await supabase
          .from('subscriptions')
          .upsert({
            user_id: userId,
            plan: 'premium',
            transaction_reference: transaction.reference,
            status: 'active',
            starts_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
            updated_at: new Date().toISOString()
          }, {
            onConflict: 'user_id, transaction_reference'
          });
      } else {
        console.warn(`⚠️ Impossible de trouver userId pour la transaction ${transaction.reference}`);
      }
    }
    
    console.log(`✅ Webhook traité avec succès pour ${transaction.reference}`);
    
    return res.status(200).json({ 
      success: true, 
      message: "Webhook traité avec succès",
      transaction: transaction.reference,
      status: transaction.status
    });
    
  } catch (err) {
    console.error("❌ ERREUR WEBHOOK:", err);
    console.error("Stack:", err.stack);
    
    return res.status(500).json({
      success: false,
      message: "Erreur serveur lors du traitement du webhook",
      error: err.message
    });
  }
});
// 🔥 CONFIGURATION (public)
router.get("/config", (req, res) => {
  return res.json({
    success: true,
    data: {
      publicKey: NOTCHPAY_CONFIG.publicKey ? "✅ Configurée" : "❌ Manquante",
      baseUrl: NOTCHPAY_CONFIG.baseUrl,
      currency: "XAF",
      supportedMethods: ["mobile_money", "card", "bank"],
      status: "active"
    }
  });
});

module.exports = router;