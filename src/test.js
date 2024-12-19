// 문자열 유사도를 계산하는 Levenshtein Distance 라이브러리 설치 필요 (npm install fast-levenshtein)
const levenshtein = require('fast-levenshtein');
const mariadb = require('mariadb');

// MariaDB 데이터베이스 연결 설정
const db = mariadb.createPool({
    host: 'localhost',
    port: 3306,
    user: 'dbid233',
    password: 'dbpass233',
    database: 'db24327',
    connectionLimit: 20,
});

// 입력받은 제목



// 유사도를 계산하는 함수
function findSimilarTitles(input, titles) {
    return titles.map(({ title, url, probability }) => {
        // Levenshtein Distance 계산
        const distance = levenshtein.get(input, title);
        // 유사도를 0~1 범위로 변환 (작을수록 유사함) 및 소수점 3째 자리로 제한
        const similarity = parseFloat((1 - distance / Math.max(input.length, title.length)).toFixed(3));
        return { title, url, probability, similarity};
    })
    .sort((a, b) => b.similarity - a.similarity) // 유사도 순으로 정렬
    .slice(1, 4); // 상위 10개만 추출
}

// DB에서 뉴스 제목, URL, 확률 가져오기 및 유사한 제목 찾기
async function getSimilarTitles(title) {
    let connection;
    try {
        connection = await db.getConnection();

        // DB에서 제목, URL, 확률 가져오기
        const rows = await connection.query(`
            SELECT sa.title, sa.url, p.real_news_probability AS probability
            FROM scraped_articles sa
            JOIN predictions p ON sa.id = p.id
        `);
        const newsTitles = rows.map(row => ({
            title: row.title,
            url: row.url,
            probability: row.probability
        }));

        // 유사한 제목 찾기
        const similarTitles = findSimilarTitles(title, newsTitles);
        return similarTitles;
        
    } catch (err) {
        console.error("DB 작업 중 오류 발생:", err);
    } finally {
        if (connection) {
            connection.release();
        }
    }
}

module.exports = { findSimilarTitles, getSimilarTitles };
