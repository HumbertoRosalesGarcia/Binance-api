const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cors = require('cors');

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
        ignoreHTTPSErrors: true, // EVITA BLOQUEOS POR CERTIFICADO SSL DEL BCV
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',           
            '--no-zygote',
            '--single-process',
            '--ignore-certificate-errors', // OBLIGATORIO PARA CUMPIR CON EL BCV
            '--ignore-certificate-errors-spki-list'
        ]
    }); 
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    console.log("⏳ Abriendo Binance para inicializar motores...");
    await page.goto('https://p2p.binance.com/es-LA', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    console.log("✅ Navegador listo. Esperando a la App...");
}

// Endpoint 1: Estadísticas (Binance P2P)
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
        console.log(`❌ Error al extraer estadísticas:`, error);
        res.status(500).json({ error: "Error interno" });
    }
});

// Endpoint 2: Comentarios (Binance P2P)
app.post('/api/comments', async (req, res) => {
    const { userNo, page = 1 } = req.body;
    console.log(`📥 [APP] Pidiendo comentarios para: ${userNo} | Pág: ${page}`);
    
    let tempPage;
    try {
        tempPage = await browser.newPage();
        await tempPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
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

// Endpoint 3: BCV Scraper Directo (EXCLUSIVAMENTE DESDE BCV.ORG.VE CON PUPPETEER)
app.get('/api/bcv', async (req, res) => {
    console.log(`\n📥 [APP] Solicitando tasa oficial directamente de bcv.org.ve...`);
    let bcvPage;
    try {
        bcvPage = await browser.newPage();
        await bcvPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Desactivamos recursos pesados para agilizar la carga
        await bcvPage.setRequestInterception(true);
        bcvPage.on('request', (request) => {
            if (['image', 'font', 'media'].includes(request.resourceType())) {
                request.abort();
            } else {
                request.continue();
            }
        });

        await bcvPage.goto('https://www.bcv.org.ve/', { waitUntil: 'domcontentloaded', timeout: 35000 });

        const bcvRate = await bcvPage.evaluate(() => {
            const dolarDiv = document.getElementById('dolar');
            if (dolarDiv) {
                const strongTag = dolarDiv.querySelector('strong');
                if (strongTag) {
                    const text = strongTag.innerText.trim().replace(',', '.');
                    return parseFloat(text);
                }
            }
            return null;
        });

        await bcvPage.close();

        if (bcvRate && bcvRate > 0) {
            console.log(`🟢 [BCV OFICIAL] Tasa obtenida de bcv.org.ve: ${bcvRate}`);
            return res.json({ code: "000000", tasa: bcvRate });
        } else {
            console.log(`❌ No se encontró el selector del dólar en el HTML.`);
            return res.status(500).json({ error: "No se encontró el elemento en la web del BCV" });
        }

    } catch (error) {
        if (bcvPage && !bcvPage.isClosed()) await bcvPage.close();
        console.log(`❌ Error en Puppeteer al consultar BCV:`, error.message);
        res.status(500).json({ error: `Error en servidor: ${error.message}` });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
    await initBrowser();
});
