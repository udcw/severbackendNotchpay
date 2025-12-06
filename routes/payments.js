const express = require("express");
const axios = require("axios");
const { authenticateUser, supabase } = require("../middleware/auth");

const router = express.Router();

// 🔥 CONFIGURATION NOTCHPAY
const NOTCHPAY_CONFIG = {
  publicKey: process.env.NOTCHPAY_PUBLIC_KEY,
  secretKey: process.env.NOTCHPAY_SECRET_KEY,
  baseUrl: process.env.NOTCHPAY_BASE_URL || "https://api.notchpay.co",
  mode: "TEST"
};

// 🔥 INITIER UN PAIEMENT (CORRIGÉ)
router.post("/initialize", authenticateUser, async (req, res) => {
  console.log("=== 🚀 INITIALISATION PAIEMENT ===");
  
  try {
    const { amount = 1000, description = "Abonnement Premium Kamerun News" } = req.body;
    const userId = req.user.id;

    // Validation - IMPORTANT : utiliser le bon montant
    if (amount < 100) {
      return res.status(400).json({
        success: false,
        message: "Le montant doit être d'au moins 100 FCFA"
      });
    }

    console.log(`👤 Utilisateur: ${req.user.email}`);
    console.log(`💰 Montant: ${amount} FCFA`);

    if (!NOTCHPAY_CONFIG.publicKey) {
      return res.status(500).json({
        success: false,
        message: "Configuration NotchPay manquante"
      });
    }

    // Générer une référence
    const merchantReference = `KAMERUN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const amountInCents = Math.round(amount * 100); // 1000 FCFA = 1000 * 100 = 100,000 centimes

    console.log(`📝 Référence marchand: ${merchantReference}`);
    console.log(`💵 Montant en centimes: ${amountInCents}`);

    // Payload NotchPay
    const payload = {
      amount: amountInCents,
      currency: "XAF",
      description: description,
      reference: merchantReference,
      email: req.user.email,
      customer: {
        name: req.user.user_metadata?.full_name || req.user.email.split('@')[0],
        email: req.user.email,
        phone: ""
      },
      callback_url: `${process.env.BACKEND_URL || 'https://severbackendnotchpay.onrender.com'}/api/payments/webhook`,
      metadata: {
        userId: userId,
        userEmail: req.user.email,
        product: "Abonnement Premium",
        app: "Kamerun News",
        mode: "TEST"
      }
    };

    console.log("📤 Envoi à NotchPay...");

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

      const data = response.data;
      console.log("✅ Réponse NotchPay reçue");

      // Extraire l'URL de paiement
      let paymentUrl = data.transaction?.authorization_url || 
                      data.authorization_url || 
                      data.checkout_url ||
                      data.links?.authorization_url ||
                      data.links?.checkout ||
                      data.url;

      if (!paymentUrl) {
        throw new Error("URL de paiement non reçue");
      }

      console.log("🔗 URL générée:", paymentUrl);

      // Enregistrer la transaction
      const { data: transaction, error: dbError } = await supabase
        .from('transactions')
        .insert({
          user_id: userId,
          reference: merchantReference, // VOTRE référence
          amount: amount,
          currency: 'XAF',
          status: 'pending',
          payment_method: 'notchpay',
          metadata: {
            notchpay_response: data,
            payment_url: paymentUrl,
            mode: 'TEST',
            created_at: new Date().toISOString()
          }
        })
        .select()
        .single();

      if (dbError) {
        console.error("❌ Erreur DB:", dbError.message);
      }

      return res.json({
        success: true,
        message: "Paiement initialisé",
        data: {
          authorization_url: paymentUrl,
          checkout_url: paymentUrl,
          reference: merchantReference, // Retourner VOTRE référence
          transaction_id: transaction?.id
        }
      });

    } catch (error) {
      console.error("❌ Erreur API NotchPay:", error.message);
      
      if (error.response) {
        console.error("📡 Détails:", error.response.data);
        return res.status(error.response.status).json({
          success: false,
          message: error.response.data?.message || "Erreur NotchPay",
          data: error.response.data
        });
      }
      
      return res.status(500).json({
        success: false,
        message: "Erreur de communication",
        error: error.message
      });
    }

  } catch (error) {
    console.error("❌ Erreur globale:", error);
    return res.status(500).json({
      success: false,
      message: "Erreur interne"
    });
  }
});

// 🔥 VÉRIFIER UN PAIEMENT (CORRIGÉ - utilise la bonne référence)
router.get("/verify/:reference", authenticateUser, async (req, res) => {
  try {
    const { reference } = req.params; // VOTRE référence (KAMERUN-...)
    const userId = req.user.id;

    console.log(`🔍 Vérification de: ${reference}`);

    // 1. Chercher dans notre base
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

    console.log("📊 Statut local:", transaction.status);

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

    // 3. Si échoué
    if (transaction.status === 'failed') {
      return res.json({
        success: false,
        paid: false,
        pending: false,
        status: 'failed',
        message: "Paiement échoué"
      });
    }

    // 4. Essayer de vérifier avec NotchPay en utilisant la référence NotchPay si disponible
    // Dans le webhook, on enregistre la référence NotchPay
    const notchpayReference = transaction.metadata?.notchpay_reference;
    
    if (notchpayReference) {
      console.log(`🔍 Vérification chez NotchPay avec référence: ${notchpayReference}`);
      
      try {
        const response = await axios.get(
          `${NOTCHPAY_CONFIG.baseUrl}/payments/${notchpayReference}`,
          {
            headers: {
              "Authorization": NOTCHPAY_CONFIG.publicKey,
              "Accept": "application/json"
            }
          }
        );

        const data = response.data;
        const status = data.transaction?.status || data.status;
        
        console.log(`📊 Statut NotchPay: ${status}`);

        // Mettre à jour notre base
        await supabase
          .from('transactions')
          .update({
            status: status,
            updated_at: new Date().toISOString()
          })
          .eq('id', transaction.id);

        if (status === 'complete' || status === 'success') {
          await supabase
            .from('profiles')
            .update({
              is_premium: true,
              premium_activated_at: new Date().toISOString(),
              payment_reference: reference,
              updated_at: new Date().toISOString()
            })
            .eq('id', userId);
        }

        return res.json({
          success: true,
          paid: status === 'complete' || status === 'success',
          pending: status === 'pending' || status === 'processing',
          status: status,
          message: `Statut: ${status}`
        });

      } catch (notchpayError) {
        console.log("⚠️ NotchPay n'a pas encore le paiement");
      }
    }

    // 5. Si pas de référence NotchPay ou erreur, retourner pending
    return res.json({
      success: true,
      paid: false,
      pending: true,
      status: 'pending',
      message: "Paiement en cours de traitement"
    });

  } catch (error) {
    console.error("❌ Erreur vérification:", error);
    return res.status(500).json({
      success: false,
      message: "Erreur de vérification"
    });
  }
});

// 🔥 WEBHOOK (FONCTIONNEL - traite les données)
router.post("/webhook", async (req, res) => {
  console.log("=== 📩 WEBHOOK NOTCHPAY ===");
  
  try {
    let payload;
    if (typeof req.body === 'string') {
      payload = JSON.parse(req.body);
    } else {
      payload = req.body;
    }
    
    console.log("📦 Données webhook:", JSON.stringify(payload, null, 2));

    if (!payload || !payload.event || !payload.data) {
      console.error("❌ Structure invalide");
      return res.status(400).json({ success: false, message: "Structure invalide" });
    }

    const { event, data } = payload;
    const transaction = data;
    
    console.log(`🔄 Événement: ${event}`);
    console.log(`💰 Statut: ${transaction.status}`);
    console.log(`📝 Référence NotchPay: ${transaction.reference}`);
    console.log(`🏷️ Référence marchand: ${transaction.merchant_reference}`);

    // IMPORTANT: Chercher par merchant_reference (VOTRE référence)
    const merchantReference = transaction.merchant_reference || transaction.trxref;
    
    if (!merchantReference) {
      console.error("❌ Référence marchand manquante");
      return res.status(400).json({ 
        success: false, 
        message: "Référence marchand manquante" 
      });
    }

    // Chercher la transaction
    const { data: existingTransaction, error: findError } = await supabase
      .from('transactions')
      .select('*')
      .eq('reference', merchantReference)
      .single();

    if (findError) {
      console.log(`📝 Transaction non trouvée, création: ${merchantReference}`);
      
      const userId = transaction.metadata?.userId || 'unknown';
      
      await supabase
        .from('transactions')
        .insert({
          reference: merchantReference,
          notchpay_reference: transaction.reference,
          user_id: userId,
          amount: transaction.amount / 100,
          currency: transaction.currency,
          status: transaction.status,
          payment_method: 'notchpay',
          metadata: {
            webhook_data: payload,
            notchpay_transaction: transaction,
            mode: "TEST",
            processed_at: new Date().toISOString()
          },
          created_at: new Date().toISOString()
        });
    } else {
      console.log(`✅ Transaction trouvée, mise à jour`);
      
      // Mettre à jour avec la référence NotchPay
      await supabase
        .from('transactions')
        .update({
          notchpay_reference: transaction.reference,
          status: transaction.status,
          metadata: {
            ...existingTransaction.metadata,
            webhook_data: payload,
            notchpay_transaction: transaction,
            webhook_processed_at: new Date().toISOString()
          },
          updated_at: new Date().toISOString()
        })
        .eq('id', existingTransaction.id);
    }

    // Si paiement réussi
    if (transaction.status === 'complete' || transaction.status === 'success') {
      console.log(`💰 Paiement réussi pour ${merchantReference}`);
      
      const userId = transaction.metadata?.userId || existingTransaction?.user_id;
      
      if (userId && userId !== 'unknown') {
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
      }
    }

    console.log("✅ Webhook traité avec succès");
    return res.json({ 
      success: true, 
      message: "Webhook reçu",
      reference: merchantReference,
      status: transaction.status
    });

  } catch (error) {
    console.error("❌ Erreur webhook:", error);
    return res.status(500).json({ 
      success: false, 
      message: "Erreur webhook" 
    });
  }
});

// 🔥 ROUTE POUR SIMULER UN SUCCÈS (pour tests)
router.post("/simulate-success/:reference", authenticateUser, async (req, res) => {
  try {
    const { reference } = req.params;
    const userId = req.user.id;

    // Mettre à jour la transaction
    await supabase
      .from('transactions')
      .update({
        status: 'complete',
        updated_at: new Date().toISOString()
      })
      .eq('reference', reference)
      .eq('user_id', userId);

    // Mettre à jour le profil
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
      message: "Paiement simulé avec succès",
      reference: reference
    });

  } catch (error) {
    console.error("❌ Erreur simulation:", error);
    return res.status(500).json({
      success: false,
      message: "Erreur simulation"
    });
  }
});

// 🔥 ROUTE DE CONFIGURATION
router.get("/config", (req, res) => {
  const publicKey = NOTCHPAY_CONFIG.publicKey;
  
  return res.json({
    success: true,
    config: {
      mode: "TEST",
      public_key: publicKey ? `${publicKey.substring(0, 20)}...` : "NON DÉFINIE",
      base_url: NOTCHPAY_CONFIG.baseUrl,
      status: "ACTIF"
    }
  });
});

module.exports = router;
