const express = require('express');
const vanillaPuppeteer = require('puppeteer');
const { addExtra } = require('puppeteer-extra');
const puppeteer = addExtra(vanillaPuppeteer);
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cors = require('cors');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const stealth = StealthPlugin();
stealth.enabledEvasions.delete('sourceurl');
puppeteer.use(stealth);

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const backupsDir = path.join(__dirname, 'backups');
if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });

const usersFile = path.join(__dirname, 'users.json');
if (!fs.existsSync(usersFile)) fs.writeFileSync(usersFile, JSON.stringify({}));

let browser;
let cachedBcvRate = 0.0;
let isFetchingBcv = false;

async function initBrowser() {
    if (browser) { try { await browser.close(); } catch (e) {} }
    console.log("⏳ [SISTEMA] Iniciando motor Puppeteer (Modo Ultra Bajo Consumo)...");
    browser = await puppeteer.launch({
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
        ignoreHTTPSErrors: true,
        args: [
            '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
            '--no-zygote', '--single-process', '--disable-background-networking',
            '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
            '--disable-breakpad', '--disable-component-update', '--disable-default-apps',
            '--disable-extensions', '--disable-features=AudioServiceOutOfProcess',
            '--disable-hang-monitor', '--disable-ipc-flooding-protection', '--disable-notifications',
            '--disable-print-preview', '--disable-prompt-on-repost', '--disable-renderer-backgrounding',
            '--disable-sync', '--mute-audio', '--no-default-browser-check', '--no-first-run'
        ]
    });
    console.log("✅ [SISTEMA] Puppeteer listo.");
}

async function ensureBrowser() {
    if (!browser || !browser.isConnected()) await initBrowser();
}

// --- BCV ---
async function fetchBcvRateFromWeb() {
    if (isFetchingBcv) return cachedBcvRate;
    isFetchingBcv = true;
    await ensureBrowser();
    let bcvPage;
    try {
        bcvPage = await browser.newPage();
        await bcvPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36');
        await bcvPage.setRequestInterception(true);
        bcvPage.on('request', (req) => { if (['image', 'font', 'media', 'stylesheet'].includes(req.resourceType())) req.abort(); else req.continue(); });
        await bcvPage.goto('https://www.bcv.org.ve/', { waitUntil: 'domcontentloaded', timeout: 35000 });
        const exactSelector = '#dolar .field-content .row.recuadrotsmc .centrado.textp strong.strong-tb';
        await bcvPage.waitForSelector(exactSelector, { timeout: 15000 }).catch(() => {});
        const rawText = await bcvPage.evaluate((sel) => { const el = document.querySelector(sel); return el ? el.innerText : null; }, exactSelector);
        if (rawText) {
            let cleanText = rawText.replace(/[^0-9,.]/g, '').replace(/\./g, '').replace(',', '.');
            const parsedRate = parseFloat(cleanText);
            if (!isNaN(parsedRate) && parsedRate > 0) { cachedBcvRate = parsedRate; }
        }
    } catch (error) { console.log(`❌ Error BCV:`, error.message); }
    finally { if (bcvPage && !bcvPage.isClosed()) await bcvPage.close(); isFetchingBcv = false; }
    return cachedBcvRate;
}

function startBcvAutoRefresh() {
    fetchBcvRateFromWeb();
    cron.schedule('0 17 * * *', () => fetchBcvRateFromWeb(), { scheduled: true, timezone: "America/Caracas" });
    cron.schedule('0 7 * * *', () => fetchBcvRateFromWeb(), { scheduled: true, timezone: "America/Caracas" });
}

app.get('/api/bcv', async (req, res) => {
    if (cachedBcvRate === 0.0) await fetchBcvRateFromWeb();
    res.json({ code: "000000", tasa: cachedBcvRate });
});

// --- BINANCE ---
app.get('/api/merchant/:userNo', async (req, res) => {
    await ensureBrowser();
    let page;
    try {
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0');
        await page.setRequestInterception(true);
        page.on('request', (req) => { if (['image', 'font', 'media', 'stylesheet'].includes(req.resourceType())) req.abort(); else req.continue(); });
        await page.goto(`https://c2c.binance.com/es-LA/advertiserDetail?advertiserNo=${req.params.userNo}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const statsData = await page.evaluate(async (uid) => {
            try {
                const url = `https://c2c.binance.com/bapi/c2c/v2/friendly/c2c/user/profile-and-ads-list?userNo=${uid}`;
                const response = await fetch(url, { method: 'GET', headers: { "content-type": "application/json", "clienttype": "web", "lang": "es-LA" } });
                return await response.json();
            } catch(e) { return { error: "Fallo: " + e.message }; }
        }, req.params.userNo);
        if (statsData && statsData.code === "000000") res.json(statsData); else res.status(500).json({ error: "Fallo" });
    } catch (error) { res.status(500).json({ error: "Error interno" }); }
    finally { if (page && !page.isClosed()) await page.close(); }
});

app.post('/api/comments', async (req, res) => {
    await ensureBrowser();
    const { userNo, page = 1 } = req.body;
    let tempPage;
    try {
        tempPage = await browser.newPage();
        await tempPage.setBypassCSP(true);
        await tempPage.setUserAgent('Mozilla/5.0');
        await tempPage.goto(`https://c2c.binance.com/es-LA/advertiserDetail?advertiserNo=${userNo}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const reviewsData = await tempPage.evaluate(async (uid, pageNum) => {
            const match = document.cookie.match(new RegExp('(^| )csrftoken=([^;]+)'));
            const csrf = match ? match[2] : '';
            const url = "https://c2c.binance.com/bapi/c2c/v1/friendly/c2c/review/list-by-page";
            const headers = { "content-type": "application/json", "clienttype": "web", "lang": "es-LA", "csrftoken": csrf };
            try {
                const resPos = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify({ page: pageNum, rows: 20, reviewRole: 1, quickCommentTagId: null, sort: "desc", userNo: uid, rating: 1 }) });
                const jsonPos = await resPos.json();
                const resNeg = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify({ page: pageNum, rows: 20, reviewRole: 1, quickCommentTagId: null, sort: "desc", userNo: uid, rating: 3 }) });
                const jsonNeg = await resNeg.json();
                return { pos: jsonPos, neg: jsonNeg };
            } catch (e) { return { error: e.toString() }; }
        }, userNo, page);

        let totalPos = 0, totalNeg = 0;
        if (reviewsData.pos && reviewsData.pos.countsPerRating) { totalPos = reviewsData.pos.countsPerRating["1"] || 0; totalNeg = reviewsData.pos.countsPerRating["3"] || reviewsData.pos.countsPerRating["2"] || 0; }
        const posList = (reviewsData.pos && reviewsData.pos.data) ? reviewsData.pos.data : [];
        const negList = (reviewsData.neg && reviewsData.neg.data) ? reviewsData.neg.data : [];
        let combinedReviews = [];
        const procesarComentarios = (array, tipo) => { return array.map(item => { let name = "Usuario anónimo"; if (item.reviewer && item.reviewer.nickname) name = item.reviewer.nickname; else if (item.nickname) name = item.nickname; let pMethod = item.reviewer && item.reviewer.paymethod ? item.reviewer.paymethod : ""; let content = item.comments || item.content || ""; if (content === "null") content = ""; let tag = item.reviewTagList && item.reviewTagList.length > 0 ? item.reviewTagList[0] : ""; return { ratingType: tipo, nickName: name, content: content.trim(), createTime: item.createTime || Date.now(), payMethod: pMethod, tag: tag }; }); };
        if (posList.length > 0) combinedReviews = combinedReviews.concat(procesarComentarios(posList, "POSITIVE"));
        if (negList.length > 0) combinedReviews = combinedReviews.concat(procesarComentarios(negList, "NEGATIVE"));
        res.json({ code: "000000", data: { data: combinedReviews, totalPositivos: totalPos, totalNegativos: totalNeg } });
    } catch (error) { res.status(500).json({ error: "Error" }); }
    finally { if (tempPage && !tempPage.isClosed()) await tempPage.close(); }
});

// --- RESPALDOS ---
app.post('/api/backup/:userId', (req, res) => {
    try {
        fs.writeFileSync(path.join(backupsDir, `${req.params.userId}.json`), JSON.stringify(req.body, null, 2));
        res.json({ code: "000000", message: "Respaldo subido correctamente" });
    } catch (error) { res.status(500).json({ error: "Error" }); }
});

app.get('/api/backup/:userId', (req, res) => {
    try {
        const filePath = path.join(backupsDir, `${req.params.userId}.json`);
        if (fs.existsSync(filePath)) res.json(JSON.parse(fs.readFileSync(filePath, 'utf8')));
        else res.json({});
    } catch (error) { res.status(500).json({ error: "Error" }); }
});

// --- USUARIOS Y ROLES ---
app.post('/api/users/sync', (req, res) => {
    const { email, name } = req.body;
    let users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));

    if (!users[email]) {
        const defaultRole = email === 'zonacami77777@gmail.com' ? 'ADMIN' : 'INVITADO';
        users[email] = { name: name, role: defaultRole, registeredAt: Date.now(), consumedSeconds: 0, isBanned: false };
    } else {
        users[email].name = name;
        if (email === 'zonacami77777@gmail.com') users[email].role = 'ADMIN';
        if (users[email].consumedSeconds === undefined) users[email].consumedSeconds = 0;
        if (users[email].isBanned === undefined) users[email].isBanned = false;
    }

    fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
    res.json({ role: users[email].role, isBanned: users[email].isBanned, consumedSeconds: users[email].consumedSeconds });
});

app.post('/api/users/time', (req, res) => {
    const { email, seconds } = req.body;
    let users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
    if (users[email]) {
        users[email].consumedSeconds += seconds;

        // Si no es ADMIN y superó el límite (1 mes en segundos)
        if (users[email].role !== 'ADMIN' && users[email].consumedSeconds >= 2592000) {
            if (users[email].role !== 'INVITADO') {
                users[email].role = 'INVITADO'; // Se degrada a invitado
                users[email].consumedSeconds = 0; // Reinicia su tiempo de prueba como invitado
            }
        }

        fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
    }
    res.json({ code: "000000" });
});

app.get('/api/users', (req, res) => {
    res.json(JSON.parse(fs.readFileSync(usersFile, 'utf8')));
});

app.post('/api/users/manage', (req, res) => {
    const { email, action, role } = req.body;
    let users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
    if (users[email]) {
        if (action === 'setRole' && role) {
            users[email].role = role;
            users[email].consumedSeconds = 0; // Al cambiar el rol como admin, se resetea su tiempo para empezar de 0
        }
        if (action === 'resetTime') users[email].consumedSeconds = 0;
        if (action === 'ban') users[email].isBanned = true;
        if (action === 'unban') users[email].isBanned = false;
        fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
        res.json({ code: "000000", message: "Éxito" });
    } else {
        res.status(404).json({ error: "No encontrado" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
    await initBrowser();
    startBcvAutoRefresh();
});