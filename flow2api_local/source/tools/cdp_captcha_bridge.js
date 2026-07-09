#!/usr/bin/env node
"use strict";

const http = require("http");

const FLOW2API_WS = process.env.FLOW2API_WS || "ws://127.0.0.1:38000/captcha_ws";
const FLOW2API_KEY = process.env.FLOW2API_KEY || "tengying";
const CHROME_CDP = (process.env.CHROME_CDP || "http://127.0.0.1:9235").replace(/\/$/, "");
const ROUTE_KEY = process.env.FLOW2API_ROUTE_KEY || "";
const CLIENT_LABEL = process.env.FLOW2API_CLIENT_LABEL || "cdp-bridge";
const RECAPTCHA_SITE_KEY = process.env.FLOW2API_RECAPTCHA_SITE_KEY || "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`Invalid JSON from ${url}: ${err.message}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => {
      req.destroy(new Error(`Timeout requesting ${url}`));
    });
  });
}

function openCdpTarget(url) {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(url);
    const req = http.request(`${CHROME_CDP}/json/new?${encoded}`, { method: "PUT" }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`Invalid CDP new target response: ${err.message}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => {
      req.destroy(new Error("Timeout opening Chrome target"));
    });
    req.end();
  });
}

async function withCdp(webSocketDebuggerUrl, fn) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();

  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  };

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("Failed to connect Chrome DevTools target"));
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }
    }, 20000);
  });

  try {
    return await fn(send);
  } finally {
    try { ws.close(); } catch (_) {}
  }
}

async function findFlowTarget(projectId) {
  const targets = await getJson(`${CHROME_CDP}/json/list`);
  const pages = targets.filter(target => target.type === "page");
  const projectNeedle = projectId ? `/project/${projectId}` : "";
  let target = pages.find(page => projectNeedle && String(page.url || "").includes(projectNeedle));
  if (!target) {
    target = pages.find(page => String(page.url || "").startsWith("https://labs.google/fx/tools/flow"));
  }
  if (!target) {
    const url = projectId
      ? `https://labs.google/fx/tools/flow/project/${projectId}`
      : "https://labs.google/fx/tools/flow";
    target = await openCdpTarget(url);
    await sleep(4500);
  }
  if (!target || !target.webSocketDebuggerUrl) {
    throw new Error("No Google Flow tab found in Chrome CDP.");
  }
  return target;
}

async function getLabsSessionCookie(target) {
  return await withCdp(target.webSocketDebuggerUrl, async send => {
    await send("Network.enable").catch(() => null);
    const response = await send("Network.getCookies", { urls: ["https://labs.google/"] });
    const cookies = (response.result && response.result.cookies) || [];
    const direct = [];
    const chunks = new Map();
    for (const cookie of cookies) {
      const name = String(cookie.name || "");
      if (!/(next-auth|authjs)\.session-token/i.test(name)) continue;
      const chunkMatch = name.match(/^(.*?session-token)\.(\d+)$/i);
      if (chunkMatch) {
        const key = `${cookie.domain}|${cookie.path}|${chunkMatch[1]}`;
        if (!chunks.has(key)) chunks.set(key, []);
        chunks.get(key).push({ index: Number(chunkMatch[2]), cookie });
      } else if (cookie.value) {
        direct.push({ name, value: cookie.value, length: cookie.value.length });
      }
    }
    for (const group of chunks.values()) {
      const sorted = group.filter(item => item.cookie && item.cookie.value).sort((a, b) => a.index - b.index);
      if (sorted.length) {
        const value = sorted.map(item => item.cookie.value).join("");
        direct.push({ name: sorted[0].cookie.name.replace(/\.\d+$/i, ".*"), value, length: value.length });
      }
    }
    direct.sort((a, b) => b.length - a.length);
    return direct[0] || null;
  });
}

async function syncSession(serverWs, projectId) {
  try {
    const target = await findFlowTarget(projectId);
    const session = await getLabsSessionCookie(target);
    if (!session || !session.value) {
      console.log("[CDP Bridge] No Google Labs session cookie found.");
      return;
    }
    console.log(`[CDP Bridge] Syncing Google Labs session cookie ${session.name}, len=${session.length}`);
    serverWs.send(JSON.stringify({
      type: "sync_session",
      st: session.value,
      cookie_name: session.name,
      route_key: ROUTE_KEY,
      client_label: CLIENT_LABEL
    }));
  } catch (err) {
    console.log("[CDP Bridge] Session sync failed:", err.message);
  }
}

async function mintRecaptchaToken(projectId, action) {
  const target = await findFlowTarget(projectId);
  return await withCdp(target.webSocketDebuggerUrl, async send => {
    await send("Runtime.enable");
    const expression = `
      new Promise((resolve, reject) => {
        let settled = false;
        const done = (fn, value) => {
          if (settled) return;
          settled = true;
          fn(value);
        };
        function run() {
          grecaptcha.enterprise.ready(function() {
            grecaptcha.enterprise.execute(${JSON.stringify(RECAPTCHA_SITE_KEY)}, { action: ${JSON.stringify(action || "IMAGE_GENERATION")} })
              .then(token => done(resolve, token))
              .catch(err => done(reject, err && err.message ? err.message : "reCAPTCHA evaluation failed"));
          });
        }
        try {
          if (typeof grecaptcha !== "undefined" && grecaptcha.enterprise) {
            run();
          } else {
            const script = document.createElement("script");
            script.src = "https://www.google.com/recaptcha/enterprise.js?render=${RECAPTCHA_SITE_KEY}";
            script.onload = run;
            script.onerror = () => done(reject, "Failed to load enterprise.js");
            document.head.appendChild(script);
          }
          setTimeout(() => done(reject, "Timeout generating reCAPTCHA locally"), 30000);
        } catch (err) {
          done(reject, err && err.message ? err.message : String(err));
        }
      })
    `;
    const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.text || "Chrome runtime exception");
    }
    const result = response.result && response.result.result;
    if (!result || !result.value) {
      throw new Error("Chrome did not return a reCAPTCHA token.");
    }
    return result.value;
  });
}

function connectServer() {
  const url = new URL(FLOW2API_WS);
  if (FLOW2API_KEY) url.searchParams.set("key", FLOW2API_KEY);
  if (ROUTE_KEY) url.searchParams.set("route_key", ROUTE_KEY);
  if (CLIENT_LABEL) url.searchParams.set("client_label", CLIENT_LABEL);

  const ws = new WebSocket(url.toString());

  ws.onopen = () => {
    console.log(`[CDP Bridge] Connected to ${url.toString()} using Chrome ${CHROME_CDP}`);
    ws.send(JSON.stringify({ type: "register", route_key: ROUTE_KEY, client_label: CLIENT_LABEL }));
    syncSession(ws).catch(err => console.log("[CDP Bridge] Initial sync failed:", err.message));
  };

  ws.onmessage = async event => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (_) {
      return;
    }
    if (data.type === "register_ack") {
      console.log(`[CDP Bridge] Registered route_key=${data.route_key || "-"} label=${data.client_label || "-"}`);
      return;
    }
    if (data.type === "sync_session_ack") {
      console.log(`[CDP Bridge] Session sync ok=${Boolean(data.ok)} email=${data.email || "-"} error=${data.error || "-"}`);
      return;
    }
    if (data.type !== "get_token" || !data.req_id) return;

    try {
      console.log(`[CDP Bridge] Minting token action=${data.action || "IMAGE_GENERATION"} project=${data.project_id || "-"}`);
      const token = await mintRecaptchaToken(data.project_id, data.action || "IMAGE_GENERATION");
      ws.send(JSON.stringify({ req_id: data.req_id, status: "success", token }));
    } catch (err) {
      ws.send(JSON.stringify({ req_id: data.req_id, status: "error", error: err.message }));
    }
  };

  ws.onclose = () => {
    console.log("[CDP Bridge] Server connection closed; reconnecting in 2s...");
    setTimeout(connectServer, 2000);
  };

  ws.onerror = event => {
    console.log("[CDP Bridge] Server WebSocket error", event && event.message ? event.message : "");
  };
}

connectServer();
