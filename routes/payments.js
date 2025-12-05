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
// 🔥 WEBHOOK NOTCHPAY (public - pas d'authentification)
router.post("/webhook", async (req, res) => {
  console.log("=== 🔥 WEBHOOK REÇU ===");
  console.log("Content-Type:", req.headers['content-type']);
  console.log("Body (type):", typeof req.body);
  console.log("Body (raw):", req.body);
  
  try {
    // Parse le JSON manuellement
    let payload;
    if (typeof req.body === 'string') {
      try {
        payload = JSON.parse(req.body);
      } catch (parseError) {
        console.error("❌ Erreur parsing JSON:", parseError);
        return res.status(400).json({
          success: false,
          message: "JSON invalide reçu"
        });
      }
    } else {
      payload = req.body;
    }
    
    console.log("✅ Payload parsé:", JSON.stringify(payload, null, 2));
    
    const signature = req.headers['x-notchpay-signature'];
    console.log("Signature reçue:", signature);
    
    // TEMPORAIRE: Désactiver vérification signature pour tests
    console.log("⚠️ Vérification signature désactivée pour tests");
    
    // Vérifier la structure du payload
    if (!payload || !payload.event || !payload.data) {
      console.error("❌ Structure payload invalide:", payload);
      return res.status(400).json({
        success: false,
        message: "Structure du payload invalide",
        received: payload
      });
    }
    
    const { event, data } = payload;
    const transaction = data?.transaction;
    
    if (!transaction || !transaction.reference) {
      console.error("❌ Référence transaction manquante");
      return res.status(400).json({
        success: false,
        message: "Référence de transaction manquante",
        payload: payload
      });
    }
    
    console.log(`🔄 Traitement webhook: ${event}`);
    console.log(`Référence: ${transaction.reference}`);
    console.log(`Status: ${transaction.status}`);
    console.log(`Montant: ${transaction.amount} ${transaction.currency}`);
    console.log(`Metadata:`, transaction.metadata);
    
    // 1. Chercher ou créer la transaction dans Supabase
    const { data: existingTransaction, error: findError } = await supabase
      .from('transactions')
      .select('*')
      .eq('reference', transaction.reference)
      .single();
    
    if (findError) {
      console.log(`📝 Transaction ${transaction.reference} non trouvée, création...`);
      
      // Extraire userId des metadata
      const userId = transaction.metadata?.userId || 
                     payload.metadata?.userId || 
                     'unknown-' + Date.now();
      
      const { error: createError } = await supabase
        .from('transactions')
        .insert({
          reference: transaction.reference,
          user_id: userId,
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
      } else {
        console.log("✅ Transaction créée avec succès");
      }
    } else {
      console.log(`✅ Transaction existante trouvée, ID: ${existingTransaction.id}`);
      
      // Mettre à jour la transaction
      await supabase
        .from('transactions')
        .update({
          status: transaction.status,
          metadata: {
            ...existingTransaction.metadata,
            webhook_payload: payload,
            notchpay_transaction: transaction,
            webhook_processed_at: new Date().toISOString()
          },
          updated_at: new Date().toISOString(),
          completed_at: transaction.status === 'complete' ? new Date().toISOString() : null
        })
        .eq('reference', transaction.reference);
    }
    
    // 2. Si paiement réussi, mettre à jour l'utilisateur
    const successStatuses = ['complete', 'success', 'completed'];
    if (successStatuses.includes(transaction.status)) {
      console.log(`💰 Paiement REUSSI pour ${transaction.reference}`);
      
      // Chercher l'utilisateur
      let userId = transaction.metadata?.userId;
      
      if (!userId && existingTransaction) {
        userId = existingTransaction.user_id;
      }
      
      if (userId && !userId.startsWith('unknown')) {
        console.log(`👤 Mise à jour utilisateur ${userId} vers PREMIUM`);
        
        // Mettre à jour le profil
        const { error: updateError } = await supabase
          .from('profiles')
          .update({
            is_premium: true,
            premium_activated_at: new Date().toISOString(),
            last_payment_date: new Date().toISOString(),
            payment_reference: transaction.reference,
            updated_at: new Date().toISOString()
          })
          .eq('id', userId);
        
        if (updateError) {
          console.error("❌ Erreur mise à jour profil:", updateError);
        } else {
          console.log("✅ Profil mis à jour avec succès");
        }
        
        // Créer l'abonnement
        const { error: subError } = await supabase
          .from('subscriptions')
          .upsert({
            user_id: userId,
            plan: 'premium',
            transaction_reference: transaction.reference,
            status: 'active',
            starts_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }, {
            onConflict: 'user_id, transaction_reference'
          });
        
        if (subError) {
          console.error("❌ Erreur création abonnement:", subError);
        } else {
          console.log("✅ Abonnement créé avec succès");
        }
      } else {
        console.log(`⚠️  UserId non valide ou inconnu: ${userId}`);
      }
    }
    
    console.log(`✅ Webhook traité avec succès!`);
    
    return res.status(200).json({
      success: true,
      message: "Webhook traité avec succès",
      reference: transaction.reference,
      status: transaction.status,
      user_upgraded: successStatuses.includes(transaction.status)
    });
    
  } catch (err) {
    console.error("❌ ERREUR CRITIQUE WEBHOOK:", err);
    console.error("Stack:", err.stack);
    
    return res.status(500).json({
      success: false,
      message: "Erreur serveur interne",
      error: err.message
    });
  }
});
// 🔥 ROUTE DE TEST WEBHOOK (pour débogage)
router.get("/test-webhook", (req, res) => {
  const testPayload = {
    event: "payment.complete",
    data: {
      transaction: {
        reference: "KAMERUN-TEST-" + Date.now(),
        status: "complete",
        amount: 5000,
        currency: "XAF",
        metadata: {
          userId: "test-user-123",
          userEmail: "test@example.com",
          plan: "premium"
        }
      }
    }
  };
  
  return res.json({
    message: "Test webhook payload",
    payload: testPayload,
    curl_command: `curl -X POST https://severbackendnotchpay.onrender.com/api/payments/webhook -H "Content-Type: application/json" -d '${JSON.stringify(testPayload)}'`
  });
});

// 🔥 ROUTE PING (vérifier que l'API fonctionne)
router.get("/ping", (req, res) => {
  return res.json({
    success: true,
    message: "Payments API is working!",
    timestamp: new Date().toISOString(),
    webhook_endpoint: "POST /api/payments/webhook"
  });
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