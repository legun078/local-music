# broadcast-schedule (sirian-cal.com)

방송 일정·노래책·패치노트 사이트 백엔드/정적 파일입니다.

## 배포

| 파일 | 서버 경로 |
|------|-----------|
| `server.py` | `server.py` (재시작 필요) |
| `analytics.html` | `analytics.html` |

## 최근 변경: 운영 로그 확장

- **로그인** (`auth` / `login`): Google OAuth 콜백·부하 테스트 로그인
- **로그아웃** (`auth` / `logout`): 세션 종료 전 기록
- **좋아요** (`songRequests` / `like`·`unlike`): 노래책 신청 좋아요 토글

운영 대시보드(`/analytics`) 수정 로그 필터에 **인증** 항목이 추가되었습니다.
