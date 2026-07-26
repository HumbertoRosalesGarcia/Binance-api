const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cors = require('cors');

// 1. Configuramos el plugin Stealth y eliminamos la evasión que causa el Crash en Railway
const stealth = StealthPlugin();
stealth.enabledEvasions.delete('sourceurl');
puppeteer.use(stealth);

const app = express();
app.use(cors());
app.use(express.json());

let browser;
let page; 

async function initBrowser() {
    browser = await puppeteer.launch({ 
        headless: true, 
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',           
            '--no-zygote',
            '--single-process'         
        ]
    }); 
    page = await browser.newPage();
    console.log("⏳ Abriendo Binance para inicializar motores...");
    
    await page.goto('https://p2p.binance.com/es-LA', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    console.log("✅ Navegador listo. Esperando a la App...");
}

// Endpoint 1: Estadísticas 
app.get('/api/merchant/:userNo', async (req, res) => {
    const userNo = req.params.userNo;
    console.log(`\n📥 [APP] Pidiendo estadísticas para: ${userNo}`);
    try {
        const data = await page.evaluate(async (uid) => {
            const response = await fetch(`https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/user/profile-and-ads-list?userNo=${uid}`, {
                method: 'GET',
                headers: { 'clienttype': 'web', 'lang': 'es-LA' }
            });
            return response.json();
        }, userNo);
        console.log(`🟢 [APP] Estadísticas enviadas.`);
        res.json(data);
    } catch (error) {
        console.log(`❌ Error:`, error);
        res.status(500).json({ error: "Error interno" });
    }
});

// Endpoint 2: Comentarios 
app.post('/api/comments', async (req, res) => {
    const { userNo, page = 1 } = req.body;
    console.log(`📥 [APP] Pidiendo comentarios para: ${userNo} | Pág: ${page}`);
    
    let tempPage;
    try {
        tempPage = await browser.newPage();
        await tempPage.goto(`https://p2p.binance.com/es-LA/advertiserDetail?advertiserNo=${userNo}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
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
        
        console.log(`🟢 [APP] Pág ${page} enviada.`);
        res.json({ code: "000000", data: { data: combinedReviews, totalPositivos: totalPos, totalNegativos: totalNeg } });

    } catch (error) {
        if (tempPage && !tempPage.isClosed()) await tempPage.close();
        res.status(500).json({ error: "Error interno" });
    }
});

// Endpoint 3: BCV Scraper (Múltiples métodos para 100% de fiabilidad)
app.get('/api/bcv', async (req, res) => {
    console.log(`\n📥 [APP] Solicitando tasa BCV...`);
    
    // Método 1: API Directa Rápida
    try {
        const apiRes = await fetch("https://ve.dolarapi.com/v1/dolares/oficial");
        if (apiRes.ok) {
            const apiData = await apiRes.json();
            if (apiData && apiData.promedio) {
                console.log(`🟢 [APP] BCV (Vía API): ${apiData.promedio}`);
                return res.json({ code: "000000", tasa: apiData.promedio });
            }
        }
    } catch (e) { console.log(`⚠️ API Dolar no respondió...`); }

    // Método 2: Segunda API
    try {
        const pyRes = await fetch("https://pydolarvenezuela-api.vercel.app/api/v1/dollar?page=bcv");
        if (pyRes.ok) {
            const pyData = await pyRes.json();
            if (pyData && pyData.monitors && pyData.monitors.usd) {
                console.log(`🟢 [APP] BCV (Vía API 2): ${pyData.monitors.usd.price}`);
                return res.json({ code: "000000", tasa: pyData.monitors.usd.price });
            }
        }
    } catch (e) { console.log(`⚠️ API 2 falló, activando robot Puppeteer...`); }

    // Método 3: Robot Extractor (Respaldo final)
    let bcvPage;
    try {
        bcvPage = await browser.newPage();
        await bcvPage.setRequestInterception(true);
        bcvPage.on('request', (request) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(request.resourceType())) request.abort();
            else request.continue();
        });
        await bcvPage.goto('https://www.bcv.org.ve/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        const bcvRate = await bcvPage.evaluate(() => {
            const el = document.querySelector('#dolar strong');
            return el ? parseFloat(el.innerText.trim().replace(',', '.')) : null;
        });
        await bcvPage.close();

        if (bcvRate) {
            console.log(`🟢 [APP] BCV (Vía Web Scraper): ${bcvRate}`);
            return res.json({ code: "000000", tasa: bcvRate });
        } else {
            throw new Error("No se halló el precio en la web");
        }
    } catch (error) {
        if (bcvPage && !bcvPage.isClosed()) await bcvPage.close();
        console.log(`❌ Error al extraer BCV`);
        res.status(500).json({ error: "No se pudo obtener la tasa" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
    await initBrowser();
});
