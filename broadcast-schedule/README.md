# broadcast-schedule — 뱅온 시간 시 선택 수정

## 배포

| 파일 | 서버 경로 |
|------|-----------|
| `js/slots.js` | `js/slots.js` |
| `js/editor.js` | `js/editor.js` |
| `js/app.js` | `js/app.js` |
| `index.html` | `index.html` |

정적 파일만 변경 — 재시작 불필요. 브라우저 강력 새로고침 권장.

## 원인

시 드롭다운 패널이 모달 `overflow` 때문에 `document.body`로 포탈되는데,
`readBangonPickerValue()`가 피커 DOM 안의 `.slot-start-hour-option.is-active`만 찾아
선택값이 빈 문자열로 저장되고 UI가 「선택 안 함」으로 돌아갔습니다.
