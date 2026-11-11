// 서비스 워커: 콘텐츠 스크립트 주입 + OpenAI API 호출 담당
// (API 호출을 여기서 하는 이유: 페이지의 CORS/CSP 영향을 받지 않고, API 키가 페이지에 노출되지 않음)

async function injectPicker(tabId) {
  await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== "start-picker") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) injectPicker(tab.id).catch(console.error);
});

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["record_selector", "fields"],
  properties: {
    record_selector: {
      type: "string",
      description: "반복되는 레코드(카드/행) 하나를 가리키는 CSS 셀렉터. 현재 셀렉터가 적절하면 빈 문자열."
    },
    fields: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "source_keys", "type"],
        properties: {
          name: { type: "string", description: "사람이 읽기 좋은 필드 이름 (사용자 언어)" },
          source_keys: { type: "array", items: { type: "string" }, description: "원본 키 목록(여러 개면 공백으로 합침)" },
          type: { type: "string", enum: ["text", "number", "url", "date"] }
        }
      }
    }
  }
};

async function callOpenAI(payload) {
  const { apiKey, model } = await chrome.storage.local.get(["apiKey", "model"]);
  if (!apiKey) throw new Error("OpenAI API 키가 없습니다. 확장 프로그램 아이콘 → 설정에서 입력하세요.");

  const system = [
    "너는 웹 스크래핑 도우미다. 사용자가 웹페이지에서 클릭한 요소와 같은 구조로 반복되는 레코드를 수집했다.",
    "원본 레코드는 '구조 경로 → 값' 형태의 키를 가진다. 이 키들을 의미 있는 필드로 묶고 이름을 붙여라.",
    "- 광고·버튼 문구·아이콘 텍스트 등 의미 없는 키는 제외한다.",
    "- source_keys에는 반드시 제공된 원본 키만 그대로 쓴다.",
    "- 필드 이름은 한국어로 짧게. 사용자 요청 필드가 있으면 그에 맞춘다.",
    "- 제공된 HTML을 보고 현재 레코드 셀렉터가 레코드 일부만 잡거나 너무 넓으면 더 나은 CSS 셀렉터를 record_selector에 제안하고, 적절하면 빈 문자열을 넣어라.",
    payload.lockSelector ? "- 이번에는 셀렉터가 확정되었으므로 record_selector는 빈 문자열로 둔다." : ""
  ].join("\n");

  const user = JSON.stringify({
    page: { url: payload.url, title: payload.title },
    user_request: payload.hint || "(없음)",
    current_record_selector: payload.selector,
    record_count: payload.count,
    raw_keys: payload.keys,
    sample_records: payload.samples,
    record_html_sample: payload.html
  });

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || "gpt-4o-mini",
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      response_format: { type: "json_schema", json_schema: { name: "extraction_plan", strict: true, schema: SCHEMA } }
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `OpenAI 오류 (HTTP ${res.status})`);
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI 응답이 비어 있습니다.");
  return JSON.parse(content);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "inject") {
    injectPicker(msg.tabId).then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type === "ai") {
    callOpenAI(msg.payload).then((plan) => sendResponse({ ok: true, plan }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // 비동기 응답
  }
});
