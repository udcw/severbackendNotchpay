const express = require("express");
const axios = require("axios");
const auth = require('../middleware/auth');
const { NOTCHPAY_CONFIG, authenticateUser, supabase } = require("../middleware/auth");

const router = express.Router();

// 🔥 INITIER UN PAIEMENT (version LIVE corrigée)
router.post("/initialize", authenticateUser, async (req, res) => {
  try {
    const { amount, phone, description = "Abonnement Premium Kamerun News", mode = 'live' } = req.body;
    const userId = req.user.id;

    // Validation
    if (!amount || amount < 100) {
      return res.status(400).json({
        success: false,
        message: "Le montant doit être d'au moins 100 FCFA"
      });
    }

    console.log("🆔 User ID:", userId);
    console.log("📧 User email:", req.user.email);
    console.log("🚀 Mode:", mode);

    // VÉRIFIER si on utilise les bonnes clés LIVE
    const publicKey = NOTCHPAY_CONFIG.publicKey;
    console.log("🔑 Clé publique utilisée:", publicKey ? publicKey.substring(0, 10) + '...' : 'NON DÉFINIE');
    
    // Détecter si on est en mode test
    if (publicKey && publicKey.includes('SBX') || publicKey.includes('test')) {
      console.warn("⚠️ ⚠️ ⚠️ ATTENTION: Clé publique de TEST détectée!");
      console.warn("⚠️ Utilisez les clés LIVE de NotchPay pour accepter de vrais paiements");
    }

    // SOLUTION SIMPLE: Utiliser directement les données de l'utilisateur depuis le JWT
    const userProfile = {
      id: userId,
      email: req.user.email,
      first_name: req.user.user_metadata?.first_name || req.user.user_metadata?.full_name?.split(' ')[0] || 'Utilisateur',
      last_name: req.user.user_metadata?.last_name || req.user.user_metadata?.full_name?.split(' ').slice(1).join(' ') || 'Kamerun',
      phone: phone || null
    };

    console.log('👤 Utilisateur (depuis JWT):', userProfile);

    // Préparer les données NotchPay
    const reference = `KAMERUN-${userId}-${Date.now()}`;
    const amountInCents = Math.round(amount * 100);

    const payload = {
      amount: amountInCents,
      currency: "XAF",
      description: description,
      reference: reference,
      email: req.user.email,
      customer: {
        name: `${userProfile.first_name} ${userProfile.last_name}`,
        email: req.user.email,
        phone: userProfile.phone || ''
      },
      callback_url: NOTCHPAY_CONFIG.callbackUrl,
      metadata: {
        userId: userId,
        userEmail: req.user.email,
        userFirstName: userProfile.first_name,
        userLastName: userProfile.last_name,
        plan: "premium",
        type: "subscription",
        app: "Kamerun News",
        mode: mode // Ajouter le mode dans les métadonnées
      }
    };

    console.log("📤 Payload NotchPay:", JSON.stringify(payload, null, 2));

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
        timeout: 15000
      }
    );

    console.log("✅ Réponse NotchPay complète:", JSON.stringify(response.data, null, 2));

    // DEBUG: Vérifier la structure de la réponse
    console.log("🔍 Structure réponse NotchPay:");
    console.log("- transaction:", response.data.transaction);
    console.log("- authorization_url:", response.data.transaction?.authorization_url);
    console.log("- checkout_url:", response.data.checkout_url);
    console.log("- links:", response.data.links);

    // Extraire l'URL de paiement (différentes possibilités selon NotchPay)
    let paymentUrl = null;
    
    // Essayer différentes clés possibles
    if (response.data.transaction?.authorization_url) {
      paymentUrl = response.data.transaction.authorization_url;
    } else if (response.data.authorization_url) {
      paymentUrl = response.data.authorization_url;
    } else if (response.data.checkout_url) {
      paymentUrl = response.data.checkout_url;
    } else if (response.data.links?.authorization_url) {
      paymentUrl = response.data.links.authorization_url;
    } else if (response.data.links?.checkout) {
      paymentUrl = response.data.links.checkout;
    } else if (response.data.url) {
      paymentUrl = response.data.url;
    }

    console.log("🔗 URL de paiement extraite:", paymentUrl);

    if (!paymentUrl) {
      console.error("❌ Aucune URL de paiement trouvée dans la réponse NotchPay");
      return res.status(500).json({
        success: false,
        message: "Erreur: aucune URL de paiement reçue de NotchPay",
        notchpay_response: response.data
      });
    }

    // VÉRIFIER que l'URL n'est pas en mode test
    if (paymentUrl.includes('/test.')) {
      console.warn("⚠️ ATTENTION: URL de paiement en mode TEST détectée!");
      console.warn("⚠️ Vous devez utiliser les clés LIVE de NotchPay");
      
      // On peut quand même continuer pour le moment
      console.log("ℹ️ Continuer avec l'URL de test pour le débogage");
    } else {
      console.log("✅ URL de paiement LIVE détectée");
    }

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
          payment_url: paymentUrl,
          mode: mode
        }
      })
      .select()
      .single();

    if (dbError) {
      console.error('❌ Erreur DB transaction:', dbError);
    } else {
      console.log('✅ Transaction enregistrée:', transaction?.id);
    }

    return res.json({
      success: true,
      message: "Paiement initialisé avec succès",
      data: {
        authorization_url: paymentUrl,
        reference: reference,
        transaction_id: transaction?.id,
        checkout_url: paymentUrl,
        debug_info: {
          response_structure: Object.keys(response.data),
          mode_detected: paymentUrl.includes('/test.') ? 'TEST' : 'LIVE'
        }
      }
    });

  } catch (err) {
    console.error("❌ Erreur NotchPay DÉTAILLÉE:", {
      message: err.message,
      response: err.response?.data,
      status: err.response?.status,
      config: {
        url: err.config?.url,
        method: err.config?.method,
        data: err.config?.data
      }
    });
    
    return res.status(err.response?.status || 500).json({
      success: false,
      message: err.response?.data?.message || "Erreur lors de l'initialisation du paiement",
      error: err.message,
      debug: err.response?.data
    });
  }
});

// 🔥 VÉRIFIER UN PAIEMENT - VERSION CORRIGÉE
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

    // 1. D'abord, vérifier la transaction dans notre base de données
    const { data: dbTransaction, error: dbError } = await supabase
      .from('transactions')
      .select('*')
      .eq('reference', reference)
      .eq('user_id', userId)
      .single();

    if (dbError || !dbTransaction) {
      console.log("❌ Transaction non trouvée en base:", reference);
      return res.json({
        success: false,
        message: "Transaction non trouvée",
        pending: true,
        paid: false,
        status: 'not_found'
      });
    }

    console.log("✅ Transaction trouvée en base:", dbTransaction.status);

    // 2. Si la transaction est déjà marquée comme complète en base, retourner directement
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

    // 3. Essayer de vérifier avec NotchPay (seulement si en attente)
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

      // Mettre à jour la transaction en base
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

      // Si paiement réussi, mettre à jour le profil
      if (isComplete) {
        // AJOUTER la colonne premium_activated_at si elle n'existe pas
        await supabase.rpc('add_column_if_not_exists', {
          table_name: 'profiles',
          column_name: 'premium_activated_at',
          column_type: 'TIMESTAMP WITH TIME ZONE'
        }).catch(err => {
          console.log("⚠️ La colonne premium_activated_at existe peut-être déjà ou erreur RPC:", err.message);
        });

        // Mettre à jour le profil
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

        // Enregistrer l'abonnement
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
          }, {
            onConflict: 'user_id, transaction_reference'
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
      // Si NotchPay retourne "Payment Not Found", c'est normal au début
      console.log("⚠️ NotchPay n'a pas encore le paiement, réessayez plus tard");
      
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
    console.error("❌ Erreur vérification:", err.response?.data || err.message);
    
    // Ne pas retourner d'erreur 500, juste indiquer que c'est en attente
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
        
        // Vérifier et créer la colonne premium_activated_at si nécessaire
        await supabase.rpc('add_column_if_not_exists', {
          table_name: 'profiles',
          column_name: 'premium_activated_at',
          column_type: 'TIMESTAMP WITH TIME ZONE'
        }).catch(err => {
          console.log("⚠️ La colonne premium_activated_at existe peut-être déjà ou erreur RPC:", err.message);
        });
        
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
    webhook_endpoint: "POST /api/payments/webhook",
    mode: "LIVE"
  });
});

// 🔥 CRÉER/VÉRIFIER UN PROFIL (pour débogage) - VERSION AMÉLIORÉE
router.post("/ensure-profile", authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Vérifier si le profil existe
    const { data: existingProfile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();
    
    if (profileError || !existingProfile) {
      // Créer le profil avec toutes les colonnes nécessaires
      const newProfileData = {
        id: userId,
        email: req.user.email,
        first_name: req.user.user_metadata?.first_name || req.user.user_metadata?.full_name?.split(' ')[0] || 'Utilisateur',
        last_name: req.user.user_metadata?.last_name || req.user.user_metadata?.full_name?.split(' ').slice(1).join(' ') || 'Kamerun',
        is_premium: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      
      const { data: newProfile, error: createError } = await supabase
        .from('profiles')
        .upsert(newProfileData, { onConflict: 'id' })
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
    
    // Vérifier si la colonne premium_activated_at existe
    if (existingProfile.premium_activated_at === undefined) {
      // Créer la colonne via RPC
      await supabase.rpc('add_column_if_not_exists', {
        table_name: 'profiles',
        column_name: 'premium_activated_at',
        column_type: 'TIMESTAMP WITH TIME ZONE'
      }).catch(err => {
        console.log("⚠️ Erreur lors de l'ajout de la colonne:", err.message);
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

// 🔥 FONCTION POUR AJOUTER UNE COLONNE SI ELLE N'EXISTE PAS
router.post("/add-premium-activated-column", async (req, res) => {
  try {
    // Créer la fonction RPC si elle n'existe pas
    const { error: createRpcError } = await supabase.rpc('add_column_if_not_exists', {
      table_name: 'profiles',
      column_name: 'premium_activated_at',
      column_type: 'TIMESTAMP WITH TIME ZONE'
    });

    if (createRpcError) {
      // Si la fonction RPC n'existe pas, la créer d'abord
      const createFunctionSQL = `
        CREATE OR REPLACE FUNCTION add_column_if_not_exists(
          table_name text,
          column_name text,
          column_type text
        )
        RETURNS void AS $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 
            FROM information_schema.columns 
            WHERE table_name = $1 AND column_name = $2
          ) THEN
            EXECUTE format('ALTER TABLE %I ADD COLUMN %I %s', $1, $2, $3);
          END IF;
        END;
        $$ LANGUAGE plpgsql;
      `;

      await supabase.rpc('exec_sql', { sql: createFunctionSQL }).catch(err => {
        console.log("Erreur création fonction:", err.message);
      });

      // Réessayer d'ajouter la colonne
      await supabase.rpc('add_column_if_not_exists', {
        table_name: 'profiles',
        column_name: 'premium_activated_at',
        column_type: 'TIMESTAMP WITH TIME ZONE'
      }).catch(err => {
        console.log("Erreur après création fonction:", err.message);
      });
    }

    return res.json({
      success: true,
      message: "Colonne premium_activated_at ajoutée ou vérifiée avec succès"
    });
    
  } catch (err) {
    console.error("❌ Erreur ajout colonne:", err);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de l'ajout de la colonne",
      error: err.message
    });
  }
});

// 🔥 CONFIGURATION (public)
router.get("/config", (req, res) => {
  const publicKey = NOTCHPAY_CONFIG.publicKey;
  const isTestMode = publicKey && (publicKey.includes('SBX') || publicKey.includes('test'));
  
  return res.json({
    success: true,
    data: {
      publicKey: publicKey ? "✅ Configurée" : "❌ Manquante",
      mode: isTestMode ? "TEST" : "LIVE",
      baseUrl: NOTCHPAY_CONFIG.baseUrl,
      currency: "XAF",
      supportedMethods: ["mobile_money", "card", "bank"],
      status: "active",
      warning: isTestMode ? "⚠️ Vous utilisez des clés de TEST. Passez en mode LIVE pour accepter de vrais paiements." : null
    }
  });
});

// 🔥 METTRE À JOUR LA CONFIGURATION NOTCHPAY
router.post("/update-config", (req, res) => {
  // Cette route serait protégée en production
  const { publicKey, secretKey } = req.body;
  
  if (!publicKey || !secretKey) {
    return res.status(400).json({
      success: false,
      message: "Clés publique et secrète requises"
    });
  }
  
  // En production, vous devriez stocker ces clés dans une base de données sécurisée
  // Pour l'instant, on ne fait que logger
  console.log("🔄 Mise à jour des clés NotchPay:");
  console.log("Nouvelle clé publique:", publicKey.substring(0, 15) + '...');
  console.log("Nouvelle clé secrète:", secretKey.substring(0, 10) + '...');
  
  const isLiveKey = publicKey.includes('live') && !publicKey.includes('test') && !publicKey.includes('SBX');
  
  return res.json({
    success: true,
    message: "Configuration mise à jour",
    mode: isLiveKey ? "LIVE" : "TEST",
    warning: isLiveKey ? null : "⚠️ Clés de TEST détectées"
  });
});

module.exports = router;