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

// Inicialización de Puppeteer
async function initBrowser() {
    if (browser) {
        try { await browser.close(); } catch (e) {}
    }
    console.log("⏳ [SISTEMA] Iniciando motor Puppeteer...");
    browser = await puppeteer.launch({ 
        headless: true, 
        ignoreHTTPSErrors: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium', 
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',           
            '--no-zygote',
            '--single-process',
            '--ignore-certificate-errors'
        ]
    }); 
    console.log("✅ [SISTEMA] Puppeteer listo para operar.");
}

async function ensureBrowser() {
    if (!browser || !browser.isConnected()) {
        console.log("⚠️ [SISTEMA] Navegador desconectado. Reiniciando...");
        await initBrowser();
    }
}

// --- FUNCIÓN DE SCRAPING BCV ---
async function fetchBcvRateFromWeb() {
    if (isFetchingBcv) return cachedBcvRate;
    isFetchingBcv = true;

    await ensureBrowser();
    console.log("\n========================================");
    console.log("🌐 [BCV SCRAPER] Conectando a https://www.bcv.org.ve/ ...");
    
    let bcvPage;
    try {
        bcvPage = await browser.newPage();
        await bcvPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36');
        
        await bcvPage.setRequestInterception(true);
        bcvPage.on('request', (req) => {
            if (['image', 'font', 'media', 'stylesheet'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await bcvPage.goto('https://www.bcv.org.ve/', { waitUntil: 'domcontentloaded', timeout: 35000 });
        
        const exactSelector = '#dolar .field-content .row.recuadrotsmc .centrado.textp strong.strong-tb';
        
        await bcvPage.waitForSelector(exactSelector, { timeout: 15000 }).catch(() => {});

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
        if (bcvPage && !bcvPage.isClosed()) await bcvPage.close();
        console.log(`❌ [BCV SCRAPER] Error en la conexión/scraping: ${error.message}`);
    }

    console.log("========================================\n");
    isFetchingBcv = false;
    return cachedBcvRate;
}

// --- PROGRAMACIÓN DE ACTUALIZACIÓN ---
function startBcvAutoRefresh() {
    fetchBcvRateFromWeb();
    cron.schedule('0 17 * * *', () => fetchBcvRateFromWeb(), { scheduled: true, timezone: "America/Caracas" });
    cron.schedule('0 7 * * *', () => fetchBcvRateFromWeb(), { scheduled: true, timezone: "America/Caracas" });
}

// --- ENDPOINT BCV ---
app.get('/api/bcv', async (req, res) => {
    if (cachedBcvRate === 0.0) await fetchBcvRateFromWeb();
    res.json({ code: "000000", tasa: cachedBcvRate });
});

// Endpoint 1: Estadísticas Binance P2P (NUEVO MÉTODO INVULNERABLE: IFRAME FETCH + SSR)
app.get('/api/merchant/:userNo', async (req, res) => {
    await ensureBrowser();
    const userNo = req.params.userNo;
    console.log(`\n📥 [APP ANDROID] Pidiendo estadísticas para: ${userNo}`);
    
    let page;
    try {
        page = await browser.newPage();
        await page.setBypassCSP(true);
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36');
        
        console.log("⚙️ [SISTEMA] Abriendo perfil web oficial para extraer datos...");
        await page.goto(`https://c2c.binance.com/es-LA/advertiserDetail?advertiserNo=${userNo}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        const statsData = await page.evaluate(async (uid) => {
            const match = document.cookie.match(new RegExp('(^| )csrftoken=([^;]+)'));
            const csrf = match ? match[2] : '';
            const url = `https://c2c.binance.com/bapi/c2c/v2/friendly/c2c/user/profile-and-ads-list?userNo=${uid}`;
            
            // INTENTO 1: Fetch Nativo mediante Iframe (Esquiva el JavaScript alterado de Binance)
            try {
                const iframe = document.createElement('iframe');
                iframe.style.display = 'none';
                document.body.appendChild(iframe);
                
                const cleanFetch = iframe.contentWindow.fetch;
                const response = await cleanFetch(url, { 
                    method: 'GET', 
                    headers: { 
                        "content-type": "application/json", 
                        "clienttype": "web", 
                        "lang": "es-LA", 
                        "csrftoken": csrf 
                    } 
                });
                
                const json = await response.json();
                document.body.removeChild(iframe);
                
                if (json && json.code === "000000") return json;
            } catch (e) {
                console.log("Iframe fetch falló, pasando a Plan B...");
            }

            // INTENTO 2 (PLAN B): Extraer datos del estado interno de la página (SSR)
            try {
                const appDataNode = document.getElementById('__APP_DATA');
                if (appDataNode) {
                    const parsed = JSON.parse(appDataNode.textContent);
                    let foundData = null;
                    
                    // Escáner recursivo: Buscamos dentro de todo el código de la página el perfil exacto
                    const searchObj = (obj) => {
                        if (!obj || typeof obj !== 'object') return;
                        // Si el objeto tiene el número de usuario y la cuenta de órdenes, ¡es el correcto!
                        if (obj.userNo === uid && obj.monthOrderCount !== undefined) {
                            foundData = obj;
                            return;
                        }
                        Object.values(obj).forEach(searchObj);
                    };
                    
                    searchObj(parsed);
                    
                    if (foundData) {
                        return { code: "000000", data: foundData, success: true };
                    }
                }
            } catch(e) {}
            
            return { error: "No se pudieron obtener las estadísticas." };
        }, userNo);

        await page.close();
        
        if (statsData && statsData.code === "000000") {
            console.log(`🟢 [APP ANDROID] ¡Estadísticas capturadas y enviadas con éxito!`);
            res.json(statsData);
        } else {
            console.log(`⚠️ [APP ANDROID] Fallo al capturar datos:`, statsData);
            res.status(500).json({ error: "Error interno al leer datos" });
        }

    } catch (error) {
        if (page && !page.isClosed()) await page.close();
        console.log(`❌ Error Binance Merchant:`, error.message);
        res.status(500).json({ error: "Error interno" });
    }
});

// Endpoint 2: Comentarios Binance P2P (¡INTACTO, FUNCIONA PERFECTO!)
app.post('/api/comments', async (req, res) => {
    await ensureBrowser();
    const { userNo, page = 1 } = req.body;
    console.log(`📥 [APP ANDROID] Pidiendo comentarios para: ${userNo} | Pág: ${page}`);
    
    let tempPage;
    try {
        tempPage = await browser.newPage();
        await tempPage.setBypassCSP(true); 
        await tempPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36');
        
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

        await tempPage.close();

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
        
        console.log(`🟢 [APP ANDROID] Comentarios procesados y enviados.`);
        res.json({ code: "000000", data: { data: combinedReviews, totalPositivos: totalPos, totalNegativos: totalNeg } });
    } catch (error) {
        if (tempPage && !tempPage.isClosed()) await tempPage.close();
        console.log(`❌ Error Binance Comments:`, error.message);
        res.status(500).json({ error: "Error interno" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
    await initBrowser();
    startBcvAutoRefresh();
});