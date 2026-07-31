const express = require('express');
const vanillaPuppeteer = require('puppeteer'); 
const { addExtra } = require('puppeteer-extra');
const puppeteer = addExtra(vanillaPuppeteer);  
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cors = require('cors');
const cron = require('node-cron'); 

const stealth = StealthPlugin();
stealth.enabledEvasions.delete('sourceurl');
puppeteer.use(stealth);

const app = express();
app.use(cors());
app.use(express.json());

let browser;
let cachedBcvRate = 0.0;
let isFetchingBcv = false;

async function initBrowser() {
    if (browser) {
        try { await browser.close(); } catch (e) {}
    }
    console.log("⏳ [SISTEMA] Iniciando motor Puppeteer en la Nube (Render)...");
    browser = await puppeteer.launch({
        headless: true,
        ignoreHTTPSErrors: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--single-process',
            '--ignore-certificate-errors',
            '--window-size=1280,800'
        ]
    });
    console.log("✅ [SISTEMA] Puppeteer listo para operar en la nube.");
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
        await bcvPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        await bcvPage.setRequestInterception(true);
        bcvPage.on('request', (req) => {
            if (['image', 'font', 'media', 'stylesheet'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        // Aumentado a 60 segundos por la lentitud de los servidores gratuitos
        await bcvPage.goto('https://www.bcv.org.ve/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        const exactSelector = '#dolar .field-content .row.recuadrotsmc .centrado.textp strong.strong-tb';
        await bcvPage.waitForSelector(exactSelector, { timeout: 20000 }).catch(() => {});

        const rawText = await bcvPage.evaluate((sel) => {
            const el = document.querySelector(sel);
            return el ? el.innerText : null;
        }, exactSelector);

        await bcvPage.close();

        if (rawText) {
            let cleanText = rawText.replace(/[^0-9,.]/g, '').replace(/\./g, '').replace(',', '.');
            const parsedRate = parseFloat(cleanText);
            if (!isNaN(parsedRate) && parsedRate > 0) {
                cachedBcvRate = parsedRate;
                console.log(`🟢 [BCV SCRAPER] Tasa BCV Oficial actualizada: ${cachedBcvRate}`);
            }
        }
    } catch (error) {
        console.log(`❌ [BCV SCRAPER] Error:`, error.message);
        if (bcvPage && !bcvPage.isClosed()) await bcvPage.close();
    }
    isFetchingBcv = false;
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

// --- ENDPOINT 1: ESTADÍSTICAS ---
app.get('/api/merchant/:userNo', async (req, res) => {
    await ensureBrowser();
    const userNo = req.params.userNo;
    console.log(`\n🚀 [NUEVO] Petición API Stats recibida para: ${userNo}`);

    let page;
    try {
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'media', 'stylesheet'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        console.log(`⏳ [STATS] Navegando a Binance...`);
        // Aumentado a 60 segundos
        await page.goto(`https://c2c.binance.com/es-LA/advertiserDetail?advertiserNo=${userNo}`, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        console.log(`✅ [STATS] Página cargada, extrayendo Fetch interno...`);

        const statsData = await page.evaluate(async (uid) => {
            try {
                const url = `https://c2c.binance.com/bapi/c2c/v2/friendly/c2c/user/profile-and-ads-list?userNo=${uid}`;
                const response = await fetch(url, {
                    method: 'GET',
                    headers: {
                        "content-type": "application/json",
                        "clienttype": "web",
                        "lang": "es-LA"
                    }
                });
                const json = await response.json();
                return json;
            } catch(e) {
                return { error: "Fallo leyendo memoria: " + e.message };
            }
        }, userNo);

        await page.close();

        if (statsData && statsData.code === "000000") {
            console.log(`🟢 [STATS] Éxito. Entregando datos a la App.`);
            res.json(statsData);
        } else {
            console.log(`⚠️ [STATS] Fallo en la API interna de Binance. Respuesta:`, JSON.stringify(statsData).substring(0, 100));
            res.status(500).json({ error: "Bloqueo o fallo de Binance", details: statsData });
        }

    } catch (error) {
        if (page && !page.isClosed()) await page.close();
        console.log(`❌ [STATS] Error fatal:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

// --- ENDPOINT 2: COMENTARIOS ---
app.post('/api/comments', async (req, res) => {
    await ensureBrowser();
    const { userNo, page = 1 } = req.body;
    console.log(`\n🚀 [NUEVO] Petición Comentarios recibida. User: ${userNo} | Página: ${page}`);

    let tempPage;
    try {
        tempPage = await browser.newPage();
        await tempPage.setBypassCSP(true);
        await tempPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        console.log(`⏳ [COMENTARIOS] Navegando a Binance...`);
        // Aumentado a 60 segundos
        await tempPage.goto(`https://c2c.binance.com/es-LA/advertiserDetail?advertiserNo=${userNo}`, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        console.log(`✅ [COMENTARIOS] Página cargada, extrayendo token y fetch...`);

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
                return { pos: jsonPos, neg: jsonNeg, cookieFound: !!csrf };
            } catch (e) { return { error: e.toString() }; }
        }, userNo, page);

        await tempPage.close();

        if (reviewsData.error) {
            console.log(`⚠️ [COMENTARIOS] Error en el script del navegador:`, reviewsData.error);
            return res.status(500).json({ error: "Fallo leyendo comentarios" });
        }

        if (!reviewsData.cookieFound) {
            console.log(`⚠️ [COMENTARIOS] ADVERTENCIA: No se pudo extraer el CSRF Token. Es probable que Cloudflare esté bloqueando.`);
        }

        let totalPos = 0, totalNeg = 0;
        if (reviewsData.pos && reviewsData.pos.countsPerRating) {
            totalPos = reviewsData.pos.countsPerRating["1"] || 0;
            totalNeg = reviewsData.pos.countsPerRating["3"] || reviewsData.pos.countsPerRating["2"] || 0;
        }

        const posList = (reviewsData.pos && reviewsData.pos.data) ? reviewsData.pos.data : [];
        const negList = (reviewsData.neg && reviewsData.neg.data) ? reviewsData.neg.data : [];
        let combinedReviews = [];

        const procesarComentarios = (array, tipo) => {
            return array.map(item => {
                let name = "Usuario anónimo";
                if (item.reviewer && item.reviewer.nickname) name = item.reviewer.nickname;
                else if (item.nickname) name = item.nickname;
                let pMethod = item.reviewer && item.reviewer.paymethod ? item.reviewer.paymethod : "";
                let content = item.comments || item.content || "";
                if (content === "null") content = "";
                let tag = item.reviewTagList && item.reviewTagList.length > 0 ? item.reviewTagList[0] : "";
                return { ratingType: tipo, nickName: name, content: content.trim(), createTime: item.createTime || Date.now(), payMethod: pMethod, tag: tag };
            });
        };

        if (posList.length > 0) combinedReviews = combinedReviews.concat(procesarComentarios(posList, "POSITIVE"));
        if (negList.length > 0) combinedReviews = combinedReviews.concat(procesarComentarios(negList, "NEGATIVE"));

        console.log(`🟢 [COMENTARIOS] Éxito. ${combinedReviews.length} comentarios enviados a la App.`);
        res.json({ code: "000000", data: { data: combinedReviews, totalPositivos: totalPos, totalNegativos: totalNeg } });
    } catch (error) {
        if (tempPage && !tempPage.isClosed()) await tempPage.close();
        console.log(`❌ [COMENTARIOS] Error fatal:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Servidor corriendo en el puerto ${PORT} en la nube (Render)`);
    await initBrowser();
    startBcvAutoRefresh();
});