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
if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
}

// NUEVO: Archivo para guardar la base de datos de usuarios y sus roles
const usersFile = path.join(__dirname, 'users.json');
if (!fs.existsSync(usersFile)) {
    fs.writeFileSync(usersFile, JSON.stringify({}));
}

let browser;
let cachedBcvRate = 0.0;
let isFetchingBcv = false;

async function initBrowser() {
    if (browser) {
        try { await browser.close(); } catch (e) {}
    }
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
    console.log("✅ [SISTEMA] Puppeteer listo y optimizado para 1GB RAM.");
}

async function ensureBrowser() {
    if (!browser || !browser.isConnected()) {
        console.log("⚠️ [SISTEMA] Navegador desconectado. Reiniciando...");
        await initBrowser();
    }
}

// --- FUNCIÓN BCV ---
async function fetchBcvRateFromWeb() {
    if (isFetchingBcv) return cachedBcvRate;
    isFetchingBcv = true;
    await ensureBrowser();

    let bcvPage;
    try {
        bcvPage = await browser.newPage();
        await bcvPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36');
        await bcvPage.setRequestInterception(true);
        bcvPage.on('request', (req) => {
            if (['image', 'font', 'media', 'stylesheet'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        await bcvPage.goto('https://www.bcv.org.ve/', { waitUntil: 'domcontentloaded', timeout: 35000 });
        const exactSelector = '#dolar .field-content .row.recuadrotsmc .centrado.textp strong.strong-tb';
        await bcvPage.waitForSelector(exactSelector, { timeout: 15000 }).catch(() => {});

        const rawText = await bcvPage.evaluate((sel) => {
            const el = document.querySelector(sel);
            return el ? el.innerText : null;
        }, exactSelector);

        if (rawText) {
            let cleanText = rawText.replace(/[^0-9,.]/g, '').replace(/\./g, '').replace(',', '.');
            const parsedRate = parseFloat(cleanText);
            if (!isNaN(parsedRate) && parsedRate > 0) {
                cachedBcvRate = parsedRate;
                console.log(`🟢 [BCV SCRAPER] Tasa BCV Oficial actualizada: ${cachedBcvRate}`);
            }
        }
    } catch (error) {
        console.log(`❌ Error BCV:`, error.message);
    } finally {
        if (bcvPage && !bcvPage.isClosed()) await bcvPage.close();
        isFetchingBcv = false;
    }
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

// --- ENDPOINTS BINANCE (Mantenidos igual) ---
app.get('/api/merchant/:userNo', async (req, res) => { /*...Mantenido por longitud...*/ });
app.post('/api/comments', async (req, res) => { /*...Mantenido por longitud...*/ });

// --- ENDPOINTS DE RESPALDOS ---
app.post('/api/backup/:userId', (req, res) => {
    const userId = req.params.userId;
    const backupData = req.body;
    try {
        const filePath = path.join(backupsDir, `${userId}.json`);
        fs.writeFileSync(filePath, JSON.stringify(backupData, null, 2));
        console.log(`☁️ [NUBE] Respaldo guardado con éxito para el usuario: ${userId}`);
        res.json({ code: "000000", message: "Respaldo subido correctamente" });
    } catch (error) {
        res.status(500).json({ error: "Error interno al guardar" });
    }
});

app.get('/api/backup/:userId', (req, res) => {
    const userId = req.params.userId;
    try {
        const filePath = path.join(backupsDir, `${userId}.json`);
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            console.log(`☁️ [NUBE] Respaldo enviado al dispositivo del usuario: ${userId}`);
            res.json(JSON.parse(data));
        } else {
            console.log(`⚠️ [NUBE] No se encontró respaldo para: ${userId}`);
            res.json({});
        }
    } catch (error) {
        res.status(500).json({ error: "Error interno al leer" });
    }
});


// ==========================================
// NUEVO: GESTIÓN DE USUARIOS Y ROLES (ADMIN PANEL)
// ==========================================

// Sincronizar y obtener rol al iniciar sesión
app.post('/api/users/sync', (req, res) => {
    const { email, name } = req.body;
    let users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));

    if (!users[email]) {
        // Tu correo maestro se asigna como ADMIN automáticamente, los demás BÁSICO.
        const defaultRole = email === 'zonacami77777@gmail.com' ? 'ADMIN' : 'BÁSICO';
        users[email] = { name: name, role: defaultRole, registeredAt: Date.now() };
    } else {
        users[email].name = name; // Actualiza el nombre por si cambió en Google
        if (email === 'zonacami77777@gmail.com') users[email].role = 'ADMIN'; // Forzar super-permiso
    }

    fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
    res.json({ role: users[email].role });
});

// Obtener toda la lista de usuarios (Solo para panel de Administrador)
app.get('/api/users', (req, res) => {
    const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
    res.json(users);
});

// Cambiar el rol de un usuario manualmente
app.post('/api/users/role', (req, res) => {
    const { email, newRole } = req.body;
    let users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
    if (users[email]) {
        users[email].role = newRole;
        fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
        res.json({ code: "000000", message: "Rol actualizado con éxito" });
    } else {
        res.status(404).json({ error: "Usuario no encontrado" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
    await initBrowser();
    startBcvAutoRefresh();
});