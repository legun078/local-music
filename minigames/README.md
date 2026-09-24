# 미니게임 랭킹 등록 수정

## 문제

랭킹 플레이 후 TOP 10에 들어도 리더보드에 등록되지 않는 현상.

### 원인 1: 등록 버튼이 비활성화됨

`rank-nickname-gate.js`가 페이지 로드 시 **등록** 버튼을 끄고, 이름 확인 다이얼로그를 열 때 닉네임을 채워 넣어도 버튼 상태를 다시 켜지 않았습니다.

### 원인 2: 닉네임을 서버에 보내지 않음

로비에서 닉네임을 이미 확인했는데도 첫 API 요청에 `displayName`을 넣지 않아, 불필요하게 이름 확인 창이 뜨거나 등록이 건너뛰어질 수 있었습니다.

## 수정 파일 (서버 `/games` 경로에 덮어쓰기)

| 파일 |
|------|
| `js/rank-nickname-gate.js` |
| `hide/rank/rank.js` |
| `minesweeper/rank/rank.js` |
| `apple/rank/rank.js` |
| `2048/rank/rank.js` |

배포 후 브라우저 캐시를 피하려면 각 게임 `rank/index.html`의 `rank.js?v=` 버전 번호를 올려 주세요.

## 배포 예시 (SSH)

```bash
# 서버의 minigames 루트로 경로를 맞춘 뒤
sudo systemctl restart minigames   # 실제 서비스명은 서버 설정에 따름
```
