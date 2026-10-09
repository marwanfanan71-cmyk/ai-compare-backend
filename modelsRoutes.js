const express = require('express');

const router = express.Router();

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_TTL_MS = 20 * 60 * 1000;

const FALLBACK_MODELS = [
  { id: 'openrouter/free', label: 'Auto (Free)' }
];

const EXCLUDED_KEYWORDS = [
  'content-safety',
  'moderation',
  'classifier',
  'safety',
  'guard',
  'embed',
  'whisper',
  'tts',
  'music',
  'image',
  'nano-omni',
  '3-super',
  '3-ultra',
  'classif',
  'rerank',
  'reward'
];

const ALLOWED_PREFIXES = [
  'meta-llama/',
  'google/',
  'qwen/',
  'nvidia/',
  'mistralai/',
  'moonshotai/',
  'deepseek/',
  'microsoft/',
  'openrouter/'
];

const SORT_PRIORITY = [
  'openrouter/',
  'deepseek/',
  'meta-llama/',
  'qwen/',
  'google/',
  'mistralai/'
];

let cache = {
  data: null,
  expiresAt: 0,
  updatedAt: null
};

// يمنع 20 طلباً متزامناً من إنشاء 20 طلباً إلى OpenRouter.
let refreshPromise = null;

function isSuitableFreeTextModel(model) {
  const id = String(model.id || '').toLowerCase();
  const pricing = model.pricing || {};
  const architecture = model.architecture || {};
  const outputs = Array.isArray(architecture.output_modalities)
    ? architecture.output_modalities
    : ['text'];

  const isFree = id.endsWith(':free') &&
    Number(pricing.prompt || 0) === 0 &&
    Number(pricing.completion || 0) === 0;
  const hasTextOutput = outputs.includes('text');
  const isAllowedPrefix = ALLOWED_PREFIXES.some(prefix => id.startsWith(prefix));
  const isExcluded = EXCLUDED_KEYWORDS.some(keyword => id.includes(keyword));

  return isFree && hasTextOutput && isAllowedPrefix && !isExcluded;
}

function formatModels(models) {
  const formatted = models
    .filter(isSuitableFreeTextModel)
    .map(model => ({
      id: model.id,
      label: String(model.name || model.id)
        .replace(/\s*\(free\)\s*$/i, '')
    }))
    .sort((a, b) => {
      const rank = id => {
        const index = SORT_PRIORITY.findIndex(prefix => id.startsWith(prefix));
        return index === -1 ? 99 : index;
      };
      const priorityDiff = rank(a.id) - rank(b.id);
      return priorityDiff || a.label.localeCompare(b.label);
    })
    .slice(0, 8);

  // Auto Free مسار عام مفيد كحل احتياطي حتى إلا ما رجعوش OpenRouter فـ /models.
  if (!formatted.some(model => model.id === 'openrouter/free')) {
    formatted.unshift({ id: 'openrouter/free', label: 'Auto (Free)' });
  }

  return formatted.slice(0, 8);
}

async function refreshModelsCache() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      let response;
      try {
        response = await fetch(OPENROUTER_MODELS_URL, {
          signal: controller.signal,
          headers: { Accept: 'application/json' }
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        throw new Error(`OpenRouter returned ${response.status}`);
      }

      const payload = await response.json();
      const models = formatModels(payload.data || []);
      if (!models.length) throw new Error('No suitable free models found');

      cache = {
        data: models,
        expiresAt: Date.now() + CACHE_TTL_MS,
        updatedAt: new Date().toISOString()
      };

      console.log(`Models cache refreshed: ${models.length} models`);
      return models;
    } catch (error) {
      console.error('Models cache refresh failed:', error.message);
      return cache.data && cache.data.length ? cache.data : FALLBACK_MODELS;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

router.get('/free', async (req, res) => {
  const cacheIsValid = Boolean(
    cache.data && cache.data.length && Date.now() < cache.expiresAt
  );
  const models = cacheIsValid ? cache.data : await refreshModelsCache();

  res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=1800');
  res.json({
    models,
    cached: cacheIsValid,
    updated_at: cache.updatedAt,
    expires_at: cache.expiresAt || null
  });
});

module.exports = router;
