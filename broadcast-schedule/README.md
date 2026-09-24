# broadcast-schedule 패치노트 에디터 수정

`sirian-cal.com` 패치노트 편집기 개선 파일입니다.

## 배포 방법

서버의 정적 파일 경로에 아래 파일을 덮어씁니다.

- `js/patchnotes.js` ← `broadcast-schedule/js/patchnotes.js`
- `css/patchnotes.css` ← `broadcast-schedule/css/patchnotes.css`

캐시 무효화를 위해 `patchnotes.html`의 쿼리 버전을 올려 주세요.

```html
<link rel="stylesheet" href="css/patchnotes.css?v=patchnotes-page2" />
<script type="module" src="js/patchnotes.js?v=patchnotes-page2"></script>
```

## 변경 내용

- 이미지 캡션: `input` → `textarea`, **Shift+Enter**로 줄바꿈
- 캡션/본문 저장·표시 시 줄바꿈 유지 (`white-space: pre-wrap`)
- 이미지 블록 앞뒤 커서 앵커 추가 → 위·아래에 글 입력 가능
- 이미지 블록 클릭 시 상·하반부에 따라 커서 위치 이동
