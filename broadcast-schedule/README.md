# broadcast-schedule (sirian-cal.com)

## 배포

| 파일 | 서버 경로 |
|------|-----------|
| `server.py` | `server.py` (재시작 필요) |
| `js/musicbook.js` | `js/musicbook.js` |
| `musicbook.html` | `musicbook.html` |

`server.py` 반영 후 `./restart.sh` 실행.

## 최근 변경: 노래책 「최근 수정」 정렬

- 공개 API(`/api/musicbook`)가 곡의 `updatedAt`을 빼먹어, 「최근 수정」이 사실상 좋아요 순으로 보이던 문제 수정
- 하트(좋아요)는 `musicbook-likes.json`에만 저장되며 곡 `updatedAt`을 바꾸지 않음
- 클라이언트에서도 `updated-desc` 정렬의 2차 키로 좋아요를 쓰지 않도록 변경
