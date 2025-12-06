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

// 🔥 LISTE DES STATUTS FINAUX (plus de vérification après)
const FINAL_STATUSES = ['complete', 'success', 'failed', 'cancelled', 'canceled', 'expired'];

// 🔥 VÉRIFIER UN PAIEMENT (AMÉLIORÉ - vérifie d'abord le statut local)
router.get("/verify/:reference", authenticateUser, async (req, res) => {
  try {
    const { reference } = req.params;
    const userId = req.user.id;

    console.log(`🔍 Vérification paiement: ${reference}`);

    // 1. CHERCHER LA TRANSACTION DANS NOTRE BASE
    const { data: transaction, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('reference', reference)
      .eq('user_id', userId)
      .single();

    if (error || !transaction) {
      console.log("❌ Transaction non trouvée en base");
      return res.json({
        success: false,
        paid: false,
        pending: true,
        status: 'not_found',
        message: "Transaction non trouvée"
      });
    }

    console.log(`📊 Statut local: ${transaction.status}`);

    // 2. SI DÉJÀ STATUT FINAL, RETOURNER DIRECTEMENT
    if (FINAL_STATUSES.includes(transaction.status)) {
      console.log(`✅ Statut final détecté: ${transaction.status}`);
      
      const isSuccess = transaction.status === 'complete' || transaction.status === 'success';
      
      return res.json({
        success: true,
        paid: isSuccess,
        pending: false,
        status: transaction.status,
        message: isSuccess ? "Paiement confirmé" : `Paiement ${transaction.status}`,
        updated_at: transaction.updated_at
      });
    }

    // 3. SI EN ATTENTE, VÉRIFIER CHEZ NOTCHPAY
    console.log(`🔍 Vérification chez NotchPay: ${reference}`);
    
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

      const data = response.data;
      console.log("📡 Réponse NotchPay:", data);
      
      // Extraire le statut
      let status = 'pending';
      if (data.transaction) {
        status = data.transaction.status;
      } else if (data.status) {
        status = data.status;
      } else if (data.data?.status) {
        status = data.data.status;
      }
      
      console.log(`📊 Statut NotchPay: ${status}`);

      // Mettre à jour la transaction dans notre base
      await supabase
        .from('transactions')
        .update({
          status: status,
          metadata: {
            ...transaction.metadata,
            notchpay_verification: data,
            verified_at: new Date().toISOString()
          },
          updated_at: new Date().toISOString(),
          completed_at: (status === 'complete' || status === 'success') ? new Date().toISOString() : null
        })
        .eq('id', transaction.id);

      // Si paiement réussi, mettre à jour le profil
      if (status === 'complete' || status === 'success') {
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
      }

      return res.json({
        success: true,
        paid: status === 'complete' || status === 'success',
        pending: status === 'pending' || status === 'processing',
        status: status,
        message: `Statut: ${status}`,
        is_final: FINAL_STATUSES.includes(status)
      });

    } catch (notchpayError) {
      console.log("⚠️ NotchPay n'a pas encore le paiement:", notchpayError.message);
      
      // Pour le mode TEST, attendre un peu puis retourner failed (car les paiements test échouent souvent)
      if (NOTCHPAY_CONFIG.mode === "TEST") {
        // Après 2 minutes, marquer comme échoué si toujours en attente
        const createdAt = new Date(transaction.created_at);
        const now = new Date();
        const diffMinutes = (now - createdAt) / (1000 * 60);
        
        if (diffMinutes > 2) {
          console.log("🧪 Mode TEST: Marquer comme échoué après 2 minutes d'attente");
          
          await supabase
            .from('transactions')
            .update({
              status: 'failed',
              updated_at: new Date().toISOString()
            })
            .eq('id', transaction.id);
          
          return res.json({
            success: false,
            paid: false,
            pending: false,
            status: 'failed',
            message: "Paiement échoué (timeout test)"
          });
        }
      }
      
      // Sinon, retourner en attente
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

// 🔥 WEBHOOK AMÉLIORÉ (met à jour IMMÉDIATEMENT)
router.post("/webhook", async (req, res) => {
  console.log("=== 📩 WEBHOOK NOTCHPAY ===");
  
  try {
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
    
    console.log("📦 Payload webhook:", JSON.stringify(payload, null, 2));

    if (!payload || !payload.event || !payload.data) {
      console.error("❌ Structure payload invalide");
      return res.status(400).json({ 
        success: false, 
        message: "Structure du payload invalide" 
      });
    }

    const { event, data } = payload;
    const transaction = data;
    
    console.log(`🔄 Événement: ${event}`);
    console.log(`💰 Statut: ${transaction.status}`);
    
    // IMPORTANT: Extraire la référence marchand
    const merchantReference = transaction.merchant_reference || 
                             transaction.trxref || 
                             transaction.reference;
    
    if (!merchantReference) {
      console.error("❌ Référence marchand manquante:", transaction);
      return res.status(400).json({ 
        success: false, 
        message: "Référence marchand manquante" 
      });
    }

    console.log(`📝 Référence marchand: ${merchantReference}`);
    console.log(`🔑 Référence NotchPay: ${transaction.reference}`);

    // Chercher la transaction existante
    const { data: existingTransaction, error: findError } = await supabase
      .from('transactions')
      .select('*')
      .eq('reference', merchantReference)
      .single();

    if (findError) {
      console.log(`📝 Transaction non trouvée, création avec: ${merchantReference}`);
      
      const userId = transaction.metadata?.userId || 'unknown';
      
      const { error: insertError } = await supabase
        .from('transactions')
        .insert({
          reference: merchantReference,
          notchpay_reference: transaction.reference,
          user_id: userId,
          amount: transaction.amount / 100,
          currency: transaction.currency || 'XAF',
          status: transaction.status,
          payment_method: 'notchpay',
          metadata: {
            webhook_event: event,
            webhook_data: payload,
            notchpay_transaction: transaction,
            processed_at: new Date().toISOString(),
            mode: "TEST"
          },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });

      if (insertError) {
        console.error("❌ Erreur création transaction:", insertError);
      } else {
        console.log("✅ Transaction créée");
      }
    } else {
      console.log(`✅ Transaction existante trouvée, ID: ${existingTransaction.id}`);
      
      // Mettre à jour la transaction
      const { error: updateError } = await supabase
        .from('transactions')
        .update({
          notchpay_reference: transaction.reference || existingTransaction.notchpay_reference,
          status: transaction.status,
          metadata: {
            ...existingTransaction.metadata,
            webhook_event: event,
            webhook_data: payload,
            notchpay_transaction: transaction,
            webhook_processed_at: new Date().toISOString()
          },
          updated_at: new Date().toISOString(),
          completed_at: (transaction.status === 'complete' || transaction.status === 'success') ? 
            new Date().toISOString() : null
        })
        .eq('id', existingTransaction.id);

      if (updateError) {
        console.error("❌ Erreur mise à jour transaction:", updateError);
      } else {
        console.log("✅ Transaction mise à jour");
      }
    }

    // Si paiement réussi, mettre à jour l'utilisateur IMMÉDIATEMENT
    if (transaction.status === 'complete' || transaction.status === 'success') {
      console.log(`💰 Paiement REUSSI pour ${merchantReference}`);
      
      let userId = transaction.metadata?.userId;
      
      if (!userId && existingTransaction) {
        userId = existingTransaction.user_id;
      }
      
      if (userId && !userId.startsWith('unknown')) {
        console.log(`👤 Mise à jour utilisateur ${userId} en PREMIUM`);
        
        // Mettre à jour le profil
        const { error: profileError } = await supabase
          .from('profiles')
          .update({
            is_premium: true,
            premium_activated_at: new Date().toISOString(),
            payment_reference: merchantReference,
            last_payment_date: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('id', userId);

        if (profileError) {
          console.error("❌ Erreur mise à jour profil:", profileError);
        } else {
          console.log("✅ Profil mis à jour");
        }

        // Créer l'abonnement
        const { error: subError } = await supabase
          .from('subscriptions')
          .upsert({
            user_id: userId,
            plan: 'premium',
            transaction_reference: merchantReference,
            status: 'active',
            starts_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          });

        if (subError) {
          console.error("❌ Erreur création abonnement:", subError);
        } else {
          console.log("✅ Abonnement créé");
        }
      }
    } else if (transaction.status === 'failed') {
      console.log(`❌ Paiement ÉCHOUÉ pour ${merchantReference}`);
      
      // Mettre à jour la transaction comme échouée
      await supabase
        .from('transactions')
        .update({
          status: 'failed',
          updated_at: new Date().toISOString()
        })
        .eq('reference', merchantReference);
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

// 🔥 ROUTE POUR FORCER LA MISE À JOUR D'UNE TRANSACTION
router.post("/force-update/:reference", authenticateUser, async (req, res) => {
  try {
    const { reference } = req.params;
    const { status } = req.body;
    const userId = req.user.id;

    if (!status) {
      return res.status(400).json({
        success: false,
        message: "Statut requis"
      });
    }

    console.log(`🔄 Force update: ${reference} -> ${status}`);

    // Mettre à jour la transaction
    const { data: transaction, error } = await supabase
      .from('transactions')
      .update({
        status: status,
        updated_at: new Date().toISOString(),
        completed_at: (status === 'complete' || status === 'success') ? new Date().toISOString() : null
      })
      .eq('reference', reference)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      throw error;
    }

    // Si marqué comme réussi, mettre à jour le profil
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
      message: `Transaction ${reference} mise à jour à ${status}`,
      transaction: transaction
    });

  } catch (error) {
    console.error("❌ Erreur force-update:", error);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de la mise à jour"
    });
  }
});

// 🔥 ROUTE POUR VÉRIFIER TOUTES LES TRANSACTIONS EN ATTENTE
router.get("/check-pending", authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Chercher toutes les transactions en attente
    const { data: transactions, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (error) {
      throw error;
    }

    const results = [];
    
    // Vérifier chaque transaction
    for (const transaction of transactions) {
      try {
        const response = await axios.get(
          `${NOTCHPAY_CONFIG.baseUrl}/payments/${transaction.reference}`,
          {
            headers: {
              "Authorization": NOTCHPAY_CONFIG.publicKey,
              "Accept": "application/json"
            }
          }
        );
        
        const data = response.data;
        const status = data.transaction?.status || data.status || 'pending';
        
        // Mettre à jour si le statut a changé
        if (status !== transaction.status) {
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
                payment_reference: transaction.reference,
                updated_at: new Date().toISOString()
              })
              .eq('id', userId);
          }
        }
        
        results.push({
          reference: transaction.reference,
          old_status: transaction.status,
          new_status: status,
          updated: status !== transaction.status
        });
        
      } catch (error) {
        results.push({
          reference: transaction.reference,
          old_status: transaction.status,
          new_status: 'pending',
          error: error.message
        });
      }
    }

    return res.json({
      success: true,
      message: `${transactions.length} transactions vérifiées`,
      results: results
    });

  } catch (error) {
    console.error("❌ Erreur check-pending:", error);
    return res.status(500).json({
      success: false,
      message: "Erreur vérification"
    });
  }
});

module.exports = router;
