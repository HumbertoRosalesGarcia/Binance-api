const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cors = require('cors');

puppeteer.use(StealthPlugin());
const app = express();
app.use(cors());
app.use(express.json());

let browser;
let page; 

async function initBrowser() {
    browser = await puppeteer.launch({ 
        headless: true, 
        args: ['--no-sandbox', '--disable-setuid-sandbox']
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
    console.log(`\n📥 [APP ANDROID] Pidiendo estadísticas para: ${userNo}`);
    try {
        const data = await page.evaluate(async (uid) => {
            const response = await fetch(`https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/user/profile-and-ads-list?userNo=${uid}`, {
                method: 'GET',
                headers: { 'clienttype': 'web', 'lang': 'es-LA' }
            });
            return response.json();
        }, userNo);
        
        console.log(`🟢 [APP ANDROID] Estadísticas enviadas correctamente.`);
        res.json(data);
    } catch (error) {
        console.log(`❌ Error al extraer estadísticas:`, error);
        res.status(500).json({ error: "Error interno" });
    }
});

// Endpoint 2: Comentarios (Nombres Reales, Etiquetas y Totales Globales)
app.post('/api/comments', async (req, res) => {
    const { userNo, page = 1 } = req.body;
    console.log(`📥 [APP ANDROID] Pidiendo comentarios para: ${userNo} | Página solicitada: ${page}`);
    
    let tempPage;
    try {
        tempPage = await browser.newPage();
        await tempPage.goto(`https://p2p.binance.com/es-LA/advertiserDetail?advertiserNo=${userNo}`, { 
            waitUntil: 'domcontentloaded', 
            timeout: 30000 
        });
        
        const reviewsData = await tempPage.evaluate(async (uid, pageNum) => {
            const match = document.cookie.match(new RegExp('(^| )csrftoken=([^;]+)'));
            const csrf = match ? match[2] : '';
            
            const url = "https://c2c.binance.com/bapi/c2c/v1/friendly/c2c/review/list-by-page";
            const headers = { 
                "content-type": "application/json", 
                "clienttype": "web", 
                "lang": "es-LA", 
                "csrftoken": csrf 
            };

            try {
                // Petición de Comentarios Positivos (rating: 1)
                const resPos = await fetch(url, { 
                    method: 'POST', 
                    headers: headers, 
                    body: JSON.stringify({ page: pageNum, rows: 20, reviewRole: 1, quickCommentTagId: null, sort: "desc", userNo: uid, rating: 1 }) 
                });
                const jsonPos = await resPos.json();

                // Petición de Comentarios Negativos (rating: 3, como dicta el JSON)
                const resNeg = await fetch(url, { 
                    method: 'POST', 
                    headers: headers, 
                    body: JSON.stringify({ page: pageNum, rows: 20, reviewRole: 1, quickCommentTagId: null, sort: "desc", userNo: uid, rating: 3 }) 
                });
                const jsonNeg = await resNeg.json();

                return { pos: jsonPos, neg: jsonNeg };
            } catch (e) {
                return { error: e.toString() };
            }
        }, userNo, page);

        await tempPage.close();

        // Extraer los totales exactos desde "countsPerRating"
        let totalPos = 0;
        let totalNeg = 0;
        
        if (reviewsData.pos && reviewsData.pos.countsPerRating) {
            totalPos = reviewsData.pos.countsPerRating["1"] || 0;
            totalNeg = reviewsData.pos.countsPerRating["3"] || reviewsData.pos.countsPerRating["2"] || 0;
        }

        const posList = (reviewsData.pos && reviewsData.pos.data) ? reviewsData.pos.data : [];
        const negList = (reviewsData.neg && reviewsData.neg.data) ? reviewsData.neg.data : [];

        let combinedReviews = [];

        const procesarComentarios = (array, tipo) => {
            return array.map(item => {
                // Mapeo exacto basado en tu JSON
                let name = "Usuario anónimo";
                if (item.reviewer && item.reviewer.nickname) name = item.reviewer.nickname;
                else if (item.nickname) name = item.nickname;

                let pMethod = "";
                if (item.reviewer && item.reviewer.paymethod) pMethod = item.reviewer.paymethod;

                let content = item.comments || item.content || "";
                if (content === "null") content = "";

                // Extraer el primer Tag si existe en reviewTagList
                let tag = "";
                if (item.reviewTagList && item.reviewTagList.length > 0) {
                    tag = item.reviewTagList[0];
                }

                return {
                    ratingType: tipo,
                    nickName: name,
                    content: content.trim(),
                    createTime: item.createTime || Date.now(),
                    payMethod: pMethod,
                    tag: tag
                };
            });
        };

        if (posList.length > 0) combinedReviews = combinedReviews.concat(procesarComentarios(posList, "POSITIVE"));
        if (negList.length > 0) combinedReviews = combinedReviews.concat(procesarComentarios(negList, "NEGATIVE"));

        console.log(`🟢 [APP ANDROID] ¡Página ${page} procesada (Positivos: ${totalPos}, Negativos: ${totalNeg})!`);

        res.json({ 
            code: "000000", 
            data: { 
                data: combinedReviews,
                totalPositivos: totalPos,
                totalNegativos: totalNeg
            } 
        });

    } catch (error) {
        if (tempPage && !tempPage.isClosed()) await tempPage.close();
        console.log(`❌ Error crítico al extraer comentarios:`, error);
        res.status(500).json({ error: "Error interno" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
    await initBrowser();
});