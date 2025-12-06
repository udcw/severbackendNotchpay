const express = require("express");
const axios = require("axios");
const { NOTCHPAY_CONFIG, authenticateUser, supabase } = require("../middleware/auth");

const router = express.Router();

// INITIER UN PAIEMENT
router.post("/initialize", authenticateUser, async (req, res) => {
  try {
    const { amount, phone, description = "Abonnement Premium Kamerun News", mode = 'live' } = req.body;
    const userId = req.user.id;

    if (!amount || amount < 100) {
      return res.status(400).json({
        success: false,
        message: "Le montant doit être d'au moins 100 FCFA"
      });
    }

    console.log("🆔 User ID:", userId);
    console.log("📧 User email:", req.user.email);
    console.log("💰 Montant:", amount);

    const publicKey = NOTCHPAY_CONFIG.publicKey;
    console.log("🔑 Clé publique:", publicKey ? publicKey.substring(0, 10) + '...' : 'NON DÉFINIE');
    
    if (publicKey && (publicKey.includes('SBX') || publicKey.includes('test'))) {
      console.warn("⚠️ ATTENTION: Clé publique de TEST détectée!");
    }

    const reference = `KAMERUN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const amountInCents = Math.round(amount * 100);

    const payload = {
      amount: amountInCents,
      currency: "XAF",
      description: description,
      reference: reference,
      email: req.user.email,
      customer: {
        name: req.user.user_metadata?.full_name || req.user.email.split('@')[0],
        email: req.user.email,
        phone: phone || ''
      },
      callback_url: `${process.env.BACKEND_URL}/api/payments/webhook`,
      metadata: {
        userId: userId,
        userEmail: req.user.email,
        plan: "premium",
        type: "subscription",
        app: "Kamerun News"
      }
    };

    console.log("📤 Payload NotchPay:", payload);

    const response = await axios.post(
      `${NOTCHPAY_CONFIG.baseUrl}/payments/initialize`,
      payload,
      {
        headers: {
          "Authorization": NOTCHPAY_CONFIG.publicKey,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        timeout: 15000
      }
    );

    console.log("✅ Réponse NotchPay:", response.data);

    let paymentUrl = null;
    
    if (response.data.transaction?.authorization_url) {
      paymentUrl = response.data.transaction.authorization_url;
    } else if (response.data.authorization_url) {
      paymentUrl = response.data.authorization_url;
    } else if (response.data.checkout_url) {
      paymentUrl = response.data.checkout_url;
    }

    if (!paymentUrl) {
      console.error("❌ Aucune URL de paiement trouvée");
      return res.status(500).json({
        success: false,
        message: "Erreur: aucune URL de paiement reçue de NotchPay",
        notchpay_response: response.data
      });
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
          notchpay_response: response.data,
          payment_url: paymentUrl,
          mode: mode
        }
      })
      .select()
      .single();

    if (dbError) {
      console.error('❌ Erreur DB transaction:', dbError);
    }

    return res.json({
      success: true,
      message: "Paiement initialisé avec succès",
      data: {
        authorization_url: paymentUrl,
        reference: reference,
        transaction_id: transaction?.id,
        checkout_url: paymentUrl
      }
    });

  } catch (err) {
    console.error("❌ Erreur NotchPay:", err.message);
    
    return res.status(err.response?.status || 500).json({
      success: false,
      message: err.response?.data?.message || "Erreur lors de l'initialisation du paiement",
      error: err.message
    });
  }
});

// VÉRIFIER UN PAIEMENT
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

    console.log("🔍 Vérification du paiement:", reference);

    // 1. Vérifier dans notre base
    const { data: dbTransaction, error: dbError } = await supabase
      .from('transactions')
      .select('*')
      .eq('reference', reference)
      .eq('user_id', userId)
      .single();

    if (dbError || !dbTransaction) {
      return res.json({
        success: false,
        message: "Transaction non trouvée",
        pending: true,
        paid: false,
        status: 'not_found'
      });
    }

    // 2. Si déjà complète
    if (dbTransaction.status === 'complete' || dbTransaction.status === 'success') {
      return res.json({
        success: true,
        paid: true,
        pending: false,
        status: dbTransaction.status,
        message: "Paiement déjà confirmé",
        user_upgraded: true
      });
    }

    // 3. Vérifier avec NotchPay
    try {
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

      const transaction = response.data.transaction;
      const isComplete = transaction?.status === 'complete' || transaction?.status === 'success';
      const isPending = transaction?.status === 'pending';
      const isFailed = ['failed', 'cancelled', 'canceled'].includes(transaction?.status);

      console.log("✅ Statut NotchPay:", transaction?.status);

      // Mettre à jour la transaction
      await supabase
        .from('transactions')
        .update({
          status: transaction?.status,
          metadata: {
            ...dbTransaction.metadata,
            notchpay_verification: response.data,
            verified_at: new Date().toISOString()
          },
          completed_at: isComplete ? new Date().toISOString() : null
        })
        .eq('reference', reference)
        .eq('user_id', userId);

      // Si paiement réussi
      if (isComplete) {
        await supabase
          .from('profiles')
          .update({
            is_premium: true,
            premium_activated_at: new Date().toISOString(),
            last_payment_date: new Date().toISOString(),
            payment_reference: reference,
            updated_at: new Date().toISOString()
          })
          .eq('id', userId);

        await supabase
          .from('subscriptions')
          .upsert({
            user_id: userId,
            plan: 'premium',
            transaction_reference: reference,
            status: 'active',
            starts_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
            updated_at: new Date().toISOString()
          });
      }

      return res.json({
        success: true,
        paid: isComplete,
        pending: isPending,
        status: transaction?.status,
        message: isComplete ? "Paiement confirmé" : "Paiement en attente",
        user_upgraded: isComplete
      });

    } catch (notchpayError) {
      console.log("⚠️ NotchPay n'a pas encore le paiement");
      
      return res.json({
        success: true,
        paid: false,
        pending: true,
        status: 'pending',
        message: "Paiement en cours de traitement",
        user_upgraded: false
      });
    }

  } catch (err) {
    console.error("❌ Erreur vérification:", err.message);
    
    return res.json({
      success: true,
      paid: false,
      pending: true,
      status: 'pending',
      message: "Vérification en cours...",
      user_upgraded: false
    });
  }
});

// WEBHOOK NOTCHPAY
router.post("/webhook", async (req, res) => {
  console.log("=== 🔥 WEBHOOK REÇU ===");
  
  try {
    let payload;
    if (typeof req.body === 'string') {
      payload = JSON.parse(req.body);
    } else {
      payload = req.body;
    }
    
    console.log("✅ Payload reçu:", payload);
    
    if (!payload || !payload.event || !payload.data) {
      console.error("❌ Structure payload invalide");
      return res.status(400).json({
        success: false,
        message: "Structure du payload invalide"
      });
    }
    
    const { event, data } = payload;
    const transaction = data?.transaction;
    
    if (!transaction || !transaction.reference) {
      console.error("❌ Référence transaction manquante");
      return res.status(400).json({
        success: false,
        message: "Référence de transaction manquante"
      });
    }
    
    console.log(`🔄 Traitement webhook: ${event}`);
    console.log(`Référence: ${transaction.reference}`);
    console.log(`Status: ${transaction.status}`);
    
    // Chercher la transaction
    const { data: existingTransaction, error: findError } = await supabase
      .from('transactions')
      .select('*')
      .eq('reference', transaction.reference)
      .single();
    
    if (findError) {
      console.log(`📝 Transaction ${transaction.reference} non trouvée, création...`);
      
      const userId = transaction.metadata?.userId || 'unknown';
      
      await supabase
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
    } else {
      console.log(`✅ Transaction existante trouvée`);
      
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
    
    // Si paiement réussi
    const successStatuses = ['complete', 'success', 'completed'];
    if (successStatuses.includes(transaction.status)) {
      console.log(`💰 Paiement REUSSI pour ${transaction.reference}`);
      
      let userId = transaction.metadata?.userId;
      
      if (!userId && existingTransaction) {
        userId = existingTransaction.user_id;
      }
      
      if (userId && !userId.startsWith('unknown')) {
        console.log(`👤 Mise à jour utilisateur ${userId} vers PREMIUM`);
        
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
          });
      }
    }
    
    console.log(`✅ Webhook traité avec succès!`);
    
    return res.status(200).json({
      success: true,
      message: "Webhook traité avec succès",
      reference: transaction.reference,
      status: transaction.status
    });
    
  } catch (err) {
    console.error("❌ ERREUR WEBHOOK:", err.message);
    
    return res.status(500).json({
      success: false,
      message: "Erreur serveur interne",
      error: err.message
    });
  }
});

// ROUTE PING
router.get("/ping", (req, res) => {
  return res.json({
    success: true,
    message: "Payments API is working!",
    timestamp: new Date().toISOString()
  });
});

// CRÉER/VÉRIFIER UN PROFIL
router.post("/ensure-profile", authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const { data: existingProfile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();
    
    if (profileError || !existingProfile) {
      const newProfileData = {
        id: userId,
        email: req.user.email,
        first_name: req.user.user_metadata?.first_name || 'Utilisateur',
        last_name: req.user.user_metadata?.last_name || 'Kamerun',
        is_premium: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      
      const { data: newProfile, error: createError } = await supabase
        .from('profiles')
        .upsert(newProfileData)
        .select()
        .single();
      
      if (createError) {
        throw createError;
      }
      
      return res.json({
        success: true,
        message: "Profil créé avec succès",
        profile: newProfile,
        created: true
      });
    }
    
    return res.json({
      success: true,
      message: "Profil existe déjà",
      profile: existingProfile,
      created: false
    });
    
  } catch (err) {
    console.error("❌ Erreur création profil:", err);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de la création du profil",
      error: err.message
    });
  }
});

module.exports = router;