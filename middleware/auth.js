require("dotenv").config();
const { createClient } = require('@supabase/supabase-js');

// Initialiser Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// Middleware d'authentification
const authenticateUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: "Token d'authentification requis"
      });
    }
    
    const token = authHeader.split(' ')[1];
    
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      return res.status(401).json({
        success: false,
        message: "Token invalide ou expiré"
      });
    }
    
    req.user = user;
    next();
    
  } catch (error) {
    console.error('Erreur authentification:', error);
    res.status(500).json({
      success: false,
      message: "Erreur d'authentification"
    });
  }
};

module.exports = {
  authenticateUser,
  supabase
};
