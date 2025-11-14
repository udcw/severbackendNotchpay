const express = require('express');
const axios = require('axios');
const NOTCHPAY_CONFIG = require('../middleware/auth');

const router = express.Router();

// Initier un paiement
router.post('/initiate', async (req, res) => {
  try {
    const { email, amount, name, phone, description = 'Abonnement Premium' } = req.body;

    // Validation des données
    if (!email || !amount || !name) {
      return res.status(400).json({
        success: false,
        message: 'Email, montant et nom sont requis'
      });
    }

    const paymentData = {
      email: email,
      amount: amount,
      currency: 'XAF',
      description: description,
      callback: 'https://votreapp.com/payment-callback', // URL de callback
      reference: `REF-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };

    const response = await axios.post(
      `${NOTCHPAY_CONFIG.baseUrl}/payments/initialize`,
      paymentData,
      {
        headers: {
          'Authorization': NOTCHPAY_CONFIG.publicKey,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json({
      success: true,
      data: response.data,
      paymentUrl: response.data.transaction.url
    });

  } catch (error) {
    console.error('Erreur initiation paiement:', error.response?.data || error.message);
    
    res.status(500).json({
      success: false,
      message: 'Erreur lors de l\'initiation du paiement',
      error: error.response?.data || error.message
    });
  }
});

// Vérifier le statut d'un paiement
router.get('/verify/:reference', async (req, res) => {
  try {
    const { reference } = req.params;

    const response = await axios.get(
      `${NOTCHPAY_CONFIG.baseUrl}/payments/${reference}`,
      {
        headers: {
          'Authorization': NOTCHPAY_CONFIG.publicKey,
          'Content-Type': 'application/json'
        }
      }
    );

    const transaction = response.data.transaction;
    
    res.json({
      success: true,
      status: transaction.status,
      transaction: transaction
    });

  } catch (error) {
    console.error('Erreur vérification paiement:', error.response?.data || error.message);
    
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la vérification du paiement',
      error: error.response?.data || error.message
    });
  }
});

// Webhook pour les notifications de paiement
router.post('/webhook', async (req, res) => {
  try {
    const webhookData = req.body;
    
    console.log('Webhook reçu:', webhookData);

    // Vérifier la signature du webhook si nécessaire
    // (NotchPay peut envoyer une signature pour sécuriser)

    const { event, data } = webhookData;

    if (event === 'payment.complete') {
      // Paiement réussi - donner l'accès premium
      const { transaction } = data;
      
      console.log('Paiement réussi:', transaction.reference);
      
      // Ici, vous mettez à jour votre base de données
      // pour donner l'accès premium à l'utilisateur
      
      // Exemple: mettre à jour le statut de l'utilisateur
      await User.updateOne(
        { email: transaction.customer.email },
        { isPremium: true, premiumExpiresAt: new Date(Date.now() + 30*24*60*60*1000) }
      );
    }

    if (event === 'payment.failed') {
      // Paiement échoué
      const { transaction } = data;
      console.log('Paiement échoué:', transaction.reference);
    }

    res.status(200).json({ received: true });

  } catch (error) {
    console.error('Erreur webhook:', error);
    res.status(500).json({ success: false, message: 'Erreur webhook' });
  }
});

// Obtenir l'historique des transactions
router.get('/history', async (req, res) => {
  try {
    const { page = 1, per_page = 10 } = req.query;

    const response = await axios.get(
      `${NOTCHPAY_CONFIG.baseUrl}/payments?page=${page}&per_page=${per_page}`,
      {
        headers: {
          'Authorization': NOTCHPAY_CONFIG.secretKey, // Utiliser la clé secrète pour l'historique
          'Content-Type': 'application/json'
        }
      }
    );

    res.json({
      success: true,
      data: response.data
    });

  } catch (error) {
    console.error('Erreur historique:', error.response?.data || error.message);
    
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération de l\'historique',
      error: error.response?.data || error.message
    });
  }
});

module.exports = router;