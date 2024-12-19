import requests
from bs4 import BeautifulSoup
import json

# 네이버 뉴스 '많이 본 뉴스' URL
url = 'https://news.naver.com/main/ranking/popularDay.naver'

# 관심 있는 언론사 리스트
target_press = ["JTBC", "KBS", "SBS", "매일경제", "국민일보","조선일보", "머니투데이", "아시아경제"]

def scrape_headlines():
    response = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'})
    response.raise_for_status()
    soup = BeautifulSoup(response.text, 'html.parser')

    results = []
    for box in soup.find_all('div', class_='rankingnews_box'):
        press_name_tag = box.find('strong', class_='rankingnews_name')
        if press_name_tag:
            press_name = press_name_tag.get_text(strip=True)
            if press_name in target_press:
                articles = box.find_all('li')[:10]  # 상위 5개 기사만 저장
                for article in articles:
                    link_tag = article.find('a')
                    if link_tag and link_tag['href']:
                        title = link_tag.get_text(strip=True)
                        link = link_tag['href']
                        results.append({'press_name': press_name, 'title': title, 'url': link})
    return results

if __name__ == '__main__':
    headlines = scrape_headlines()
    print(json.dumps(headlines, ensure_ascii=False))

# ["JTBC", "한국경제", "YTN", "서울경제", "머니투데이",
#                "아시아경제", "KBS", "국민일보", "SBS", "이데일리",
#                "매일경제", "MBC"]