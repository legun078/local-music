/**
 * 홀로그램 테마 — 시안(designer) 보고서 패널과 동일 구조.
 * window.EndingHologram
 */
(() => {
  const THEMES = {
    report: { label: "투영", float: true },
    reportProj: { label: "글래스", float: false },
  };

  const PAGE_CODES = {
    coverOpen: "01 / TITLE",
    summary: "02 / SUMMARY",
    highlight: "03 / HIGHLIGHT",
    analytics: "04 / ANALYTICS",
    timeline: "05 / TIMELINE",
    firstChat: "06 / FIRSTCHAT",
    chat: "07 / CHAT",
    emoticon: "08 / EMOTICON",
    donation: "09 / DONATION",
    signature: "10 / SIGNATURE",
    watch: "11 / WATCH",
    quickview: "12 / QUICKVIEW",
    mission: "13 / MISSION",
    fanclub: "14 / FANCLUB",
    topfan: "15 / TOPFAN",
    subscribe: "16 / SUBSCRIBE",
    subscribe_renew: "17 / SUBSCRIBE_RENEW",
    subscribe_gift: "18 / SUBSCRIBE_GIFT",
    flags: "19 / FLAGS",
    nextDay: "20 / NEXTDAY",
    outro: "21 / OUTRO",
    coverClose: "99 / COVERCLOSE",
  };

  function placeLabel(n) {
    const s = String(n ?? "").trim();
    if (!s) return "";
    if (/위$/.test(s)) return s;
    return `${s}위`;
  }

  function isHologramTheme(id) {
    return Boolean(THEMES[String(id || "").trim()]);
  }

  function themeMeta(id) {
    return THEMES[String(id || "").trim()] || null;
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function pageClass(id) {
    const safe = String(id || "").replace(/[^a-zA-Z0-9_-]/g, "");
    return safe ? ` credits-slide--page-${safe}` : "";
  }

  function wrap(slide, inner) {
    return `<div class="credits-slide credits-slide--holo credits-slide--${esc(
      slide.kind || "stat"
    )}${pageClass(slide.id)}" data-id="${esc(slide.id || "")}" data-duration="${
      slide.duration || 6500
    }" data-kind="${esc(slide.kind || "")}"${
      slide.closedMs != null ? ` data-closed="${slide.closedMs}"` : ""
    }${slide.fadeMs != null ? ` data-fade="${slide.fadeMs}"` : ""} aria-hidden="true">${inner}</div>`;
  }

  function fmt(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return String(n ?? "");
    return v.toLocaleString("ko-KR");
  }

  /** "420개" · "190회" → 숫자. 순위 바 너비용 */
  function metricNum(raw) {
    const m = String(raw ?? "")
      .replace(/,/g, "")
      .match(/([\d.]+)/);
    if (!m) return 0;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : 0;
  }

  /** 1위=100%, 나머지 비례. 0이 아니면 최소 8%로 보이게 */
  function barPct(value, max) {
    const m = Number(max) || 0;
    const v = Number(value) || 0;
    if (m <= 0 || v <= 0) return 0;
    return Math.max(8, Math.round((v / m) * 1000) / 10);
  }

  function coverDateCode(slide) {
    const code = String(slide?.dateCode || "").trim();
    if (code) return code;
    const label = String(slide?.dateLabel || "").trim();
    const m = label.match(/(\d+)\s*월\s*(\d+)\s*일/);
    if (m) {
      const y = new Date().getFullYear();
      return `${y}.${String(m[1]).padStart(2, "0")}.${String(m[2]).padStart(2, "0")}`;
    }
    return label;
  }

  function pageCodeFor(slide) {
    const id = String(slide?.id || "").trim();
    if (PAGE_CODES[id]) return PAGE_CODES[id];
    const code = id ? id.toUpperCase() : "PAGE";
    return `00 / ${code}`;
  }

  function footFor(themeId) {
    return String(themeId) === "reportProj"
      ? "HOLO GLASS · REPORT"
      : "HOLO PROJECTION · REPORT";
  }

  function reportSection(label, body) {
    return `<section class="rpt__sec">
      <h3 class="rpt__sec-label">${esc(label)}</h3>
      ${body}
    </section>`;
  }

  function reportShell(themeId, slide, pageTitle, bodyHtml) {
    const proj = String(themeId) === "report";
    const date = coverDateCode(slide);
    const doc = slide.docId ? ` · ${esc(slide.docId)}` : "";
    const title = String(pageTitle || "").trim();
    const titleHtml = title ? `<h2 class="rpt__title">${esc(title)}</h2>` : "";
    const coverClass = slide?.kind === "coverOpen" ? " rpt--cover" : "";
    return `<div class="rpt${proj ? " rpt--proj" : ""}${coverClass}">
      <header class="rpt__head">
        <div class="rpt__meta">
          <span class="rpt__org">SIRIAN RAIN</span>
          <span class="rpt__doc">ENDING REPORT${doc}</span>
        </div>
        <div class="rpt__title-row">
          <div>
            <p class="rpt__code">${esc(pageCodeFor(slide))}</p>
            ${titleHtml}
          </div>
          ${date ? `<time class="rpt__date">${esc(date)}</time>` : ""}
        </div>
      </header>
      <div class="rpt__rule" aria-hidden="true"></div>
      ${bodyHtml}
      <footer class="rpt__foot">${esc(footFor(themeId))}</footer>
    </div>`;
  }

  function coverBody(slide, isClose) {
    /* 시안 themes.js coverHtml 과 동일 구조·클래스 */
    const brandText = String(slide.brand || "SIRIAN RAIN").trim() || "SIRIAN RAIN";
    let hero = String(slide.hero || "").trim();
    if (!hero) hero = isClose ? "END" : "오늘의 방송 보고서";
    const titleText = String(slide.title || "ENDING CREDITS").trim() || "ENDING CREDITS";
    let sub = String(slide.sub || "").trim();
    if (!sub) {
      sub = isClose
        ? "다음 방송에서 만나요"
        : [titleText, slide.dateLabel || coverDateCode(slide)].filter(Boolean).join(" · ");
    }
    if (isClose) {
      return reportSection(
        "뒷표지",
        `<div class="rpt__next">
          <p class="t-proj__hero t-proj__hero--sm">${esc(hero)}</p>
          <span class="t-proj__sub">${esc(sub)}</span>
        </div>`
      );
    }
    /* 앞표지: 섹션 라벨 없이 타이틀 페이지 구성 */
    return `<div class="rpt__cover">
      <span class="t-proj__brand">${esc(brandText)}</span>
      <p class="t-proj__hero t-proj__hero--cover">${esc(hero)}</p>
      <span class="t-proj__sub">${esc(sub)}</span>
    </div>`;
  }

  function summaryBody(slide) {
    /* 시안 themes.js reportBody(summary) · snapshotMetrics 와 동일 */
    const title = String(
      slide.broadcastTitle || slide.streamTitle || slide.peakTitle || ""
    ).trim();
    const dur = String(slide.durationLabel || "").trim();
    const timeRange = String(slide.timeRangeLabel || "").trim();
    const oneLiner = String(slide.oneLiner || "").trim();
    const don =
      slide.donationLabel ||
      (slide.donationCount != null && Number(slide.donationCount) > 0
        ? `${fmt(slide.donationCount)}명`
        : "");
    const sub =
      slide.subscribeLabel ||
      (slide.subscribeCount != null && Number(slide.subscribeCount) > 0
        ? `${fmt(slide.subscribeCount)}명`
        : "");
    const fields = [
      ["채팅", slide.chatCount ? `${fmt(slide.chatCount)}회` : ""],
      ["참여자", slide.chatters ? `${fmt(slide.chatters)}명` : ""],
      ["후원", don],
      ["구독", sub],
    ].filter(([, v]) => v);
    return `
      <div class="rpt__summary">
        <div class="rpt__overview">
          <span class="rpt__overview-kicker">방송 개요</span>
          ${title ? `<strong>${esc(title)}</strong>` : ""}
          ${timeRange ? `<span class="rpt__overview-time">${esc(timeRange)}</span>` : ""}
          ${dur ? `<b class="rpt__overview-dur">${esc(dur)}</b>` : ""}
          ${oneLiner ? `<p>${esc(oneLiner)}</p>` : ""}
        </div>
        ${
          fields.length
            ? `<div class="rpt__snap">
          <h3 class="rpt__sec-label">참여 스냅샷</h3>
          <dl class="rpt__fields">
            ${fields
              .map(
                ([k, v]) =>
                  `<div class="rpt__field"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`
              )
              .join("")}
          </dl>
        </div>`
            : ""
        }
      </div>`;
  }

  function rankBody(slide) {
    const champ = slide.champ || {};
    const rest = Array.isArray(slide.rest) ? slide.rest : [];
    const rows = [];
    if (champ.name) {
      rows.push({ place: placeLabel(champ.rank || 1), name: champ.name, count: champ.value || "" });
    }
    rest.forEach((item, i) => {
      rows.push({
        place: placeLabel(item.rank || i + 2),
        name: item.name || "",
        count: item.value || "",
      });
    });
    const isEmo = String(slide.id || "") === "emoticon";
    const topEmo = Array.isArray(slide.topEmoticons)
      ? slide.topEmoticons.filter((e) => e && (e.name || e.imageUrl)).slice(0, 6)
      : [];

    /* 이모티콘 페이지: 시그니처 이미지 TOP이 본문, 유저는 짧게 */
    if (isEmo && topEmo.length) {
      const userRows = rows.slice(0, 5);
      const userMax = Math.max(0, ...userRows.map((r) => metricNum(r.count)));
      const unit = String(slide.unit || "횟수");
      return (
        reportSection(
          slide.topLabel || "구독 시그니처 이모티콘",
          `<ol class="rpt__emo-grid">
            ${topEmo
              .map((item, i) => {
                const img = String(item.imageUrl || "").trim();
                return `<li class="rpt__emo-card${i === 0 ? " is-top" : ""}" style="--i:${i}">
                  <span class="rpt__emo-rank">${esc(placeLabel(item.rank || i + 1))}</span>
                  <span class="rpt__emo-art">
                    ${
                      img
                        ? `<img src="${esc(img)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`
                        : `<span class="rpt__emo-ph" aria-hidden="true">◇</span>`
                    }
                  </span>
                  <span class="rpt__emo-meta">
                    <em>${esc(item.value || item.count || "")}</em>
                  </span>
                </li>`;
              })
              .join("")}
          </ol>`
        ) +
        (userRows.length
          ? reportSection(
              "사용 유저",
              `<table class="rpt__table rpt__table--rank rpt__table--emo-users">
                <thead><tr><th>순위</th><th>닉네임</th><th class="is-num">${esc(unit)}</th></tr></thead>
                <tbody>
                  ${userRows
                    .map((r, i) => {
                      const pct = barPct(metricNum(r.count), userMax);
                      return `<tr class="${i === 0 ? "is-top" : ""}" style="--i:${i}">
                        <td colspan="3" class="rpt__rank-cell">
                          <span class="rpt__rank-bar" style="width:${pct}%" aria-hidden="true"></span>
                          <div class="rpt__rank-line">
                            <span class="rpt__mono">${esc(r.place)}</span>
                            <span class="rpt__rank-name">${esc(r.name)}</span>
                            <span class="is-num">${esc(r.count)}</span>
                          </div>
                        </td>
                      </tr>`;
                    })
                    .join("")}
                </tbody>
              </table>`
            )
          : "")
      );
    }

    const maxMetric = Math.max(0, ...rows.map((r) => metricNum(r.count)));
    const unit = String(slide.unit || "횟수");
    if (!rows.length) return "";
    return reportSection(
      slide.title || "순위",
      `<table class="rpt__table rpt__table--rank">
        <thead><tr><th>순위</th><th>닉네임</th><th class="is-num">${esc(unit)}</th></tr></thead>
        <tbody>
          ${rows
            .map((r, i) => {
              const pct = barPct(metricNum(r.count), maxMetric);
              return `<tr class="${i === 0 ? "is-top" : ""}" style="--i:${i}">
              <td colspan="3" class="rpt__rank-cell">
                <span class="rpt__rank-bar" style="width:${pct}%" aria-hidden="true"></span>
                <div class="rpt__rank-line">
                  <span class="rpt__mono">${esc(r.place)}</span>
                  <span class="rpt__rank-name">${esc(r.name)}</span>
                  <span class="is-num">${esc(r.count)}</span>
                </div>
              </td>
            </tr>`;
            })
            .join("")}
        </tbody>
      </table>
      ${
        Number(slide.more) > 0
          ? `<p class="rpt__more">외 ${esc(fmt(slide.more))}명</p>`
          : ""
      }`
    );
  }

  function signatureBody(slide) {
    const items = Array.isArray(slide.items) ? slide.items : [];
    const byRank = [...items].sort((a, b) => (Number(a.rank) || 99) - (Number(b.rank) || 99));
    return reportSection(
      "시그니처 집계",
      `<table class="rpt__table rpt__table--sig">
        <thead><tr><th>순위</th><th>시그니처</th><th class="is-num">횟수</th></tr></thead>
        <tbody>
          ${byRank
            .slice(0, 5)
            .map((item, i) => {
              const img = String(item.imageUrl || "").trim();
              const donor = String(item.topDonor || "").trim();
              const hits = Number(item.topDonorHits) || 0;
              const donorLine = donor
                ? hits > 0
                  ? `대표 ${donor} ${fmt(hits)}번`
                  : `대표 ${donor}`
                : "";
              return `<tr class="${i === 0 ? "is-top" : ""}" style="--i:${i}">
                <td class="rpt__mono">${esc(placeLabel(item.rank || i + 1))}</td>
                <td>
                  <span class="rpt__sig">
                    <span class="sig-balloon">
                      ${
                        img
                          ? `<img src="${esc(img)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`
                          : ""
                      }
                    </span>
                    <span>
                      <b>${esc(item.name || item.value || "")}</b>
                      ${donorLine ? `<em>${esc(donorLine)}</em>` : ""}
                    </span>
                  </span>
                </td>
                <td class="is-num">${esc(item.value || item.count || "")}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
      ${
        Number(slide.more) > 0
          ? `<p class="rpt__more">외 ${esc(fmt(slide.more))}번</p>`
          : ""
      }`
    );
  }

  function highlightBody(slide) {
    const peak = Number(slide.peakViewers) || 0;
    const peakLabel = peak > 0 ? `${fmt(peak)}명` : "";
    const thumb = String(slide.peakThumbUrl || "").trim();
    const at = String(slide.peakAtLabel || "").trim();
    const title = String(slide.peakTitle || "").trim();
    const cap = String(slide.peakLabel || "최고 시청 순간").trim();
    return reportSection(
      "최고 시청 순간",
      `<figure class="hl">
        <div class="hl__shot">
          ${
            thumb
              ? `<img src="${esc(thumb)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`
              : `<div class="hl__ph">썸네일 없음</div>`
          }
          ${
            peakLabel
              ? `<span class="hl__badge"><em>PEAK</em><b>${esc(peakLabel)}</b></span>`
              : ""
          }
        </div>
        <figcaption class="hl__cap">
          ${at ? `<span class="hl__time">${esc(at)}</span>` : ""}
          ${title ? `<strong>${esc(title)}</strong>` : ""}
          <em>${esc(cap)}</em>
        </figcaption>
      </figure>`
    );
  }

  function downsampleSeries(vals, n) {
    const arr = Array.isArray(vals) ? vals.filter((v) => Number.isFinite(Number(v))) : [];
    if (!arr.length) return [];
    if (arr.length <= n) return arr.map(Number);
    const peakIdx = arr.reduce((best, v, i) => (v > arr[best] ? i : best), 0);
    const idxs = new Set([0, arr.length - 1, peakIdx]);
    for (let i = 0; i < n; i++) {
      idxs.add(Math.round((i * (arr.length - 1)) / (n - 1)));
    }
    return [...idxs]
      .sort((a, b) => a - b)
      .map((i) => Number(arr[i]));
  }

  function parsePeakHint(slide) {
    const n = Number(slide?.peakViewers);
    if (Number.isFinite(n) && n > 0) return n;
    const digits = String(slide?.peakViewersLabel || "").replace(/[^\d]/g, "");
    const parsed = Number(digits);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  function pathSmoothFromXY(pts) {
    const list = Array.isArray(pts) ? pts : [];
    if (!list.length) return "";
    const fmt = (n) => Number(n).toFixed(1);
    if (list.length === 1) return `M${fmt(list[0].x)},${fmt(list[0].y)}`;
    if (list.length === 2) {
      return `M${fmt(list[0].x)},${fmt(list[0].y)} L${fmt(list[1].x)},${fmt(list[1].y)}`;
    }
    // Catmull-Rom → cubic Bézier (개발자 차트와 동일 — 선만 부드럽게)
    let d = `M${fmt(list[0].x)},${fmt(list[0].y)}`;
    for (let i = 0; i < list.length - 1; i++) {
      const p0 = list[Math.max(0, i - 1)];
      const p1 = list[i];
      const p2 = list[i + 1];
      const p3 = list[Math.min(list.length - 1, i + 2)];
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      d += ` C${fmt(cp1x)},${fmt(cp1y)} ${fmt(cp2x)},${fmt(cp2y)} ${fmt(p2.x)},${fmt(p2.y)}`;
    }
    return d;
  }

  function viewerSparkSvg(vals, peakHint) {
    const raw = Array.isArray(vals)
      ? vals.filter((v) => Number.isFinite(Number(v))).map(Number)
      : [];
    // 분 단위 전체 시계열을 쓰고, 6시간 초과분만 피크 보존 다운샘플
    const series = downsampleSeries(raw, 360);
    if (series.length < 2) return "";
    const w = 280;
    const h = 88;
    const pad = 4;
    const max = Math.max(...series, Number(peakHint) || 0, 1);
    const min = Math.min(...series, 0);
    const span = Math.max(max - min, 1);
    const linePts = series.map((v, i) => {
      const x = pad + (i / Math.max(series.length - 1, 1)) * (w - pad * 2);
      const y = h - pad - ((v - min) / span) * (h - pad * 2);
      return { x, y };
    });
    const lineD = pathSmoothFromXY(linePts);
    const bottomY = (h - pad).toFixed(1);
    const firstX = linePts[0].x.toFixed(1);
    const lastX = linePts[linePts.length - 1].x.toFixed(1);
    const areaD = `${lineD} L${lastX},${bottomY} L${firstX},${bottomY} Z`;
    const peakIdx = series.indexOf(Math.max(...series));
    const peakPt = linePts[peakIdx] || { x: w / 2, y: h / 2 };
    return `<svg class="an__chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <path class="an__area" d="${areaD}" />
      <path class="an__line" d="${lineD}" fill="none" />
      <circle class="an__peak" cx="${peakPt.x.toFixed(1)}" cy="${peakPt.y.toFixed(1)}" r="3.5" />
    </svg>`;
  }

  function analyticsBody(slide) {
    const range = String(slide.timeRangeLabel || "").trim();
    const chart = viewerSparkSvg(slide.viewers, parsePeakHint(slide));
    const metrics = [
      ["평균 시청", slide.avgViewersLabel],
      ["최고 시청", slide.peakViewersLabel],
      ["UP", slide.upLabel],
      ["별풍", slide.balloonLabel],
    ].filter(([, v]) => v);
    return reportSection(
      "시청 · 참여 추이",
      `<div class="an">
        <div class="an__chart-wrap">
          <div class="an__chart-label">
            <span>시청자 수</span>
            ${range ? `<span>${esc(range)}</span>` : ""}
          </div>
          ${chart || `<div class="hl__ph">시청 데이터 없음</div>`}
        </div>
        ${
          metrics.length
            ? `<dl class="an__metrics">
          ${metrics
            .map(
              ([k, v]) =>
                `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`
            )
            .join("")}
        </dl>`
            : ""
        }
      </div>`
    );
  }

  function listBody(slide) {
    const names = Array.isArray(slide.names) ? slide.names : [];
    return reportSection(
      slide.title || "목록",
      `${
        slide.countLabel
          ? `<p class="rpt__next-date">${esc(slide.countLabel)}</p>`
          : ""
      }
      <ul class="holo-designer-list">
        ${names.map((n) => `<li>${esc(n)}</li>`).join("")}
      </ul>
      ${
        Number(slide.more) > 0
          ? `<p class="rpt__more">외 ${esc(fmt(slide.more))}명</p>`
          : ""
      }`
    );
  }

  function flagsBody(slide) {
    const items = Array.isArray(slide.items) ? slide.items : [];
    return reportSection(
      slide.title || "팬·열혈·매니저",
      `<dl class="rpt__fields">
        ${items
          .map(
            (it) =>
              `<div class="rpt__field"><dt>${esc(it.label)}</dt><dd>${esc(it.value)}</dd></div>`
          )
          .join("")}
      </dl>`
    );
  }

  function statBody(slide) {
    const subRaw = String(slide.sub || "").trim();
    const sub = subRaw.replace(/^[“"]|[”"]$/g, "").trim();
    const at = String(slide.atLabel || "").trim();
    const quoteSub = slide.kind !== "firstChatEmo";
    return reportSection(
      slide.title || "기록",
      `<div class="rpt__overview">
        <strong>${esc(slide.value || "—")}</strong>
        ${
          sub
            ? quoteSub
              ? `<p>“${esc(sub)}”</p>`
              : `<p>${esc(sub)}</p>`
            : ""
        }
        ${at ? `<span class="rpt__overview-time">${esc(at)}</span>` : ""}
        ${
          slide.imageUrl
            ? `<img class="rpt__stat-img" src="${esc(slide.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
            : ""
        }
      </div>`
    );
  }

  /** 시안처럼 시각 칸은 HH:MM 만 (방송 ON/방제 접두어 제거) */
  function timelineClock(m) {
    const raw = String(m?.label || "").trim();
    const stripped = raw.replace(/^(방송\s*ON|방송\s*OFF|방제)\s*/i, "").trim();
    const hm = stripped.match(/\b(\d{1,2}):(\d{2})\b/);
    if (hm) return `${String(hm[1]).padStart(2, "0")}:${hm[2]}`;
    return stripped || "—";
  }

  function timelineBody(slide) {
    const tl = slide.timeline || {};
    const markers = Array.isArray(tl.markers) ? tl.markers : [];
    const rows = markers
      .filter((m) => m && (m.label || m.title))
      .slice(0, 12)
      .map((m, i) => {
        const clock = timelineClock(m);
        const body =
          m.kind === "start"
            ? m.title || "방송 시작"
            : m.kind === "end"
              ? m.title || "방송 종료"
              : m.title || "방제 변경";
        return `<tr style="--i:${i}"><td class="rpt__mono">${esc(clock)}</td><td>${esc(body)}</td></tr>`;
      })
      .join("");
    return reportSection(
      "진행 기록",
      `<table class="rpt__table rpt__table--tl">
        <thead><tr><th>시각</th><th>구간</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="2">타임라인 데이터 없음</td></tr>`}</tbody>
      </table>`
    );
  }

  function nextDayBody(slide) {
    const parts = Array.isArray(slide.parts) ? slide.parts : [];
    if (parts.length) {
      return reportSection(
        "편성 예고",
        `<div class="rpt__next">
          ${
            slide.dateLabel
              ? `<p class="rpt__next-date">${esc(slide.dateLabel)}</p>`
              : ""
          }
          ${parts
            .map((p) => {
              const items = Array.isArray(p.items) ? p.items : [];
              const part = String(p.partLabel || "").trim();
              const bangon = String(p.bangonLabel || "").trim();
              return `<div class="rpt__next-part">
                <div class="rpt__next-head">
                  <b>${esc(part || p.headerLabel || "")}</b>
                  ${bangon ? `<span>뱅온 ${esc(bangon)}</span>` : ""}
                </div>
                <p>${items.map((it) => esc(it.text || it)).join(" · ")}</p>
              </div>`;
            })
            .join("")}
        </div>`
      );
    }
    const items = Array.isArray(slide.items) ? slide.items : [];
    return reportSection(
      "편성 예고",
      `<div class="rpt__next">
        ${
          slide.dateLabel
            ? `<p class="rpt__next-date">${esc(slide.dateLabel)}</p>`
            : ""
        }
        <p>${
          items.length
            ? items.map((it) => esc(it.text || it)).join(" · ")
            : esc(slide.emptyHint || "등록된 일정이 없어요")
        }</p>
      </div>`
    );
  }

  function outroBody(slide) {
    return reportSection(
      "엔딩",
      `<div class="rpt__next">
        <span class="t-proj__brand">${esc(slide.eyebrow || "엔딩")}</span>
        <p class="t-proj__hero t-proj__hero--sm">${esc(slide.value || "오늘 방송 종료")}</p>
        <span class="t-proj__sub">${esc(slide.sub || "")}</span>
      </div>`
    );
  }

  function renderWithShell(themeId, slide, pageTitle, bodyHtml) {
    return wrap(slide, reportShell(themeId, slide, pageTitle, bodyHtml));
  }

  function renderSlideHtml(themeId, slide) {
    if (!slide || !isHologramTheme(themeId)) return "";
    switch (slide.kind) {
      case "coverOpen":
        return renderWithShell(themeId, slide, "", coverBody(slide, false));
      case "outro":
        return renderWithShell(themeId, slide, "엔딩", outroBody(slide));
      case "summary":
        return renderWithShell(
          themeId,
          slide,
          slide.holoTitle || "방송 요약",
          summaryBody(slide)
        );
      case "highlight":
        return renderWithShell(
          themeId,
          slide,
          slide.title || "하이라이트",
          highlightBody(slide)
        );
      case "analytics":
        return renderWithShell(
          themeId,
          slide,
          slide.title || "방송 분석",
          analyticsBody(slide)
        );
      case "rankBoard":
        return renderWithShell(themeId, slide, slide.title || "순위", rankBody(slide));
      case "signatureBoard":
        return renderWithShell(
          themeId,
          slide,
          slide.holoTitle || "시그니처",
          signatureBody(slide)
        );
      case "list":
        return renderWithShell(themeId, slide, slide.title || "목록", listBody(slide));
      case "flags":
        return renderWithShell(
          themeId,
          slide,
          slide.title || "팬·열혈·매니저",
          flagsBody(slide)
        );
      case "stat":
      case "firstChatEmo":
        return renderWithShell(themeId, slide, slide.title || "기록", statBody(slide));
      case "timeline":
        return renderWithShell(themeId, slide, "타임라인", timelineBody(slide));
      case "nextDay":
        return renderWithShell(themeId, slide, "다음방송", nextDayBody(slide));
      default:
        return renderWithShell(
          themeId,
          slide,
          slide.title || slide.id || "PAGE",
          reportSection(slide.title || "PAGE", `<p class="t-proj__sub">${esc(slide.id || "")}</p>`)
        );
    }
  }

  function setActivePage(pageId) {
    const frame = document.getElementById("credits-holo-frame");
    const design = document.querySelector(".credits-holo__design");
    const id = String(pageId || "").trim();
    for (const el of [frame, design]) {
      if (!el) continue;
      if (id) el.dataset.page = id;
      else delete el.dataset.page;
    }
  }

  let enterPulseTimer = null;
  /** 순위 10행 스태거(~0.13s×9) + piece-in 길이보다 길어야 함 — 짧으면 뒤쪽 행이 한꺼번에 붙음 */
  const HOLO_ENTER_MS = 2200;

  /** 페이지 전환 시 박스 전체 지지직 + 조각 등장 */
  function pulseEnter() {
    const frame = document.getElementById("credits-holo-frame");
    if (!frame) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
    frame.classList.remove("is-entering");
    void frame.offsetWidth;
    frame.classList.add("is-entering");
    if (enterPulseTimer) clearTimeout(enterPulseTimer);
    enterPulseTimer = setTimeout(() => {
      frame.classList.remove("is-entering");
      enterPulseTimer = null;
    }, HOLO_ENTER_MS);
  }

  function applyShell(themeId) {
    const meta = themeMeta(themeId);
    const body = document.body;
    const nb = document.querySelector(".notebook");
    const holo = document.getElementById("credits-holo");
    const frame = document.getElementById("credits-holo-frame");
    const design = document.querySelector(".credits-holo__design");
    if (!meta) {
      body?.classList.remove("is-holo-theme");
      document.documentElement?.classList.remove("is-holo-theme");
      body?.removeAttribute("data-credits-theme");
      if (nb) nb.hidden = false;
      if (holo) holo.hidden = true;
      if (design) delete design.dataset.theme;
      return document.getElementById("credits-slides");
    }
    body?.classList.add("is-holo-theme");
    document.documentElement?.classList.add("is-holo-theme");
    body?.setAttribute("data-credits-theme", themeId);
    if (nb) nb.hidden = true;
    if (holo) holo.hidden = false;
    if (design) design.dataset.theme = themeId;
    if (frame) {
      frame.dataset.theme = themeId;
      frame.classList.add("frame", "is-on");
      frame.classList.toggle("frame--float", Boolean(meta.float));
    }
    return document.getElementById("credits-holo-slides") || document.getElementById("credits-slides");
  }

  window.EndingHologram = {
    THEMES,
    isHologramTheme,
    themeMeta,
    renderSlideHtml,
    applyShell,
    setActivePage,
    pulseEnter,
  };
})();
