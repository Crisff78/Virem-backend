const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Health check
app.get('/health', (req, res) => {
  res.json({ success: true, message: 'Backend OK ✅' });
});

// ✅ Importar rutas (OJO: rutas correctas)
const authRoutes = require('./routes/auth.routes.js');
const phoneRoutes = require('./routes/phone.routes.js');

// ✅ Montar rutas
app.use('/api/auth', authRoutes);
app.use('/api/phone', phoneRoutes);

// ✅ Ruta “catch-all” (para saber si te estás equivocando de endpoint)
app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: `Ruta no existe: ${req.method} ${req.originalUrl}`,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend corriendo en http://localhost:${PORT}`);
});