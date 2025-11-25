require('dotenv').config();
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const srtParser2 = require('srt-parser-2');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

// Configurare
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENSUBTITLES_API_KEY = process.env.OPENSUBTITLES_API_KEY;
const OPENSUBTITLES_USER_AGENT = 'StremioMultiLangSubtitles v2.0';
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;
const SUBSCRIPTION_PRICE = 1.00; // $1 pentru 3 luni

// Conectare MongoDB
if (process.env.MONGODB_URI) {
    console.log('🔄 Încearcă conexiune MongoDB...');
    console.log('📋 MONGODB_URI setat:', !!process.env.MONGODB_URI);
    console.log('📋 MONGODB_URI preview:', process.env.MONGODB_URI.substring(0, 30) + '...');
    
    // Conectare cu retry logic
    async function connectMongoDB() {
        try {
            await mongoose.connect(process.env.MONGODB_URI, {
                serverSelectionTimeoutMS: 15000, // 15 secunde timeout
                socketTimeoutMS: 45000,
                connectTimeoutMS: 15000,
                maxPoolSize: 10,
                retryWrites: true,
                w: 'majority'
            });
            console.log('✅ MongoDB conectat cu succes!');
        } catch (err) {
            console.error('❌ MongoDB connection error:', err.message);
            console.error('❌ Error details:', {
                name: err.name,
                code: err.code,
                codeName: err.codeName
            });
            
            // Retry după 5 secunde
            console.log('⏳ Retry conexiune MongoDB în 5 secunde...');
            setTimeout(connectMongoDB, 5000);
        }
    }
    
    connectMongoDB();
    
    // Event handlers pentru MongoDB
    mongoose.connection.on('connected', () => {
        console.log('✅ MongoDB connected event');
    });
    
    mongoose.connection.on('error', (err) => {
        console.error('❌ MongoDB error event:', err.message);
    });
    
    mongoose.connection.on('disconnected', () => {
        console.log('⚠️ MongoDB disconnected event');
    });
    
    mongoose.connection.on('connecting', () => {
        console.log('🔄 MongoDB connecting...');
    });
} else {
    console.log('⚠️ MONGODB_URI nu este setat - aplicația va funcționa dar nu vor fi salvate date');
}

// Schema User
const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, index: true },
    apiKey: { type: String, required: true, unique: true, index: true },
    preferredLanguage: { type: String, default: 'ro' },
    subscriptionStatus: { type: String, enum: ['trial', 'active', 'expired'], default: 'trial' },
    subscriptionEndDate: { type: Date },
    stripeCustomerId: { type: String },
    stripeSubscriptionId: { type: String },
    translationsUsed: { type: Number, default: 0 },
    freeTranslationsLimit: { type: Number, default: 5 },
    createdAt: { type: Date, default: Date.now },
    lastActive: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Schema pentru Translation Cache
const translationCacheSchema = new mongoose.Schema({
    cacheKey: { type: String, required: true, unique: true, index: true },
    fileId: { type: String, required: true },
    sourceLang: { type: String, required: true },
    targetLang: { type: String, required: true },
    translatedContent: { type: String, required: true },
    usageCount: { type: Number, default: 0 },
    lastUsed: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now, expires: 7776000 } // 90 zile (3 luni)
});

const TranslationCache = mongoose.model('TranslationCache', translationCacheSchema);

// Limbi suportate
const SUPPORTED_LANGUAGES = {
    'ro': 'Română',
    'en': 'English',
    'es': 'Español',
    'fr': 'Français',
    'de': 'Deutsch',
    'it': 'Italiano',
    'pt': 'Português',
    'ru': 'Русский',
    'ar': 'العربية',
    'zh': '中文',
    'ja': '日本語',
    'ko': '한국어',
    'hi': 'हिन्दी',
    'tr': 'Türkçe',
    'pl': 'Polski',
    'nl': 'Nederlands',
    'sv': 'Svenska',
    'no': 'Norsk',
    'da': 'Dansk',
    'fi': 'Suomi'
};

// Cache în memorie pentru tokens
let osToken = null;
let tokenExpiry = 0;

// Funcții helper
function generateApiKey() {
    return 'sk_' + crypto.randomBytes(32).toString('hex');
}

function getCacheKey(fileId, sourceLang, targetLang) {
    return crypto.createHash('md5').update(`${fileId}-${sourceLang}-${targetLang}`).digest('hex');
}

async function getOpenSubtitlesToken() {
    if (osToken && Date.now() < tokenExpiry) {
        return osToken;
    }

    try {
        const response = await axios.post('https://api.opensubtitles.com/api/v1/login', {}, {
            headers: {
                'Api-Key': OPENSUBTITLES_API_KEY,
                'User-Agent': OPENSUBTITLES_USER_AGENT,
                'Content-Type': 'application/json'
            }
        });
        osToken = response.data.token;
        tokenExpiry = Date.now() + (23 * 60 * 60 * 1000);
        console.log('✅ Token OpenSubtitles obținut');
        return osToken;
    } catch (error) {
        console.error('❌ Eroare autentificare OpenSubtitles:', error.message);
        return null;
    }
}

async function searchSubtitles(imdbId, season, episode, token) {
    try {
        const params = {
            imdb_id: imdbId.replace('tt', ''),
            languages: Object.keys(SUPPORTED_LANGUAGES).join(','),
        };

        if (season && episode) {
            params.season_number = season;
            params.episode_number = episode;
        }

        const response = await axios.get('https://api.opensubtitles.com/api/v1/subtitles', {
            params: params,
            headers: {
                'Api-Key': OPENSUBTITLES_API_KEY,
                'Authorization': `Bearer ${token}`,
                'User-Agent': OPENSUBTITLES_USER_AGENT
            },
            timeout: 10000
        });

        return response.data.data || [];
    } catch (error) {
        console.error('❌ Eroare căutare subtitrări:', error.message);
        return [];
    }
}

async function downloadSubtitle(fileId, token) {
    try {
        const response = await axios.post('https://api.opensubtitles.com/api/v1/download', {
            file_id: fileId
        }, {
            headers: {
                'Api-Key': OPENSUBTITLES_API_KEY,
                'Authorization': `Bearer ${token}`,
                'User-Agent': OPENSUBTITLES_USER_AGENT,
                'Content-Type': 'application/json'
            },
            timeout: 10000
        });

        const downloadUrl = response.data.link;
        const subtitleResponse = await axios.get(downloadUrl, {
            responseType: 'arraybuffer',
            timeout: 30000
        });

        return subtitleResponse.data.toString('utf-8');
    } catch (error) {
        console.error('❌ Eroare descărcare subtitrare:', error.message);
        return null;
    }
}

async function translateWithGemini(text, sourceLang, targetLang) {
    try {
        if (!genAI) {
            console.error('❌ Gemini AI nu este inițializat - lipsește API key');
            return null;
        }
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: {
                temperature: 0.3,
                maxOutputTokens: 2048,
            }
        });
        
        // Map coduri limbă la nume complete pentru Gemini
        const langNames = {
            'en': 'English', 'es': 'Spanish', 'fr': 'French', 'de': 'German',
            'it': 'Italian', 'pt': 'Portuguese', 'ru': 'Russian', 'ar': 'Arabic',
            'zh': 'Chinese', 'ja': 'Japanese', 'ko': 'Korean', 'hi': 'Hindi',
            'tr': 'Turkish', 'pl': 'Polish', 'nl': 'Dutch', 'sv': 'Swedish',
            'no': 'Norwegian', 'da': 'Danish', 'fi': 'Finnish', 'ro': 'Romanian',
            'cs': 'Czech', 'el': 'Greek', 'he': 'Hebrew', 'hu': 'Hungarian',
            'id': 'Indonesian', 'ms': 'Malay', 'th': 'Thai', 'vi': 'Vietnamese',
            'uk': 'Ukrainian', 'bg': 'Bulgarian', 'hr': 'Croatian', 'sr': 'Serbian',
            'sk': 'Slovak', 'sl': 'Slovenian', 'et': 'Estonian', 'lv': 'Latvian',
            'lt': 'Lithuanian', 'fa': 'Persian', 'ur': 'Urdu', 'bn': 'Bengali',
            'ta': 'Tamil', 'te': 'Telugu', 'ml': 'Malayalam', 'kn': 'Kannada'
        };

        const sourceLangName = langNames[sourceLang] || sourceLang.toUpperCase();
        const targetLangName = langNames[targetLang] || targetLang.toUpperCase();
        
        const prompt = `You are a professional subtitle translator. Translate the following subtitle text from ${sourceLangName} to ${targetLangName}.

CRITICAL RULES:
1. Translate ONLY the text content, no explanations or comments
2. Keep EXACT same structure with separators (---)
3. Preserve ALL HTML formatting (<i>, <b>, <u>, etc.)
4. Use natural idioms and expressions in ${targetLangName}
5. Keep similar text length for proper subtitle timing
6. Maintain line breaks and formatting
7. DO NOT translate proper nouns (names, places) unless commonly translated
8. Preserve numbers, dates, and special characters

Text to translate:
${text}

Translated text in ${targetLangName}:`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text().trim();
    } catch (error) {
        if (error.message.includes('429')) {
            console.error('⚠️ Rate limit Gemini - waiting 60 seconds');
            await new Promise(resolve => setTimeout(resolve, 60000));
            return translateWithGemini(text, sourceLang, targetLang); // Retry
        } else {
            console.error('❌ Eroare traducere Gemini:', error.message);
        }
        return null;
    }
}

async function translateSubtitle(srtContent, sourceLang, targetLang) {
    try {
        const parser = new srtParser2();
        const parsed = parser.fromSrt(srtContent);
        
        console.log(`📝 Traducere ${parsed.length} linii: ${sourceLang} -> ${targetLang}`);
        
        const batchSize = 15;
        const batches = [];
        
        for (let i = 0; i < parsed.length; i += batchSize) {
            batches.push(parsed.slice(i, i + batchSize));
        }

        const translatedBatches = [];
        
        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            const textToTranslate = batch.map(sub => sub.text).join('\n---\n');
            
            console.log(`🔄 Traducere batch ${i + 1}/${batches.length}...`);
            
            const translatedText = await translateWithGemini(textToTranslate, sourceLang, targetLang);
            
            if (translatedText) {
                const translatedLines = translatedText
                    .split(/\n---\n/)
                    .map(line => line.trim());
                translatedBatches.push(...translatedLines);
            } else {
                translatedBatches.push(...batch.map(sub => sub.text));
            }
            
            if (i < batches.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        parsed.forEach((sub, index) => {
            if (translatedBatches[index]) {
                sub.text = translatedBatches[index];
            }
        });

        const translatedSrt = parser.toSrt(parsed);
        console.log('✅ Traducere completă!');
        return translatedSrt;
    } catch (error) {
        console.error('❌ Eroare procesare subtitrare:', error.message);
        return srtContent;
    }
}

// Middleware pentru verificare API Key
async function verifyApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'] || req.query.apiKey;
    
    if (!apiKey) {
        return res.status(401).json({ error: 'API Key lipsește' });
    }

    try {
        const user = await User.findOne({ apiKey });
        
        if (!user) {
            return res.status(401).json({ error: 'API Key invalid' });
        }

        // Verificare abonament
        if (user.subscriptionStatus === 'expired') {
            return res.status(403).json({ 
                error: 'Abonament expirat',
                message: 'Vă rugăm să reînnoiți abonamentul pentru a continua.'
            });
        }

        // Trial users - verificare limită
        if (user.subscriptionStatus === 'trial') {
            if (user.translationsUsed >= user.freeTranslationsLimit) {
                return res.status(403).json({ 
                    error: 'Limită trial atinsă',
                    message: 'Ați atins limita de traduceri gratuite. Abonați-vă pentru traduceri nelimitate!'
                });
            }
        }

        // Update last active
        user.lastActive = new Date();
        await user.save();

        req.user = user;
        next();
    } catch (error) {
        console.error('Eroare verificare API Key:', error);
        res.status(500).json({ error: 'Eroare server' });
    }
}

// Manifest dinamic per user
function createUserManifest(userId, preferredLang, baseUrl, apiKey) {
    return {
        id: `ro.subtitle.translator.${userId}`,
        version: '2.0.0',
        name: `Subtitrări ${SUPPORTED_LANGUAGES[preferredLang]} AI`,
        description: `Caută și traduce automat subtitrări în ${SUPPORTED_LANGUAGES[preferredLang]} folosind AI. Suportă toate limbile majore.`,
        resources: [
            {
                name: 'subtitles',
                types: ['movie', 'series'],
                idPrefixes: ['tt']
            }
        ],
        types: ['movie', 'series'],
        catalogs: [],
        idPrefixes: ['tt'],
        logo: 'https://i.imgur.com/placeholder.png',
        behaviorHints: {
            configurable: true,
            configurationRequired: false
        },
        // Specifică că resursa de subtitrări este la această adresă
        addon: {
            type: 'subtitles',
            url: `${baseUrl}/manifest/${apiKey}/subtitles`
        }
    };
}

// Express App
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Static files pentru dashboard
app.use(express.static('public'));

// Pagina de configurare pentru Stremio Addon
app.get('/configure', (req, res) => {
    const apiKey = req.query.apiKey || '';
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    
    res.send(`
<!DOCTYPE html>
<html lang="ro">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Configurare Addon - Stremio Subtitles</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            max-width: 500px;
            width: 100%;
            padding: 40px;
        }
        h1 {
            color: #333;
            margin-bottom: 10px;
            font-size: 28px;
        }
        .subtitle {
            color: #666;
            margin-bottom: 30px;
            font-size: 14px;
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            margin-bottom: 8px;
            color: #333;
            font-weight: 600;
        }
        input[type="text"], input[type="email"], select {
            width: 100%;
            padding: 12px;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            font-size: 16px;
            transition: border-color 0.3s;
        }
        input:focus, select:focus {
            outline: none;
            border-color: #667eea;
        }
        .btn {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 14px 28px;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
            width: 100%;
        }
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(102, 126, 234, 0.4);
        }
        .info-box {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 10px;
            margin: 20px 0;
            border-left: 4px solid #667eea;
        }
        .info-box p {
            margin: 5px 0;
            color: #555;
            font-size: 14px;
        }
        .error {
            background: #fee;
            color: #c33;
            padding: 12px;
            border-radius: 8px;
            margin: 10px 0;
            display: none;
        }
        .success {
            background: #efe;
            color: #3c3;
            padding: 12px;
            border-radius: 8px;
            margin: 10px 0;
            display: none;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎬 Configurare Addon Stremio</h1>
        <p class="subtitle">Configurează limba preferată pentru subtitrări</p>
        
        <div id="errorMsg" class="error"></div>
        <div id="successMsg" class="success"></div>
        
        <div id="configForm">
            <div class="form-group">
                <label for="apiKey">API Key:</label>
                <input type="text" id="apiKey" value="${apiKey}" placeholder="Introdu API Key-ul tău">
            </div>
            
            <div class="form-group">
                <label for="language">Limba preferată:</label>
                <select id="language">
                    ${Object.entries(SUPPORTED_LANGUAGES).map(([code, name]) => 
                        `<option value="${code}">${name}</option>`
                    ).join('')}
                </select>
            </div>
            
            <button type="button" class="btn" onclick="loadConfig()">
                📥 Încarcă Configurare
            </button>
            
            <button type="button" class="btn" onclick="saveConfig()" style="margin-top: 10px; background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);">
                💾 Salvează Configurare
            </button>
        </div>
        
        <div id="userInfo" style="display: none;">
            <div class="info-box">
                <p><strong>Status:</strong> <span id="userStatus"></span></p>
                <p><strong>Traduceri folosite:</strong> <span id="translationsCount"></span></p>
                <p><strong>Abonament până:</strong> <span id="subscriptionEnd"></span></p>
                <p><strong>Limba configurată:</strong> <span id="currentLanguage"></span></p>
            </div>
        </div>
    </div>

    <script>
        const SUPPORTED_LANGUAGES = ${JSON.stringify(SUPPORTED_LANGUAGES)};
        
        async function loadConfig() {
            const apiKey = document.getElementById('apiKey').value.trim();
            if (!apiKey) {
                showError('⚠️ Introdu API Key-ul!');
                return;
            }
            
            try {
                const response = await fetch('/api/user/config?apiKey=' + encodeURIComponent(apiKey));
                const data = await response.json();
                
                if (response.ok) {
                    document.getElementById('language').value = data.preferredLanguage || 'ro';
                    document.getElementById('userStatus').textContent = data.subscriptionStatus || 'trial';
                    document.getElementById('translationsCount').textContent = 
                        (data.translationsUsed || 0) + ' / ' + (data.subscriptionStatus === 'trial' ? (data.freeTranslationsLimit || 5) : '∞');
                    document.getElementById('subscriptionEnd').textContent = 
                        data.subscriptionEndDate ? new Date(data.subscriptionEndDate).toLocaleDateString() : 'N/A';
                    document.getElementById('currentLanguage').textContent = 
                        SUPPORTED_LANGUAGES[data.preferredLanguage] || 'Română';
                    
                    document.getElementById('configForm').style.display = 'none';
                    document.getElementById('userInfo').style.display = 'block';
                    showSuccess('✅ Configurare încărcată!');
                } else {
                    showError(data.error || 'Eroare la încărcare configurare');
                }
            } catch (error) {
                showError('Eroare de conexiune');
            }
        }
        
        async function saveConfig() {
            const apiKey = document.getElementById('apiKey').value.trim();
            const language = document.getElementById('language').value;
            
            if (!apiKey) {
                showError('⚠️ Introdu API Key-ul!');
                return;
            }
            
            try {
                const response = await fetch('/api/user/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ apiKey, preferredLanguage: language })
                });
                
                const data = await response.json();
                
                if (response.ok) {
                    showSuccess('✅ Configurare salvată! Limba ta preferată este: ' + SUPPORTED_LANGUAGES[language]);
                    setTimeout(() => {
                        window.close();
                    }, 2000);
                } else {
                    showError(data.error || 'Eroare la salvare');
                }
            } catch (error) {
                showError('Eroare de conexiune');
            }
        }
        
        function showError(msg) {
            const el = document.getElementById('errorMsg');
            el.textContent = msg;
            el.style.display = 'block';
            setTimeout(() => el.style.display = 'none', 5000);
        }
        
        function showSuccess(msg) {
            const el = document.getElementById('successMsg');
            el.textContent = msg;
            el.style.display = 'block';
            setTimeout(() => el.style.display = 'none', 5000);
        }
        
        // Auto-load dacă există API key în URL
        window.addEventListener('DOMContentLoaded', () => {
            const apiKeyInput = document.getElementById('apiKey');
            if (apiKeyInput && apiKeyInput.value) {
                loadConfig();
            }
        });
    </script>
</body>
</html>
    `);
});

// Endpoint pentru obținere configurare user
app.get('/api/user/config', async (req, res) => {
    const apiKey = req.query.apiKey;
    
    if (!apiKey) {
        return res.status(400).json({ error: 'API Key lipsește' });
    }
    
    try {
        const user = await User.findOne({ apiKey });
        if (!user) {
            return res.status(404).json({ error: 'User nu există' });
        }
        
        res.json({
            preferredLanguage: user.preferredLanguage,
            subscriptionStatus: user.subscriptionStatus,
            translationsUsed: user.translationsUsed,
            freeTranslationsLimit: user.freeTranslationsLimit,
            subscriptionEndDate: user.subscriptionEndDate
        });
    } catch (error) {
        console.error('Eroare obținere config:', error);
        res.status(500).json({ error: 'Eroare server' });
    }
});

// Endpoint pentru salvare configurare user
app.post('/api/user/config', async (req, res) => {
    const { apiKey, preferredLanguage } = req.body;
    
    if (!apiKey) {
        return res.status(400).json({ error: 'API Key lipsește' });
    }
    
    if (!preferredLanguage || !SUPPORTED_LANGUAGES[preferredLanguage]) {
        return res.status(400).json({ error: 'Limbă invalidă' });
    }
    
    try {
        const user = await User.findOne({ apiKey });
        if (!user) {
            return res.status(404).json({ error: 'User nu există' });
        }
        
        user.preferredLanguage = preferredLanguage;
        await user.save();
        
        res.json({ success: true, message: 'Configurare salvată' });
    } catch (error) {
        console.error('Eroare salvare config:', error);
        res.status(500).json({ error: 'Eroare server' });
    }
});

// Pagina principală
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="ro">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Stremio Multi-Language Subtitles</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            max-width: 800px;
            width: 100%;
            padding: 40px;
        }
        h1 {
            color: #667eea;
            margin-bottom: 10px;
            font-size: 2.5em;
        }
        .subtitle {
            color: #666;
            margin-bottom: 30px;
            font-size: 1.1em;
        }
        .features {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin: 30px 0;
        }
        .feature {
            padding: 20px;
            background: #f8f9fa;
            border-radius: 10px;
            text-align: center;
        }
        .feature-icon {
            font-size: 2em;
            margin-bottom: 10px;
        }
        .pricing {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            border-radius: 15px;
            text-align: center;
            margin: 30px 0;
        }
        .price {
            font-size: 3em;
            font-weight: bold;
            margin: 20px 0;
        }
        .price small {
            font-size: 0.4em;
            opacity: 0.9;
        }
        .btn {
            background: white;
            color: #667eea;
            padding: 15px 40px;
            border: none;
            border-radius: 50px;
            font-size: 1.1em;
            font-weight: bold;
            cursor: pointer;
            text-decoration: none;
            display: inline-block;
            transition: transform 0.2s;
        }
        .btn:hover {
            transform: scale(1.05);
        }
        .languages {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            margin: 20px 0;
            justify-content: center;
        }
        .lang-badge {
            background: #f0f0f0;
            padding: 8px 15px;
            border-radius: 20px;
            font-size: 0.9em;
        }
        .login-section {
            margin-top: 40px;
            padding-top: 40px;
            border-top: 2px solid #f0f0f0;
        }
        input {
            width: 100%;
            padding: 15px;
            margin: 10px 0;
            border: 2px solid #e0e0e0;
            border-radius: 10px;
            font-size: 1em;
        }
        .form-group {
            margin: 15px 0;
        }
        label {
            display: block;
            margin-bottom: 5px;
            color: #666;
            font-weight: 500;
        }
        select {
            width: 100%;
            padding: 15px;
            border: 2px solid #e0e0e0;
            border-radius: 10px;
            font-size: 1em;
            background: white;
        }
        .success {
            background: #d4edda;
            color: #155724;
            padding: 15px;
            border-radius: 10px;
            margin: 20px 0;
            display: none;
        }
        .error {
            background: #f8d7da;
            color: #721c24;
            padding: 15px;
            border-radius: 10px;
            margin: 20px 0;
            display: none;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎬 Stremio Multi-Language Subtitles</h1>
        <p class="subtitle">Subtitrări automate în orice limbă cu AI</p>

        <div class="features">
            <div class="feature">
                <div class="feature-icon">🌍</div>
                <h3>20+ Limbi</h3>
                <p>Traducere în orice limbă majoră</p>
            </div>
            <div class="feature">
                <div class="feature-icon">🤖</div>
                <h3>AI Gemini</h3>
                <p>Traduceri de calitate</p>
            </div>
            <div class="feature">
                <div class="feature-icon">⚡</div>
                <h3>Rapid</h3>
                <p>Cache inteligent</p>
            </div>
            <div class="feature">
                <div class="feature-icon">💎</div>
                <h3>Ieftin</h3>
                <p>Doar $1 / 3 luni</p>
            </div>
        </div>

        <div class="pricing">
            <h2>Abonament Premium</h2>
            <div class="price">$1<small>/3 luni</small></div>
            <p>✨ Traduceri nelimitate în toate limbile</p>
            <p>🎯 Cache dedicat pentru viteză maximă</p>
            <p>💪 Suport prioritar</p>
        </div>

        <h3 style="text-align: center; margin: 30px 0;">Limbi Suportate:</h3>
        <div class="languages">
            ${Object.values(SUPPORTED_LANGUAGES).map(lang => 
                `<span class="lang-badge">${lang}</span>`
            ).join('')}
        </div>

        <div class="login-section">
            <h2>Înregistrare / Login</h2>
            <div id="successMsg" class="success"></div>
            <div id="errorMsg" class="error"></div>
            
            <form id="registerForm">
                <div class="form-group">
                    <label>Email</label>
                    <input type="email" id="email" required placeholder="email@example.com">
                </div>
                <div class="form-group">
                    <label>Limba Preferată</label>
                    <select id="language">
                        ${Object.entries(SUPPORTED_LANGUAGES).map(([code, name]) => 
                            `<option value="${code}">${name}</option>`
                        ).join('')}
                    </select>
                </div>
                <button type="submit" class="btn" style="width: 100%; margin-top: 20px;">
                    🚀 Începe Trial Gratuit (5 traduceri)
                </button>
            </form>

            <div id="userDashboard" style="display: none; margin-top: 30px;">
                <h3>🎉 Cont Activ!</h3>
                <div style="background: #f8f9fa; padding: 20px; border-radius: 10px; margin: 20px 0;">
                    <p><strong>API Key:</strong></p>
                    <input type="text" id="apiKeyDisplay" readonly style="font-family: monospace;">
                    <p style="margin-top: 15px;"><strong>URL Manifest Stremio:</strong></p>
                    <input type="text" id="manifestUrl" readonly>
                    <div style="display: flex; gap: 10px; margin-top: 10px;">
                        <button onclick="copyManifest()" class="btn" style="flex: 1;">
                            📋 Copiază URL Manifest
                        </button>
                        <button onclick="installInStremio()" class="btn" style="flex: 1; background: #667eea; color: white;">
                            🎬 Install in Stremio
                        </button>
                    </div>
                </div>
                <div style="background: #fff3cd; padding: 15px; border-radius: 10px; margin: 20px 0;">
                    <p><strong>Status:</strong> <span id="userStatus"></span></p>
                    <p><strong>Traduceri folosite:</strong> <span id="translationsCount"></span></p>
                    <p><strong>Abonament până:</strong> <span id="subscriptionEnd"></span></p>
                </div>
                <button onclick="showPayment()" class="btn" id="subscribeBtn">
                    💳 Abonează-te ($1 / 3 luni)
                </button>
            </div>
        </div>
    </div>

    <script>
        document.getElementById('registerForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('email').value;
            const language = document.getElementById('language').value;

            try {
                const response = await fetch('/api/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, preferredLanguage: language })
                });

                const data = await response.json();

                if (response.ok) {
                    showSuccess('✅ Cont creat! API Key generat.');
                    showDashboard(data);
                } else {
                    showError(data.error || 'Eroare la înregistrare');
                }
            } catch (error) {
                showError('Eroare de conexiune');
            }
        });

        function showDashboard(data) {
            document.getElementById('registerForm').style.display = 'none';
            document.getElementById('userDashboard').style.display = 'block';
            document.getElementById('apiKeyDisplay').value = data.apiKey;
            document.getElementById('manifestUrl').value = data.manifestUrl;
            document.getElementById('userStatus').textContent = data.subscriptionStatus;
            document.getElementById('translationsCount').textContent = 
                data.translationsUsed + ' / ' + (data.subscriptionStatus === 'trial' ? data.freeTranslationsLimit : '∞');
            document.getElementById('subscriptionEnd').textContent = 
                data.subscriptionEndDate ? new Date(data.subscriptionEndDate).toLocaleDateString() : 'N/A';
            
            if (data.subscriptionStatus !== 'trial') {
                document.getElementById('subscribeBtn').style.display = 'none';
            }
        }

        function copyManifest() {
            const manifestUrl = document.getElementById('manifestUrl');
            manifestUrl.select();
            document.execCommand('copy');
            showSuccess('✅ URL copiat! Instalează în Stremio.');
        }

        function installInStremio() {
            const manifestUrl = document.getElementById('manifestUrl').value;
            if (!manifestUrl) {
                showError('❌ URL Manifest lipsă!');
                return;
            }

            try {
                // Metoda 1: Protocol handler stremio:// pentru desktop app
                // Format: stremio://manifest-url sau stremio://addon/manifest-url
                const stremioProtocol = 'stremio://' + manifestUrl;
                
                // Încearcă să deschidă protocol handler
                const iframe = document.createElement('iframe');
                iframe.style.display = 'none';
                iframe.style.width = '0';
                iframe.style.height = '0';
                iframe.src = stremioProtocol;
                document.body.appendChild(iframe);
                
                // Șterge iframe după scurt timp
                setTimeout(() => {
                    if (iframe.parentNode) {
                        document.body.removeChild(iframe);
                    }
                }, 1000);
                
                // Metoda 2: Deschide link direct către manifest (pentru web app sau fallback)
                // Stremio web app poate instala direct din link
                setTimeout(() => {
                    window.open(manifestUrl, '_blank', 'noopener,noreferrer');
                }, 300);
                
                showSuccess('🎬 Deschid Stremio... Dacă nu se deschide automat, copiază URL-ul și adaugă manual în Stremio → Settings → Addons.');
                
            } catch (error) {
                // Fallback: copiază și deschide manual
                copyManifest();
                window.open(manifestUrl, '_blank');
                showSuccess('✅ URL copiat și deschis! Dacă Stremio nu se deschide, adaugă manual URL-ul în Settings → Addons.');
            }
        }

        function showSuccess(msg) {
            const el = document.getElementById('successMsg');
            el.textContent = msg;
            el.style.display = 'block';
            setTimeout(() => el.style.display = 'none', 5000);
        }

        function showError(msg) {
            const el = document.getElementById('errorMsg');
            el.textContent = msg;
            el.style.display = 'block';
            setTimeout(() => el.style.display = 'none', 5000);
        }

        async function showPayment() {
            const apiKey = document.getElementById('apiKeyDisplay').value;
            window.location.href = '/checkout?apiKey=' + apiKey;
        }
    </script>
</body>
</html>
    `);
});

// API Endpoints
app.post('/api/register', async (req, res) => {
    try {
        const { email, preferredLanguage } = req.body;

        if (!email || !preferredLanguage) {
            return res.status(400).json({ error: 'Email și limba sunt obligatorii' });
        }

        // Verifică conexiunea MongoDB - așteaptă dacă se conectează
        if (mongoose.connection.readyState === 0) {
            console.log('🔄 MongoDB se conectează... așteaptă 2 secunde');
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        if (mongoose.connection.readyState !== 1) {
            console.error('❌ MongoDB nu este conectat! State:', mongoose.connection.readyState);
            console.error('❌ MONGODB_URI setat:', !!process.env.MONGODB_URI);
            
            // Încearcă să se conecteze din nou
            if (process.env.MONGODB_URI && mongoose.connection.readyState === 0) {
                try {
                    await mongoose.connect(process.env.MONGODB_URI);
                    console.log('✅ MongoDB conectat după retry!');
                } catch (err) {
                    console.error('❌ MongoDB connection failed on retry:', err.message);
                    return res.status(503).json({ error: 'Baza de date nu este disponibilă. Verifică MONGODB_URI în Railway Variables.' });
                }
            } else {
                return res.status(503).json({ error: 'Baza de date nu este disponibilă. Verifică MONGODB_URI în Railway Variables.' });
            }
        }

        // Verifică dacă utilizatorul există
        let user = await User.findOne({ email });

        if (user) {
            // User existent - returnează datele
            return res.json({
                apiKey: user.apiKey,
                manifestUrl: `${process.env.BASE_URL || `https://${req.headers.host || 'localhost:7000'}`}/manifest/${user.apiKey}`,
                subscriptionStatus: user.subscriptionStatus,
                subscriptionEndDate: user.subscriptionEndDate,
                translationsUsed: user.translationsUsed,
                freeTranslationsLimit: user.freeTranslationsLimit,
                preferredLanguage: user.preferredLanguage
            });
        }

        // Creează user nou
        const apiKey = generateApiKey();
        const subscriptionEndDate = new Date();
        subscriptionEndDate.setDate(subscriptionEndDate.getDate() + 7); // 7 zile trial

        user = new User({
            email,
            apiKey,
            preferredLanguage: preferredLanguage || 'ro',
            subscriptionStatus: 'trial',
            subscriptionEndDate,
            freeTranslationsLimit: 5
        });

        await user.save();

        res.json({
            apiKey: user.apiKey,
            manifestUrl: `${process.env.BASE_URL || 'http://localhost:7000'}/manifest/${user.apiKey}`,
            subscriptionStatus: user.subscriptionStatus,
            subscriptionEndDate: user.subscriptionEndDate,
            translationsUsed: user.translationsUsed,
            freeTranslationsLimit: user.freeTranslationsLimit,
            preferredLanguage: user.preferredLanguage
        });

    } catch (error) {
        console.error('❌ Eroare înregistrare:', error.message);
        console.error('Stack:', error.stack);
        
        // Eroare mai detaliată pentru debugging
        if (error.name === 'MongoServerError' || error.name === 'MongoNetworkError') {
            return res.status(503).json({ error: 'Eroare conexiune baza de date. Te rugăm încearcă din nou.' });
        }
        
        if (error.code === 11000) {
            return res.status(409).json({ error: 'Email-ul este deja înregistrat' });
        }
        
        res.status(500).json({ error: 'Eroare server: ' + error.message });
    }
});

// Pagina de configurare pentru un addon specific (Stremio accesează /manifest/:apiKey/configure)
app.get('/manifest/:apiKey/configure', async (req, res) => {
    const { apiKey } = req.params;
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    
    // Obține user-ul și configurația curentă
    let user = null;
    let currentLanguage = 'ro';
    
    try {
        user = await User.findOne({ apiKey });
        if (!user) {
            return res.status(404).send(`
                <html>
                <body style="font-family: Arial; text-align: center; padding: 50px;">
                    <h1>❌ Addon nu există</h1>
                    <p>API Key-ul este invalid.</p>
                </body>
                </html>
            `);
        }
        currentLanguage = user.preferredLanguage || 'ro';
    } catch (error) {
        console.error('Eroare verificare user:', error);
        return res.status(500).send('Eroare server');
    }
    
    // Returnează pagina HTML de configurare DIRECT (Stremio așteaptă HTML, nu redirect)
    res.send(`
<!DOCTYPE html>
<html lang="ro">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Configurare Addon - Stremio Subtitles</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            max-width: 600px;
            width: 100%;
            padding: 40px;
        }
        h1 {
            color: #333;
            margin-bottom: 10px;
            font-size: 28px;
        }
        .subtitle {
            color: #666;
            margin-bottom: 30px;
            font-size: 14px;
        }
        .form-group {
            margin-bottom: 25px;
        }
        label {
            display: block;
            margin-bottom: 8px;
            color: #333;
            font-weight: 600;
            font-size: 16px;
        }
        select {
            width: 100%;
            padding: 15px;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            font-size: 16px;
            background: white;
            cursor: pointer;
            transition: border-color 0.3s;
        }
        select:focus {
            outline: none;
            border-color: #667eea;
        }
        .btn {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 16px 32px;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
            width: 100%;
            margin-top: 10px;
        }
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(102, 126, 234, 0.4);
        }
        .btn:active {
            transform: translateY(0);
        }
        .btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
        .info-box {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 10px;
            margin: 20px 0;
            border-left: 4px solid #667eea;
        }
        .info-box p {
            margin: 8px 0;
            color: #555;
            font-size: 14px;
        }
        .info-box strong {
            color: #333;
        }
        .error {
            background: #fee;
            color: #c33;
            padding: 15px;
            border-radius: 8px;
            margin: 15px 0;
            display: none;
            border-left: 4px solid #c33;
        }
        .success {
            background: #efe;
            color: #3c3;
            padding: 15px;
            border-radius: 8px;
            margin: 15px 0;
            display: none;
            border-left: 4px solid #3c3;
        }
        .instructions {
            background: #e3f2fd;
            padding: 20px;
            border-radius: 10px;
            margin: 20px 0;
            border-left: 4px solid #2196f3;
        }
        .instructions h3 {
            color: #1976d2;
            margin-bottom: 10px;
            font-size: 18px;
        }
        .instructions ol {
            margin-left: 20px;
            color: #555;
        }
        .instructions li {
            margin: 8px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎬 Configurare Addon Stremio</h1>
        <p class="subtitle">Selectează limba preferată pentru traducerea subtitrarilor</p>
        
        <div id="errorMsg" class="error"></div>
        <div id="successMsg" class="success"></div>
        
        <form id="configForm" onsubmit="saveConfig(event); return false;">
            <div class="form-group">
                <label for="language">🌍 Limba preferată pentru subtitrări:</label>
                <select id="language" name="language" required>
                    ${Object.entries(SUPPORTED_LANGUAGES).map(([code, name]) => 
                        `<option value="${code}" ${code === currentLanguage ? 'selected' : ''}>${name}</option>`
                    ).join('')}
                </select>
            </div>
            
            <button type="submit" class="btn">
                💾 Salvează Configurarea
            </button>
        </form>
        
        <div class="info-box" style="margin-top: 30px;">
            <p><strong>📊 Status Cont:</strong></p>
            <p><strong>Status:</strong> <span id="userStatus">${user.subscriptionStatus || 'trial'}</span></p>
            <p><strong>Traduceri folosite:</strong> <span id="translationsCount">${user.translationsUsed || 0} / ${user.subscriptionStatus === 'trial' ? (user.freeTranslationsLimit || 5) : '∞'}</span></p>
            ${user.subscriptionEndDate ? `<p><strong>Abonament până:</strong> ${new Date(user.subscriptionEndDate).toLocaleDateString('ro-RO')}</p>` : ''}
        </div>
        
        <div class="instructions">
            <h3>📖 Cum funcționează:</h3>
            <ol>
                <li>Selectează limba preferată din meniul de mai sus</li>
                <li>Apasă "Salvează Configurarea"</li>
                <li>Addon-ul va căuta automat subtitrări în limba selectată</li>
                <li>Dacă nu găsește subtitrări native, va traduce automat folosind AI</li>
            </ol>
        </div>
    </div>

    <script>
        const SUPPORTED_LANGUAGES = ${JSON.stringify(SUPPORTED_LANGUAGES)};
        const apiKey = '${apiKey}';
        const baseUrl = '${baseUrl}';
        
        async function saveConfig(event) {
            event.preventDefault();
            const language = document.getElementById('language').value;
            
            // Show loading
            const btn = event.target.querySelector('button[type="submit"]');
            const originalText = btn.textContent;
            btn.textContent = '⏳ Se salvează...';
            btn.disabled = true;
            
            try {
                const response = await fetch('/api/user/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ apiKey: apiKey, preferredLanguage: language })
                });
                
                const data = await response.json();
                
                if (response.ok) {
                    showSuccess('✅ Configurare salvată cu succes! Limba ta preferată este acum: ' + SUPPORTED_LANGUAGES[language]);
                    
                    // Reload page after 2 seconds to show updated config
                    setTimeout(() => {
                        window.location.reload();
                    }, 2000);
                } else {
                    showError(data.error || 'Eroare la salvare configurare. Te rugăm încearcă din nou.');
                    btn.textContent = originalText;
                    btn.disabled = false;
                }
            } catch (error) {
                showError('Eroare de conexiune. Te rugăm verifică internetul și încearcă din nou.');
                btn.textContent = originalText;
                btn.disabled = false;
            }
        }
        
        function showError(msg) {
            const el = document.getElementById('errorMsg');
            el.textContent = msg;
            el.style.display = 'block';
            document.getElementById('successMsg').style.display = 'none';
            setTimeout(() => el.style.display = 'none', 5000);
        }
        
        function showSuccess(msg) {
            const el = document.getElementById('successMsg');
            el.textContent = msg;
            el.style.display = 'block';
            document.getElementById('errorMsg').style.display = 'none';
            setTimeout(() => el.style.display = 'none', 8000);
        }
    </script>
</body>
</html>
    `);
});

app.get('/manifest/:apiKey', async (req, res) => {
    try {
        const { apiKey } = req.params;
        const user = await User.findOne({ apiKey });

        if (!user) {
            return res.status(404).json({ error: 'API Key invalid' });
        }

        const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
        const manifest = createUserManifest(user._id, user.preferredLanguage, baseUrl);
        res.json(manifest);
    } catch (error) {
        console.error('Eroare manifest:', error);
        res.status(500).json({ error: 'Eroare server' });
    }
});

// Subtitles handler - Stremio accesează această rută pentru subtitrări
app.get('/manifest/:apiKey/subtitles/:type/:id.json', async (req, res) => {
    try {
        const { apiKey, type, id } = req.params;
        const user = await User.findOne({ apiKey });

        if (!user) {
            return res.status(401).json({ subtitles: [] });
        }

        // Verificare abonament
        if (user.subscriptionStatus === 'expired') {
            return res.json({ subtitles: [] });
        }

        const [imdbId, season, episode] = id.split(':');
        const token = await getOpenSubtitlesToken();

        if (!token) {
            return res.json({ subtitles: [] });
        }

        const subtitles = await searchSubtitles(
            imdbId,
            season ? parseInt(season) : null,
            episode ? parseInt(episode) : null,
            token
        );

        const results = [];
        const targetLang = user.preferredLanguage;

        // Subtitrări în limba preferată (originale)
        const nativeSubs = subtitles.filter(sub => sub.attributes.language === targetLang);

        for (const sub of nativeSubs) {
            const fileId = sub.attributes.files[0].file_id;
            results.push({
                id: `native-${targetLang}-${fileId}`,
                lang: targetLang,
                url: `https://rest.opensubtitles.org/download/${fileId}`,
                label: `${SUPPORTED_LANGUAGES[targetLang]} - ${sub.attributes.release || 'OpenSubtitles'}`
            });
        }

        // Dacă nu există în limba preferată, pregătim traduceri din ORICE limbă disponibilă
        if (nativeSubs.length === 0) {
            // Grupează subtitrări pe limbi și ia cea mai bună din fiecare limbă
            const subsByLang = {};
            
            subtitles
                .filter(sub => sub.attributes.language !== targetLang)
                .forEach(sub => {
                    const lang = sub.attributes.language;
                    if (!subsByLang[lang] || 
                        (sub.attributes.download_count || 0) > (subsByLang[lang].attributes.download_count || 0)) {
                        subsByLang[lang] = sub;
                    }
                });

            // Prioritizează limbile: EN > ES > FR > DE > IT > rest
            const langPriority = ['en', 'es', 'fr', 'de', 'it'];
            const sortedLangs = Object.keys(subsByLang).sort((a, b) => {
                const aPriority = langPriority.indexOf(a);
                const bPriority = langPriority.indexOf(b);
                if (aPriority !== -1 && bPriority !== -1) return aPriority - bPriority;
                if (aPriority !== -1) return -1;
                if (bPriority !== -1) return 1;
                return (subsByLang[b].attributes.download_count || 0) - 
                       (subsByLang[a].attributes.download_count || 0);
            });

            // Oferă opțiuni de traducere din primele 5 limbi disponibile
            for (const lang of sortedLangs.slice(0, 5)) {
                const sub = subsByLang[lang];
                const fileId = sub.attributes.files[0].file_id;
                const sourceLangName = SUPPORTED_LANGUAGES[lang] || lang.toUpperCase();
                const targetLangName = SUPPORTED_LANGUAGES[targetLang] || targetLang.toUpperCase();
                
                results.push({
                    id: `translated-${lang}-${targetLang}-${fileId}`,
                    lang: targetLang,
                    url: `${process.env.BASE_URL || 'http://localhost:7000'}/translate/${apiKey}/${fileId}/${lang}/${targetLang}`,
                    label: `🤖 ${targetLangName} (AI: ${sourceLangName} → ${targetLangName}) - ${sub.attributes.release || 'OpenSubtitles'} ⭐${sub.attributes.download_count || 0}`
                });
            }

            console.log(`🔄 Oferite ${results.length} opțiuni de traducere din: ${sortedLangs.slice(0, 5).join(', ')}`);
        }

        res.json({ subtitles: results });
    } catch (error) {
        console.error('Eroare subtitles handler:', error);
        res.json({ subtitles: [] });
    }
});

// Endpoint traducere
app.get('/translate/:apiKey/:fileId/:sourceLang/:targetLang', async (req, res) => {
    try {
        const { apiKey, fileId, sourceLang, targetLang } = req.params;
        const user = await User.findOne({ apiKey });

        if (!user) {
            return res.status(401).send('API Key invalid');
        }

        // Verificare limită trial
        if (user.subscriptionStatus === 'trial' && user.translationsUsed >= user.freeTranslationsLimit) {
            return res.status(403).send('Limită trial atinsă. Abonează-te pentru traduceri nelimitate!');
        }

        const cacheKey = getCacheKey(fileId, sourceLang, targetLang);

        // Verificare cache MongoDB
        let cached = await TranslationCache.findOne({ cacheKey });
        if (cached) {
            console.log(`✅ Cache HIT: ${cacheKey}`);
            cached.usageCount += 1;
            await cached.save();
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('X-Cache', 'HIT');
            return res.send(cached.translatedContent);
        }

        console.log(`⏳ Traducere nouă: ${sourceLang} -> ${targetLang}`);

        const token = await getOpenSubtitlesToken();
        const originalSrt = await downloadSubtitle(fileId, token);

        if (!originalSrt) {
            return res.status(404).send('Subtitrare negăsită');
        }

        const translatedSrt = await translateSubtitle(originalSrt, sourceLang, targetLang);

        // Salvare în cache
        const newCache = new TranslationCache({
            cacheKey,
            fileId,
            sourceLang,
            targetLang,
            translatedContent: translatedSrt,
            usageCount: 1
        });
        await newCache.save();

        // Incrementare contor utilizator
        user.translationsUsed += 1;
        await user.save();

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('X-Cache', 'MISS');
        res.send(translatedSrt);
    } catch (error) {
        console.error('Eroare traducere:', error);
        res.status(500).send('Eroare la traducere');
    }
});

// Stripe Checkout
app.get('/checkout', async (req, res) => {
    try {
        const { apiKey } = req.query;
        const user = await User.findOne({ apiKey });

        if (!user) {
            return res.status(404).send('User negăsit');
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: 'Stremio Subtitles Premium - 3 Luni',
                        description: 'Traduceri nelimitate în toate limbile'
                    },
                    unit_amount: 100, // $1.00
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${process.env.BASE_URL || 'http://localhost:7000'}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.BASE_URL || 'http://localhost:7000'}`,
            client_reference_id: user._id.toString(),
            customer_email: user.email
        });

        res.redirect(303, session.url);
    } catch (error) {
        console.error('Eroare Stripe:', error);
        res.status(500).send('Eroare la procesare plată');
    }
});

// Success page
app.get('/success', async (req, res) => {
    try {
        const { session_id } = req.query;
        const session = await stripe.checkout.sessions.retrieve(session_id);

        if (session.payment_status === 'paid') {
            const userId = session.client_reference_id;
            const user = await User.findById(userId);

            if (user) {
                user.subscriptionStatus = 'active';
                const newEndDate = new Date();
                newEndDate.setMonth(newEndDate.getMonth() + 3); // 3 luni
                user.subscriptionEndDate = newEndDate;
                user.stripeCustomerId = session.customer;
                await user.save();

                return res.send(`
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="UTF-8">
                        <title>Plată Reușită!</title>
                        <style>
                            body { font-family: Arial; text-align: center; padding: 50px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; }
                            .success-box { background: white; color: #333; padding: 40px; border-radius: 20px; max-width: 500px; margin: 0 auto; }
                            h1 { color: #4CAF50; }
                            .btn { background: #667eea; color: white; padding: 15px 30px; text-decoration: none; border-radius: 50px; display: inline-block; margin-top: 20px; }
                        </style>
                    </head>
                    <body>
                        <div class="success-box">
                            <h1>🎉 Plată Reușită!</h1>
                            <p>Abonamentul tău este acum activ pentru următoarele 3 luni!</p>
                            <p>Bucură-te de traduceri nelimitate în toate limbile.</p>
                            <a href="/" class="btn">Înapoi la Dashboard</a>
                        </div>
                    </body>
                    </html>
                `);
            }
        }

        res.redirect('/');
    } catch (error) {
        console.error('Eroare success page:', error);
        res.redirect('/');
    }
});

// Stats endpoint
app.get('/api/stats', async (req, res) => {
    try {
        const totalUsers = await User.countDocuments();
        const activeSubscriptions = await User.countDocuments({ subscriptionStatus: 'active' });
        const totalTranslations = await TranslationCache.countDocuments();
        
        res.json({
            totalUsers,
            activeSubscriptions,
            totalTranslations,
            cacheSize: totalTranslations
        });
    } catch (error) {
        res.status(500).json({ error: 'Eroare server' });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
    });
});

// Error handling pentru server - TREBUIE ÎNAINTE DE app.listen
process.on('unhandledRejection', (err) => {
    console.error('❌ Unhandled Rejection:', err.message);
    if (err.stack) console.error('Stack:', err.stack);
});

process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err.message);
    if (err.stack) console.error('Stack:', err.stack);
});

// Pornire server
const PORT = process.env.PORT || 7000;

console.log('🚀 Starting server...');
console.log('📋 PORT:', PORT);
console.log('🔧 Env vars:', {
    hasGemini: !!process.env.GEMINI_API_KEY,
    hasOpenSubtitles: !!process.env.OPENSUBTITLES_API_KEY,
    hasStripe: !!process.env.STRIPE_SECRET_KEY,
    hasMongoDB: !!process.env.MONGODB_URI
});

try {
    app.listen(PORT, '0.0.0.0', () => {
    console.log('\n' + '='.repeat(70));
    console.log('🎬 STREMIO MULTI-LANGUAGE SUBTITLES - PRODUCTION');
    console.log('='.repeat(70));
    console.log(`🌐 Server:              http://0.0.0.0:${PORT}`);
    console.log(`📝 Dashboard:           http://0.0.0.0:${PORT}/`);
    console.log(`💳 Subscription:        $${SUBSCRIPTION_PRICE} / 3 luni`);
    console.log(`🌍 Limbi suportate:     ${Object.keys(SUPPORTED_LANGUAGES).length}`);
    console.log('='.repeat(70));
    console.log(`🔑 Gemini:              ${GEMINI_API_KEY ? '✅' : '❌'}`);
    console.log(`🔑 OpenSubtitles:       ${OPENSUBTITLES_API_KEY ? '✅' : '❌'}`);
    console.log(`🔑 Stripe:              ${process.env.STRIPE_SECRET_KEY ? '✅' : '❌'}`);
    console.log(`💾 MongoDB:             ${mongoose.connection.readyState === 1 ? '✅ Connected' : '⏳ Connecting...'}`);
    console.log('='.repeat(70) + '\n');
    console.log('✅ Server started successfully!');
    }).on('error', (err) => {
        console.error('❌ Server error:', err.message);
        if (err.code === 'EADDRINUSE') {
            console.error('❌ Port', PORT, 'is already in use!');
        }
        process.exit(1);
    });
} catch (error) {
    console.error('❌ Failed to start server:', error.message);
    if (error.stack) console.error('Stack:', error.stack);
    process.exit(1);
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n👋 Oprire gracioasă...');
    await mongoose.connection.close();
    process.exit(0);
});
