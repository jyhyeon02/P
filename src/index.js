const express = require('express');
const mariadb = require('mariadb');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { spawn } = require('child_process');
const path = require('path');
const schedule = require('node-schedule');
const { findSimilarTitles, getSimilarTitles } = require('./test');


const app = express();
app.use(cors());
app.use(express.json());

// MariaDB 연결 설정
const db = mariadb.createPool({
    host: 'localhost',
    user: 'dbid233',
    password: 'dbpass233',
    database: 'db24327',
    port: 3306,
    connectionLimit: 20,
});

// Python 스크립트 절대 경로 설정
const pythonScriptPath = "/home/t24327/svr/AI/model_predict.py";
const headlineScriptPath = "/home/t24327/svr/src/headline.py";

// 데이터베이스에서 예측 결과 조회
async function getPredictionFromDB(url) {
    let conn;
    try {
        conn = await db.getConnection();
        const result = await conn.query(
            `SELECT p.real_news_probability, p.fake_news_probability, sa.title 
             FROM predictions p 
             JOIN scraped_articles sa ON p.article_id = sa.id 
             WHERE sa.url = ?`,
            [url]
        );

        if (result.length > 0) {
            console.log('Debug: Found existing prediction in DB');
            return result[0]; // 예측 결과 반환
        }
        return null; // 결과가 없으면 null 반환
    } finally {
        if (conn) conn.release();
    }
}

// Python 스크립트 실행 함수
function runPythonScript(url) {
    return new Promise((resolve, reject) => {
        const python = spawn('python', [pythonScriptPath, url]);

        python.stdout.on('data', (data) => {
            console.log(`Python Output: ${data}`);
        });

        python.stderr.on('data', (data) => {
            console.error(`Python 에러: ${data}`);
        });

        python.on('close', (code) => {
            if (code !== 0) {
                return reject(new Error('Python script execution failed.'));
            }
            resolve(); // Python 스크립트 성공적으로 종료
        });
    });
}

// 기사 크롤링 함수
async function scrapeArticle(url) {
    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0',
            },
        });

        const $ = cheerio.load(response.data);
        const title = $('#title_area').text().trim();
        const content = $('#dic_area').text().trim().replace(/\n|\t/g, '').trim();

        return { url, title, content };
    } catch (error) {
        console.error('Scraping error:', error);
        throw error;
    }
}

// 크롤링 데이터 저장 함수
async function saveScrapedArticle(url, title, content) {
    let conn;
    try {
        conn = await db.getConnection();

        const existing = await conn.query('SELECT id FROM scraped_articles WHERE url = ?', [url]);
        if (existing.length > 0) {
            console.log('Debug: Existing article found in DB');
            return existing[0].id;
        }

        const result = await conn.query(
            'INSERT INTO scraped_articles (url, title, content, created_at) VALUES (?, ?, ?, NOW())',
            [url, title, content]
        );
        return result.insertId;
    } finally {
        if (conn) conn.release();
    }
}

// 헤드라인 뉴스 크롤링 및 데이터 반환 함수
function runHeadlineScript() {
    return new Promise((resolve, reject) => {
        const python = spawn('python', [headlineScriptPath]);

        let data = '';
        python.stdout.on('data', (chunk) => {
            data += chunk.toString();
        });

        python.stderr.on('data', (data) => {
            console.error(`Headline Script Error: ${data}`);
        });

        python.on('close', (code) => {
            if (code !== 0) {
                return reject(new Error('Headline script execution failed.'));
            }
            try {
                const headlines = JSON.parse(data); // JSON 데이터 파싱
                resolve(headlines);
            } catch (error) {
                reject(new Error('Failed to parse headline script output.'));
            }
        });
    });
}

// API 엔드포인트
app.post('/api/receive-url', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).send('URL is required');
    }

    try {
        // 데이터베이스에서 예측 결과 확인
        const existingPrediction = await getPredictionFromDB(url);
        if (existingPrediction) {
            const sim = await  getSimilarTitles(existingPrediction.title)//유사
            console.log(sim)
            return res.json({ ...existingPrediction, sim });                    // 기존 예측 결과 반환 유사도까지
        }

        // 기사 크롤링 및 저장
        const article = await scrapeArticle(url);

        const sim = await getSimilarTitles(article.title)                   //유사도찾기

        const articleId = await saveScrapedArticle(article.url, article.title, article.content);

        // Python 스크립트 실행
        await runPythonScript(url);

        // 데이터베이스에서 예측 결과 조회
        const prediction = await getPredictionFromDB(url);

        if (!prediction) {
            return res.status(500).send('Prediction not found in the database.');
        }

        console.log('Debug: Prediction from DB after script execution:', prediction);

        console.log(sim)
        return res.json({ ...prediction, sim })
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).send({ error: 'Internal server error', details: error.message });
    }
});

// 헤드라인 데이터 조회 API
app.get('/api/headlines', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const results = await conn.query(`
            SELECT 
                h.press_name, h.url, sa.title, p.real_news_probability, p.fake_news_probability
            FROM 
                headline h
            JOIN 
                scraped_articles sa ON h.url = sa.url
            JOIN 
                predictions p ON sa.id = p.article_id
            WHERE 
                h.created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
            ORDER BY 
                h.created_at DESC
        `);

        res.json(results);
    } catch (error) {
        console.error('Error fetching headlines:', error);
        res.status(500).send('Error fetching headlines');
    } finally {
        if (conn) conn.release();
    }
});

// 헤드라인 크롤링 즉시 실행 API
app.get('/api/test-headlines', async (req, res) => {
    try {
        console.log('즉시 헤드라인 크롤링 및 분석 작업 시작');

        // 헤드라인 크롤링 스크립트 실행
        const headlines = await runHeadlineScript();
        console.log('헤드라인 크롤링 완료:', headlines);

        const conn = await db.getConnection();
        try {
            for (const { press_name, title, url } of headlines) {
                try {
                    // 헤드라인은 항상 저장
                    await conn.query(
                        'INSERT INTO headline (press_name, url, created_at) VALUES (?, ?, NOW())',
                        [press_name, url]
                    );

                    // scraped_articles에 중복된 URL인지 확인
                    const existing = await conn.query('SELECT id FROM scraped_articles WHERE url = ?', [url]);
                    if (existing.length > 0) {
                        console.log(`중복 URL 발견, 스킵: ${url}`);
                        continue;
                    }

                    // 기사 본문 크롤링
                    const article = await scrapeArticle(url);

                    // 본문 내용이 있을 때만 scraped_articles에 저장
                    if (article.content) {
                        const articleId = await saveScrapedArticle(article.url, article.title, article.content);
                        console.log(`기사 저장 완료: ${article.title}`);

                        // Python 스크립트 실행
                        await runPythonScript(url);

                        // 예측 결과 데이터베이스 조회
                        const prediction = await getPredictionFromDB(url);

                        if (prediction) {
                            console.log(`기사 분석 완료: ${article.title}, 결과:`, prediction);
                        } else {
                            console.warn(`예측 결과를 찾을 수 없습니다: ${url}`);
                        }
                    } else {
                        console.warn(`본문 크롤링 실패: ${url}`);
                    }
                } catch (error) {
                    console.error(`헤드라인 저장 및 분석 중 오류 발생 (${url}):`, error.message);
                }
            }

            console.log('모든 헤드라인 크롤링 및 분석 완료');
            res.status(200).send('헤드라인 크롤링 및 분석 작업 완료');
        } finally {
            conn.release();
        }
    } catch (error) {
        console.error('헤드라인 작업 중 오류 발생:', error);
        res.status(500).send('헤드라인 작업 중 오류 발생');
    }
});


app.get('/help', (req, res) => {
    res.sendFile(path.join(__dirname, 'help.html'));
})


/*
// 1시간마다 헤드라인 크롤링 및 분석 실행
schedule.scheduleJob('0 * * * *', async () => {
    console.log('헤드라인 크롤링 및 분석 작업 시작');
    try {
        const headlines = await runHeadlineScript();
        console.log('헤드라인 크롤링 완료:', headlines);

        const conn = await db.getConnection();
        try {
            for (const { press_name, title, url } of headlines) {
                try {
                    await conn.query(
                        'INSERT IGNORE INTO headline (press_name, url, created_at) VALUES (?, ?, NOW())',
                        [press_name, url]
                    );

                    const article = await scrapeArticle(url);

                    if (article.content) {
                        const articleId = await saveScrapedArticle(article.url, article.title, article.content);
                        console.log(`기사 저장 완료: ${article.title}`);

                        // Python 스크립트 실행
                        await runPythonScript(url);

                        // 예측 결과 데이터베이스 조회
                        const prediction = await getPredictionFromDB(url);

                        if (prediction) {
                            console.log(`기사 분석 완료: ${article.title}, 결과:`, prediction);
                        } else {
                            console.warn(`예측 결과를 찾을 수 없습니다: ${url}`);
                        }
                    } else {
                        console.warn(`본문 크롤링 실패: ${url}`);
                    }
                } catch (error) {
                    console.error(`헤드라인 처리 중 오류 발생 (${url}):`, error.message);
                }
            }

            console.log('모든 헤드라인 분석 완료');
        } finally {
            conn.release();
        }
    } catch (error) {
        console.error('헤드라인 작업 중 오류 발생:', error);
    }
});
*/
// 서버 실행
app.listen(3000, () => {
    console.log('서버가 3000번 포트에서 실행 중입니다.');
});