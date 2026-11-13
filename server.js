require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./authRoutes');
const chatRoutes = require('./chatRoutes');
const adminRoutes = require('./adminRoutes');
const paymentRoutes = require('./paymentRoutes');
const imageRoutes = require('./imageRoutes');

const app = express();

// Render كيحط proxy قدام السيرفر: بلا هادي rate limit كيشوف IP ديال Render ماشي ديال المستخدم
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,      // الواجهة فـ دومين آخر وكاتستعمل inline scripts
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// CORS: غير الدومينات ديالنا (+ localhost للتجربة)
const allowedOrigins = [
  'https://usequerymix.com',
  'https://www.usequerymix.com',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
];
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Origin غير مسموح'));
  }
}));

app.use(express.json({ limit: '1mb' }));

// Rate limits (فـ الذاكرة: كافية دابا. Redis غير من بعد ما يكبر الموقع)
const mk = (windowMs, max) => rateLimit({
  windowMs, max, standardHeaders: true, legacyHeaders: false,
  message: { error: 'طلبات بزاف، عاود جرب من بعد شوية' }
});
app.use('/api/auth', mk(15 * 60 * 1000, 30));   // حماية login/signup من brute force
app.use('/api/admin', mk(15 * 60 * 1000, 30));
app.use('/api', mk(60 * 1000, 120));             // عام (مرفوع: شبكات الهاتف كتشارك IP)

// الـ webhook ديال Gumroad ماشي متأثر: كايدوز غير بـ seller_id صحيح
app.use('/api/auth', authRoutes);
app.use('/api', chatRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/payment', paymentRoutes);
// الفرونت الحالي كيستعمل /api/images/* (models, usage, generate)
app.use('/api/images', imageRoutes);

// خفيف: لـ cron-job / UptimeRobot، ما كايمس DB
app.get('/health', (req, res) => res.status(200).send('ok'));

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'AI Compare Backend خدام' });
});

app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(err.message === 'Origin غير مسموح' ? 403 : 500).json({ error: 'وقع مشكل فالسيرفر' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`السيرفر خدام على http://localhost:${PORT}`));
