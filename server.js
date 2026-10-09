require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./authRoutes');
const chatRoutes = require('./chatRoutes');
const adminRoutes = require('./adminRoutes');
const paymentRoutes = require('./paymentRoutes');
const modelsRoutes = require('./modelsRoutes');

// جديد
const imageRoutes = require('./imageRoutes');

const app = express();

// CORS: كنسمحو غير للدومين الحقيقي ديال الموقع، ماشي لأي موقع فالعالم
// ALLOWED_ORIGINS فـ Render: دومينات مفصولة بفاصلة، مثلاً:
// https://usequerymix.com,https://www.usequerymix.com
const defaultOrigins = ['https://usequerymix.com', 'https://www.usequerymix.com'];
const envOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);
const allowedOrigins = envOrigins.length ? envOrigins : defaultOrigins;

app.use(cors({
  origin(origin, callback) {
    // بلا origin (Postman، curl، تطبيقات الهاتف) كنسمحو ليها
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    console.warn('CORS رفض الأصل:', origin);
    callback(new Error('غير مسموح من هاد الأصل (CORS)'));
  }
}));
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api', chatRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/models', modelsRoutes);

// جديد
app.use('/api/images', imageRoutes);

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'AI Compare Backend خدام',
    features: [
      'chat',
      'compare',
      'images',
      'payments'
    ]
  });
});

const PORT = process.env.PORT || 3000;

// معالج أخطاء عام (يشمل رفض CORS) — كيرجع JSON نظيف بدل صفحة HTML مخيفة
app.use((err, req, res, next) => {
  if (err && err.message === 'غير مسموح من هاد الأصل (CORS)') {
    return res.status(403).json({ error: 'الطلب مرفوض (أصل غير مسموح)' });
  }
  console.error('خطأ غير متوقع:', err);
  res.status(500).json({ error: 'وقع مشكل فالسيرفر' });
});

app.listen(PORT, () => {
  console.log(
    `السيرفر خدام على http://localhost:${PORT}`
  );
});
