import os
import sys
import json
import torch
import numpy as np
from kobert_transformers import get_kobert_model, get_tokenizer
from tensorflow.keras.models import load_model
import pymysql

# TensorFlow 경고 및 로그 억제
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'
import absl.logging
absl.logging.set_verbosity(absl.logging.ERROR)

# KoBERT 모델 및 토크나이저 초기화
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
bert_model = get_kobert_model().to(device)
tokenizer = get_tokenizer()

# MariaDB 연결 설정
def get_db_connection():
    return pymysql.connect(
        host="localhost",
        user="dbid233",
        password="dbpass233",
        database="db24327",
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
        port=3306,
    )

# CLS 벡터 추출 함수
def extract_cls_vector_single(text):
    inputs = tokenizer(
        text, padding=True, truncation=True, return_tensors="pt", max_length=512
    )
    inputs = {key: value.to(device) for key, value in inputs.items()}

    with torch.no_grad():
        outputs = bert_model(**inputs)
        cls_vector = outputs.last_hidden_state[:, 0, :].cpu().numpy()

    return cls_vector

try:
    if len(sys.argv) < 2:
        raise ValueError("URL이 명령줄 인자로 제공되지 않았습니다.")

    url = sys.argv[1]

    connection = get_db_connection()

    with connection.cursor() as cursor:
        cursor.execute("SELECT id, title, content FROM scraped_articles WHERE url = %s", (url,))
        article = cursor.fetchone()

        if not article:
            raise ValueError(f"URL {url}에 해당하는 기사를 찾을 수 없습니다.")

        article_id = article["id"]
        title = article["title"]
        content = article["content"]

    cls_vector_title = extract_cls_vector_single(title).squeeze(axis=0)
    cls_vector_content = extract_cls_vector_single(content).squeeze(axis=0)

    cls_vector_title = np.expand_dims(cls_vector_title, axis=0)
    cls_vector_content = np.expand_dims(cls_vector_content, axis=0)

    model_path = "/home/t24327/svr/AI/bert_first.keras"
    model = load_model(model_path)

    prediction = model.predict([cls_vector_title, cls_vector_content])

    # 예측 결과 확인 및 소수점 자릿수 제한
    real_news_probability = round(float(prediction[0][0]), 6)  # 소수점 6자리까지 제한
    fake_news_probability = round(1 - real_news_probability, 6)

    # 디버깅: 예측 결과 출력
    print(f"Debug: real_news_probability={real_news_probability}, fake_news_probability={fake_news_probability}")

    if not (0 <= real_news_probability <= 1):
        raise ValueError("예측 결과가 유효하지 않습니다.")

    with connection.cursor() as cursor:
        # 중복 확인 및 삽입
        cursor.execute("SELECT * FROM predictions WHERE article_id = %s", (article_id,))
        existing = cursor.fetchone()

        if existing:
            print("Debug: 이미 예측 결과가 존재합니다. 데이터베이스에 삽입하지 않습니다.")
        else:
            cursor.execute(
                """
                INSERT INTO predictions (article_id, real_news_probability, fake_news_probability, created_at)
                VALUES (%s, %s, %s, NOW())
                """,
                (article_id, real_news_probability, fake_news_probability)
            )
            connection.commit()
            print("Debug: 데이터베이스 삽입 성공")

    # 결과 출력
    result = {
        "real_news_probability": real_news_probability,
        "fake_news_probability": fake_news_probability,
    }
    print(json.dumps(result))

except Exception as e:
    error_result = {"error": str(e)}
    print(json.dumps(error_result))

finally:
    if 'connection' in locals() and connection.open:
        connection.close()
