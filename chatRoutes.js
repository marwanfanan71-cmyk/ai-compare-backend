const express = require('express');
const db = require('./database');
const { requireAuth } = require('./authMiddleware');

const router = express.Router();

const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '7', 10);
// سقف يومي ضد الاستغلال (ماشي حد تجاري): التجربة كاتبقى "بلا حدود" للمستخدم العادي
const TRIAL_CHAT_HARD_LIMIT = parseInt(process.env.TRIAL_CHAT_HARD_LIMIT || '150', 10);
const PREMIUM_CHAT_HARD_LIMIT = parseInt(process.env.PREMIUM_CHAT_HARD_LIMIT || '1000', 10);
const MAX_PROMPT_CHARS = 20000;   // الفرونت كيرسل حتى ~14000 + التعليمات
const OPENROUTER_TIMEOUT_MS = 55000;

// مسموح غير النماذج المجانية: وإلا أي مستخدم يقدر يطلب نموذج مدفوع على حسابك فـ OpenRouter
const FREE_MODEL_RE = /^[A-Za-z0-9._\-\/]{1,100}:free$/;
function isAllowedModel(model) {
  return typeof model === 'string' && (model === 'openrouter/free' || FREE_MODEL_RE.test(model));
}

function getTrialStatus(createdAt) {
  const createdDate = new Date(createdAt);
  const now = new Date();
  const diffDays = (now - createdDate) / (1000 * 60 * 60 * 24);
  const daysLeft = Math.max(0, TRIAL_DAYS - diffDays);
  return { inTrial: diffDays < TRIAL_DAYS, daysLeft: Math.ceil(daysLeft) };
}

router.get('/usage', requireAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT is_premium, created_at FROM users WHERE id = $1', [req.userId]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'الحساب ماعادش موجود، عاود سجل الدخول' });
    const isPremium = !!user.is_premium;
    const trial = getTrialStatus(user.created_at);
    res.json({
      is_premium: isPremium,
      in_trial: !isPremium && trial.inTrial,
      trial_days_left: !isPremium ? trial.daysLeft : null,
      trial_total_days: TRIAL_DAYS,
      unlimited: isPremium || trial.inTrial
    });
  } catch (err) {
    console.error('usage error:', err.message);
    res.status(500).json({ error: 'وقع مشكل فالسيرفر' });
  }
});

router.post('/chat', requireAuth, async (req, res) => {
  const { model, prompt } = req.body || {};
  if (!model || !prompt) return res.status(400).json({ error: 'خاص model و prompt' });
  if (typeof prompt !== 'string') return res.status(400).json({ error: 'الطلب غير صالح' });
  if (prompt.length > MAX_PROMPT_CHARS) {
    return res.status(400).json({ error: 'النص طويل بزاف، قصرو شوية' });
  }
  if (!isAllowedModel(model)) {
    return res.status(400).json({ error: 'هاد النموذج ماشي مسموح' });
  }

  let reserved = false;
  const today = new Date().toISOString().split('T')[0];

  try {
    const result = await db.query('SELECT is_premium, created_at FROM users WHERE id = $1', [req.userId]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'الحساب ماعادش موجود، عاود سجل الدخول' });
    const isPremium = !!user.is_premium;
    const trial = getTrialStatus(user.created_at);

    if (!isPremium && !trial.inTrial) {
      return res.status(429).json({
        error: 'خلصات التجربة المجانية ديالك (' + TRIAL_DAYS + ' أيام). اشترك باش تكمل تستعمل الموقع بلا حدود.',
        trial_ended: true
      });
    }

    // حجز ذري للحصة: ما كاين غلط حتى لو جاو طلبات بزاف فنفس اللحظة
    const cap = isPremium ? PREMIUM_CHAT_HARD_LIMIT : TRIAL_CHAT_HARD_LIMIT;
    const reserve = await db.query(`
      INSERT INTO usage_log (user_id, date, count) VALUES ($1, $2, 1)
      ON CONFLICT (user_id, date) DO UPDATE SET count = usage_log.count + 1
      WHERE usage_log.count < $3
      RETURNING count
    `, [req.userId, today, cap]);

    if (reserve.rowCount === 0) {
      return res.status(429).json({
        error: 'وصلتي للسقف اليومي (' + cap + ' طلب). عاود جرب غدا.',
        limit_reached: true
      });
    }
    reserved = true;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
    let response, data;
    try {
      response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + process.env.OPENROUTER_API_KEY
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1500
        }),
        signal: controller.signal
      });
      data = await response.json().catch(() => ({}));
    } finally {
      clearTimeout(timeoutId);
    }

    const text = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : null;

    if (!response.ok || data.error || !text) {
      // ما كنحسبوش المحاولة الفاشلة على المستخدم
      await releaseReservation(req.userId, today);
      reserved = false;
      const upstream = data && data.error && data.error.message ? String(data.error.message).slice(0, 200) : '';
      console.error('OpenRouter error:', response.status, model, upstream);
      return res.status(502).json({ error: upstream || 'النموذج ما جاوبش، جرب نموذج آخر' });
    }

    res.json({ text });
  } catch (err) {
    if (reserved) await releaseReservation(req.userId, today);
    const timedOut = err && err.name === 'AbortError';
    console.error('chat error:', err.message);
    res.status(timedOut ? 504 : 500).json({
      error: timedOut ? 'النموذج تأخر بزاف، جرب نموذج آخر' : 'وقع مشكل فالسيرفر، عاود جرب'
    });
  }
});

async function releaseReservation(userId, date) {
  try {
    await db.query(
      'UPDATE usage_log SET count = GREATEST(count - 1, 0) WHERE user_id = $1 AND date = $2',
      [userId, date]
    );
  } catch (e) {
    console.error('release error:', e.message);
  }
}

module.exports = router;
