const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// ✅ Ruta raíz (para que no te salga "Ruta no existe: GET /")
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: '🚀 Backend corriendo correctamente',
    endpoints: {
      health: '/health',
      auth: '/api/auth',
      phone: '/api/phone',
    },
  });
});

// ✅ Health check
app.get('/health', (req, res) => {
  res.json({ success: true, message: 'Backend OK ✅' });
});

// ✅ Importar rutas
const authRoutes = require('./routes/auth.routes.js');
const phoneRoutes = require('./routes/phone.routes.js');

// ✅ Montar rutas
app.use('/api/auth', authRoutes);
app.use('/api/phone', phoneRoutes);

// ✅ Catch-all (si te equivocas de endpoint)
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