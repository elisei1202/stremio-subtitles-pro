# 🚀 GHID DEPLOYMENT - Pași de urmat

## ✅ CE AI DEJA:
- ✅ `.env` cu API keys configurate
- ✅ `server.js` - codul aplicației
- ✅ `package.json` - dependențe
- ✅ `Procfile` - pentru Heroku
- ✅ `.gitignore` - protejează .env

---

## 📋 PAȘII PENTRU DEPLOY

### **OPȚIUNEA 1: HEROKU** (Recomandat - cel mai simplu)

#### Pasul 1: Instalează Heroku CLI
```bash
# Linux
curl https://cli-assets.heroku.com/install.sh | sh

# SAU folosește npm
npm install -g heroku-cli
```

#### Pasul 2: Login Heroku
```bash
heroku login
```

#### Pasul 3: Creează aplicație Heroku
```bash
cd /home/elisei/Downloads/stremio-subtitles-complete/stremio-subtitle-translator/stremio-subtitles-pro
heroku create nume-aplicatie-stremio-subtitles
```

#### Pasul 4: Setează variabilele de environment în Heroku
```bash
# Citește valorile din .env și setează-le în Heroku
heroku config:set GEMINI_API_KEY="$(grep GEMINI_API_KEY .env | cut -d'=' -f2)"
heroku config:set OPENSUBTITLES_API_KEY="$(grep OPENSUBTITLES_API_KEY .env | cut -d'=' -f2)"
heroku config:set STRIPE_SECRET_KEY="$(grep STRIPE_SECRET_KEY .env | cut -d'=' -f2)"
heroku config:set MONGODB_URI="$(grep MONGODB_URI .env | cut -d'=' -f2)"
heroku config:set BASE_URL="https://nume-aplicatie-stremio-subtitles.herokuapp.com"
```

#### Pasul 5: Initializează Git (dacă nu ai deja)
```bash
git init
git add .
git commit -m "Initial commit - Stremio Subtitles PRO"
```

#### Pasul 6: Deploy pe Heroku
```bash
heroku git:remote -a nume-aplicatie-stremio-subtitles
git push heroku master
```

#### Pasul 7: Verifică aplicația
```bash
heroku open
# SAU deschide manual în browser: https://nume-aplicatie-stremio-subtitles.herokuapp.com
```

#### Pasul 8: Verifică logs
```bash
heroku logs --tail
```

---

### **OPȚIUNEA 2: RAILWAY.APP** (Gratuit, fără card)

#### Pasul 1: Creează cont Railway
- Mergi pe: https://railway.app
- Login cu GitHub

#### Pasul 2: Push codul pe GitHub
```bash
cd /home/elisei/Downloads/stremio-subtitles-complete/stremio-subtitle-translator/stremio-subtitles-pro
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/TU-USERNAME/TU-REPO.git
git push -u origin main
```

#### Pasul 3: Deploy pe Railway
- În Railway Dashboard: "New Project" → "Deploy from GitHub repo"
- Selectează repository-ul tău
- Railway va detecta automat Node.js

#### Pasul 4: Setează Environment Variables în Railway
În Railway Dashboard → Project → Variables, adaugă:
- `GEMINI_API_KEY`
- `OPENSUBTITLES_API_KEY`
- `STRIPE_SECRET_KEY`
- `MONGODB_URI`
- `BASE_URL` (Railway îți va da un URL automat)
- `PORT` = 7000 (sau lasă Railway să aleagă automat)

#### Pasul 5: Deploy
- Railway va face deploy automat la fiecare push pe GitHub
- Vei primi un URL de tipul: `https://your-app.railway.app`

---

### **OPȚIUNEA 3: TEST LOCAL** (Recomandat înainte de deploy)

#### Pasul 1: Instalează dependențele
```bash
cd /home/elisei/Downloads/stremio-subtitles-complete/stremio-subtitle-translator/stremio-subtitles-pro
npm install
```

#### Pasul 2: Pornește MongoDB local (SAU folosește Atlas)
```bash
# Dacă folosești MongoDB local:
mongod

# Dacă folosești MongoDB Atlas, verifică că .env are MONGODB_URI corect
```

#### Pasul 3: Pornește serverul
```bash
npm start
```

#### Pasul 4: Testează
- Deschide: http://localhost:7000
- Ar trebui să vezi dashboard-ul
- Încearcă să te înregistrezi cu un email

---

## 🔍 VERIFICARE FINALĂ

După deploy, verifică:
1. ✅ Dashboard-ul se deschide (BASE_URL/)
2. ✅ Poți crea cont nou
3. ✅ Primești API Key și Manifest URL
4. ✅ MongoDB se conectează (verifică logs)
5. ✅ API Keys funcționează

---

## ⚠️ IMPORTANT

1. **NU comiti niciodată `.env` pe Git!** (e deja în .gitignore)
2. **BASE_URL** trebuie actualizat după deploy la URL-ul real
3. **Stripe**: Folosește `sk_test_` pentru test, `sk_live_` pentru production
4. **MongoDB Atlas**: Whitelist IP-ul Heroku/Railway în Network Access

---

## 🐛 TROUBLESHOOTING

### Eroare: "MongoDB connection failed"
- Verifică MONGODB_URI în .env
- Whitelist IP-ul în MongoDB Atlas → Network Access

### Eroare: "Invalid API Key"
- Verifică că ai copiat corect din .env în platformă
- Verifică că nu ai spații extra

### Aplicația nu pornește
- Verifică logs: `heroku logs --tail`
- Verifică că PORT este setat corect
- Verifică că Procfile există (pentru Heroku)

---

## 📞 NEXT STEPS

După deploy:
1. Testează înregistrarea unui user
2. Instalează addon-ul în Stremio cu Manifest URL
3. Testează o traducere
4. Configurează Stripe pentru plăți reale (dacă e production)

**Mult succes! 🚀**

