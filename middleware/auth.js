require("dotenv").config();
const { createClient } = require('@supabase/supabase-js');

// Initialiser Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  process.env.SUPABASE_ANON_KEY
);

// Middleware d'authentification amélioré
const authenticateUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log('Pas de token Bearer dans les headers');
      return res.status(401).json({
        success: false,
        message: "Token d'authentification requis. Format: Bearer <token>"
      });
    }
    
    const token = authHeader.split(' ')[1];
    
    if (!token || token.length < 10) {
      return res.status(401).json({
        success: false,
        message: "Token invalide"
      });
    }
    
    console.log('Vérification du token JWT...');
    
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error) {
      console.error('Erreur vérification token:', error.message);
      return res.status(401).json({
        success: false,
        message: "Token invalide ou expiré",
        details: error.message
      });
    }
    
    if (!user) {
      console.error('Aucun utilisateur trouvé pour ce token');
      return res.status(401).json({
        success: false,
        message: "Utilisateur non trouvé"
      });
    }
    
    console.log(`Utilisateur authentifié: ${user.email}`);
    req.user = user;
    next();
    
  } catch (error) {
    console.error('Erreur authentification:', error);
    res.status(500).json({
      success: false,
      message: "Erreur d'authentification",
      error: error.message
    });
  }
};

module.exports = {
  authenticateUser,
  supabase
};