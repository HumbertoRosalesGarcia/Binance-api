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

const usersFile = path.join(backupsDir, 'users.json');
if (!fs.existsSync(usersFile)) fs.writeFileSync(usersFile, JSON.stringify({}));

const chatFile = path.join(backupsDir, 'chat.json');
if (!fs.existsSync(chatFile)) fs.writeFileSync(chatFile, JSON.stringify({}));

function safeReadUsers() { try { return JSON.parse(fs.readFileSync(usersFile, 'utf8')); } catch (e) { return {}; } }
function safeWriteUsers(users) { try { fs.writeFileSync(usersFile, JSON.stringify(users, null, 2)); } catch (e) { console.error("Error guardando usuarios"); } }
function safeReadChat() { try { return JSON.parse(fs.readFileSync(chatFile, 'utf8')); } catch (e) { return {}; } }
function safeWriteChat(chats) { try { fs.writeFileSync(chatFile, JSON.stringify(chats, null, 2)); } catch (e) { console.error("Error guardando chat"); } }

const ADMIN_EMAIL = 'zonacami77777@gmail.com';

let browser;
let cachedBcvRate = 0.0;
let isFetchingBcv = false;

async function initBrowser() {
    if (browser) { try { await browser.close(); } catch (e) {} }
    console.log("⏳ [SISTEMA] Iniciando motor Puppeteer...");
    browser = await puppeteer.launch({
        headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null, ignoreHTTPSErrors: true,
        args: [ '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--single-process', '--disable-background-networking', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-breakpad', '--disable-component-update', '--disable-default-apps', '--disable-extensions', '--disable-features=AudioServiceOutOfProcess', '--disable-hang-monitor', '--disable-ipc-flooding-protection', '--disable-notifications', '--disable-print-preview', '--disable-prompt-on-repost', '--disable-renderer-backgrounding', '--disable-sync', '--mute-audio', '--no-default-browser-check', '--no-first-run' ]
    });
    console.log("✅ [SISTEMA] Puppeteer listo.");
}

async function ensureBrowser() { if (!browser || !browser.isConnected()) await initBrowser(); }

app.get('/api/bcv', async (req, res) => {
    if (cachedBcvRate === 0.0) {
        isFetchingBcv = true; await ensureBrowser(); let bcvPage;
        try {
            bcvPage = await browser.newPage(); await bcvPage.setUserAgent('Mozilla/5.0'); await bcvPage.setRequestInterception(true);
            bcvPage.on('request', (req) => { if (['image', 'font', 'media', 'stylesheet'].includes(req.resourceType())) req.abort(); else req.continue(); });
            await bcvPage.goto('https://www.bcv.org.ve/', { waitUntil: 'domcontentloaded', timeout: 35000 });
            const rawText = await bcvPage.evaluate(() => { const el = document.querySelector('#dolar .field-content .row.recuadrotsmc .centrado.textp strong.strong-tb'); return el ? el.innerText : null; });
            if (rawText) { const parsedRate = parseFloat(rawText.replace(/[^0-9,.]/g, '').replace(/\./g, '').replace(',', '.')); if (!isNaN(parsedRate) && parsedRate > 0) cachedBcvRate = parsedRate; }
        } catch (error) {} finally { if (bcvPage && !bcvPage.isClosed()) await bcvPage.close(); isFetchingBcv = false; }
    }
    res.json({ code: "000000", tasa: cachedBcvRate });
});

cron.schedule('0 17 * * *', () => { cachedBcvRate = 0.0; });
cron.schedule('0 7 * * *', () => { cachedBcvRate = 0.0; });

app.get('/api/merchant/:userNo', async (req, res) => {
    await ensureBrowser(); let page;
    try {
        page = await browser.newPage(); await page.setUserAgent('Mozilla/5.0'); await page.setRequestInterception(true);
        page.on('request', (req) => { if (['image', 'font', 'media', 'stylesheet'].includes(req.resourceType())) req.abort(); else req.continue(); });
        await page.goto(`https://c2c.binance.com/es-LA/advertiserDetail?advertiserNo=${req.params.userNo}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const statsData = await page.evaluate(async (uid) => { try { const response = await fetch(`https://c2c.binance.com/bapi/c2c/v2/friendly/c2c/user/profile-and-ads-list?userNo=${uid}`, { method: 'GET', headers: { "content-type": "application/json", "clienttype": "web", "lang": "es-LA" } }); return await response.json(); } catch(e) { return { error: "Fallo" }; } }, req.params.userNo);
        if (statsData && statsData.code === "000000") res.json(statsData); else res.status(500).json({ error: "Fallo" });
    } catch (error) { res.status(500).json({ error: "Error interno" }); } finally { if (page && !page.isClosed()) await page.close(); }
});

app.post('/api/comments', async (req, res) => {
    await ensureBrowser(); const { userNo, page = 1 } = req.body; let tempPage;
    try {
        tempPage = await browser.newPage(); await tempPage.setBypassCSP(true); await tempPage.setUserAgent('Mozilla/5.0');
        await tempPage.goto(`https://c2c.binance.com/es-LA/advertiserDetail?advertiserNo=${userNo}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const rData = await tempPage.evaluate(async (uid, pageNum) => {
            const m = document.cookie.match(new RegExp('(^| )csrftoken=([^;]+)')); const csrf = m ? m[2] : ''; const url = "https://c2c.binance.com/bapi/c2c/v1/friendly/c2c/review/list-by-page"; const h = { "content-type": "application/json", "clienttype": "web", "lang": "es-LA", "csrftoken": csrf };
            try { const rP = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify({ page: pageNum, rows: 20, reviewRole: 1, quickCommentTagId: null, sort: "desc", userNo: uid, rating: 1 }) }); const jP = await rP.json(); const rN = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify({ page: pageNum, rows: 20, reviewRole: 1, quickCommentTagId: null, sort: "desc", userNo: uid, rating: 3 }) }); const jN = await rN.json(); return { pos: jP, neg: jN }; } catch (e) { return { error: e.toString() }; }
        }, userNo, page);
        let tPos = 0, tNeg = 0; if (rData.pos && rData.pos.countsPerRating) { tPos = rData.pos.countsPerRating["1"] || 0; tNeg = rData.pos.countsPerRating["3"] || rData.pos.countsPerRating["2"] || 0; }
        let cRev = []; const proc = (arr, type) => { return arr.map(i => { let n = "Usuario anónimo"; if (i.reviewer && i.reviewer.nickname) n = i.reviewer.nickname; else if (i.nickname) n = i.nickname; let c = i.comments || i.content || ""; return { ratingType: type, nickName: n, content: c.trim(), createTime: i.createTime || Date.now(), payMethod: i.reviewer?.paymethod ?: "", tag: i.reviewTagList?.length > 0 ? i.reviewTagList[0] : "" }; }); };
        if (rData.pos?.data?.length > 0) cRev = cRev.concat(proc(rData.pos.data, "POSITIVE")); if (rData.neg?.data?.length > 0) cRev = cRev.concat(proc(rData.neg.data, "NEGATIVE"));
        res.json({ code: "000000", data: { data: cRev, totalPositivos: tPos, totalNegativos: tNeg } });
    } catch (error) { res.status(500).json({ error: "Error" }); } finally { if (tempPage && !tempPage.isClosed()) await tempPage.close(); }
});

app.post('/api/backup/:userId', (req, res) => { try { fs.writeFileSync(path.join(backupsDir, `${req.params.userId}.json`), JSON.stringify(req.body, null, 2)); res.json({ code: "000000", message: "Respaldo subido" }); } catch (error) { res.status(500).json({ error: "Error" }); } });
app.get('/api/backup/:userId', (req, res) => { try { const fp = path.join(backupsDir, `${req.params.userId}.json`); if (fs.existsSync(fp)) res.json(JSON.parse(fs.readFileSync(fp, 'utf8'))); else res.json({}); } catch (error) { res.status(500).json({ error: "Error" }); } });

app.get('/api/chat/:userEmail', (req, res) => { const chats = safeReadChat(); res.json(chats[req.params.userEmail] || []); });
app.get('/api/admin/chats', (req, res) => { res.json(safeReadChat()); });
app.post('/api/chat', (req, res) => {
    const { sender, receiver, text } = req.body; const chats = safeReadChat();
    const chatKey = (sender.toLowerCase() === ADMIN_EMAIL) ? receiver : sender;
    if (!chats[chatKey]) chats[chatKey] = [];
    chats[chatKey].push({ sender, text, timestamp: Date.now() });
    safeWriteChat(chats); res.json({ code: "000000", message: "Enviado" });
});
app.delete('/api/chat/:userEmail', (req, res) => {
    const chats = safeReadChat();
    if (chats[req.params.userEmail]) { delete chats[req.params.userEmail]; safeWriteChat(chats); }
    res.json({ code: "000000", message: "Chat borrado" });
});

app.post('/api/users/sync', (req, res) => {
    const { email, name } = req.body; let users = safeReadUsers();
    const isSuperAdmin = email.toLowerCase() === ADMIN_EMAIL;
    if (!users[email]) {
        users[email] = { name: name, role: isSuperAdmin ? 'ADMIN' : 'INVITADO', registeredAt: Date.now(), consumedSeconds: 0, isBanned: false, planDuration: 2592000 };
    } else {
        users[email].name = name;
        if (isSuperAdmin) users[email].role = 'ADMIN';
        if (users[email].consumedSeconds === undefined) users[email].consumedSeconds = 0;
        if (users[email].isBanned === undefined) users[email].isBanned = false;
        if (users[email].planDuration === undefined) users[email].planDuration = 2592000;
    }

    if (!isSuperAdmin && users[email].consumedSeconds >= users[email].planDuration) {
        if (users[email].role !== 'INVITADO') {
            users[email].role = 'INVITADO'; users[email].consumedSeconds = 0; users[email].planDuration = 2592000;
        } else { users[email].isBanned = true; }
    }
    safeWriteUsers(users);
    res.json({ role: users[email].role, isBanned: users[email].isBanned, consumedSeconds: users[email].consumedSeconds, planDuration: users[email].planDuration });
});

// NUEVO: Responder con el estado completo en tiempo real
app.post('/api/users/time', (req, res) => {
    const { email, seconds } = req.body; let users = safeReadUsers();
    const isSuperAdmin = email.toLowerCase() === ADMIN_EMAIL;

    let finalRole = "INVITADO"; let finalConsumed = 0; let finalDuration = 2592000; let finalBanned = false;

    if (users[email]) {
        if (!isSuperAdmin) {
            users[email].consumedSeconds += seconds;
            let maxTime = users[email].planDuration || 2592000;
            if (users[email].consumedSeconds >= maxTime) {
                if (users[email].role !== 'INVITADO') {
                    users[email].role = 'INVITADO'; users[email].consumedSeconds = 0; users[email].planDuration = 2592000;
                } else { users[email].isBanned = true; }
            }
        }
        finalRole = users[email].role; finalConsumed = users[email].consumedSeconds; finalDuration = users[email].planDuration; finalBanned = users[email].isBanned;
        safeWriteUsers(users);
    }
    res.json({ code: "000000", role: finalRole, consumedSeconds: finalConsumed, planDuration: finalDuration, isBanned: finalBanned });
});

app.get('/api/users', (req, res) => { res.json(safeReadUsers()); });

app.post('/api/users/manage', (req, res) => {
    const { email, action, role, planDuration } = req.body; let users = safeReadUsers();
    if (users[email]) {
        const isSuperAdmin = email.toLowerCase() === ADMIN_EMAIL;
        if (action === 'setRole' && role) { users[email].role = role; users[email].consumedSeconds = 0; users[email].planDuration = planDuration || 2592000; users[email].isBanned = false; }
        if (action === 'resetTime') { users[email].consumedSeconds = 0; users[email].isBanned = false; }
        if (action === 'ban' && !isSuperAdmin) users[email].isBanned = true;
        if (action === 'unban') { users[email].isBanned = false; users[email].consumedSeconds = 0; }
        safeWriteUsers(users); res.json({ code: "000000", message: "Éxito" });
    } else { res.status(404).json({ error: "No encontrado" }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', async () => { console.log(`🚀 Servidor corriendo en el puerto ${PORT}`); await initBrowser(); });