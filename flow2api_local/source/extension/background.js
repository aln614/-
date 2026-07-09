let ws = null;
let reconnectTimeout = null;
let heartbeatInterval = null;
let lastSessionRefreshAt = 0;

const DEFAULT_SETTINGS = {
    serverUrl: "ws://127.0.0.1:38000/captcha_ws",
    apiKey: "tengying",
    routeKey: "",
    clientLabel: ""
};

function getSettings() {
    return new Promise((resolve) => {
        chrome.storage.local.get(DEFAULT_SETTINGS, (stored) => {
            const storedServerUrl = (stored.serverUrl || DEFAULT_SETTINGS.serverUrl).trim();
            resolve({
                serverUrl: storedServerUrl === "ws://127.0.0.1:8000/captcha_ws"
                    ? DEFAULT_SETTINGS.serverUrl
                    : storedServerUrl,
                apiKey: (stored.apiKey || DEFAULT_SETTINGS.apiKey || "").trim(),
                routeKey: (stored.routeKey || "").trim(),
                clientLabel: (stored.clientLabel || "").trim()
            });
        });
    });
}

function closeSocket() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
    if (ws) {
        try {
            ws.close();
        } catch (e) {
            console.log("[Flow2API] Close socket error", e);
        }
        ws = null;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getCookieAll(details) {
    return new Promise((resolve) => {
        if (!chrome.cookies || !chrome.cookies.getAll) {
            resolve([]);
            return;
        }
        chrome.cookies.getAll(details, (cookies) => {
            if (chrome.runtime.lastError) {
                console.log("[Flow2API] Cookie read failed:", chrome.runtime.lastError.message);
                resolve([]);
                return;
            }
            resolve(cookies || []);
        });
    });
}

function queryTabs(queryInfo) {
    return new Promise((resolve) => {
        try {
            chrome.tabs.query(queryInfo, (tabs) => {
                if (chrome.runtime.lastError) {
                    console.log("[Flow2API] tabs.query failed:", chrome.runtime.lastError.message);
                    resolve([]);
                    return;
                }
                resolve(tabs || []);
            });
        } catch (err) {
            console.log("[Flow2API] tabs.query exception:", err && err.message ? err.message : err);
            resolve([]);
        }
    });
}

function createTab(createProperties) {
    return new Promise((resolve) => {
        try {
            chrome.tabs.create(createProperties, (tab) => {
                if (chrome.runtime.lastError) {
                    console.log("[Flow2API] tabs.create failed:", chrome.runtime.lastError.message);
                    resolve(null);
                    return;
                }
                resolve(tab || null);
            });
        } catch (err) {
            console.log("[Flow2API] tabs.create exception:", err && err.message ? err.message : err);
            resolve(null);
        }
    });
}

function reloadTab(tabId) {
    return new Promise((resolve) => {
        try {
            chrome.tabs.reload(tabId, () => {
                if (chrome.runtime.lastError) {
                    console.log("[Flow2API] tabs.reload failed:", chrome.runtime.lastError.message);
                }
                resolve();
            });
        } catch (err) {
            console.log("[Flow2API] tabs.reload exception:", err && err.message ? err.message : err);
            resolve();
        }
    });
}

function getTab(tabId) {
    return new Promise((resolve) => {
        try {
            chrome.tabs.get(tabId, (tab) => {
                if (chrome.runtime.lastError) {
                    resolve(null);
                    return;
                }
                resolve(tab || null);
            });
        } catch (err) {
            resolve(null);
        }
    });
}

function removeTab(tabId) {
    return new Promise((resolve) => {
        try {
            chrome.tabs.remove(tabId, () => {
                if (chrome.runtime.lastError) {
                    console.log("[Flow2API] tabs.remove failed:", chrome.runtime.lastError.message);
                }
                resolve();
            });
        } catch (err) {
            console.log("[Flow2API] tabs.remove exception:", err && err.message ? err.message : err);
            resolve();
        }
    });
}

async function syncSessionToken(settings) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const cookieSets = await Promise.all([
        getCookieAll({ url: "https://labs.google/" }),
        getCookieAll({ domain: "labs.google" }),
        getCookieAll({ domain: ".labs.google" })
    ]);
    const cookies = cookieSets.flat();
    const seen = new Set();
    const uniqueCookies = cookies.filter((cookie) => {
        const key = `${cookie.domain}|${cookie.path}|${cookie.name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    const sessionCandidates = [];
    const chunkGroups = new Map();
    uniqueCookies.forEach((cookie) => {
        const name = String(cookie.name || "");
        if (!/(next-auth|authjs)\.session-token/i.test(name)) return;
        const chunkMatch = name.match(/^(.*?session-token)\.(\d+)$/i);
        if (chunkMatch) {
            const base = `${cookie.domain}|${cookie.path}|${chunkMatch[1]}`;
            if (!chunkGroups.has(base)) chunkGroups.set(base, []);
            chunkGroups.get(base).push({ index: Number(chunkMatch[2]), cookie });
            return;
        }
        if (cookie.value) {
            sessionCandidates.push({
                name,
                value: cookie.value,
                length: cookie.value.length
            });
        }
    });
    chunkGroups.forEach((chunks) => {
        const sorted = chunks
            .filter(item => item.cookie && item.cookie.value)
            .sort((a, b) => a.index - b.index);
        if (!sorted.length) return;
        const value = sorted.map(item => item.cookie.value).join("");
        sessionCandidates.push({
            name: sorted[0].cookie.name.replace(/\.\d+$/i, ".*"),
            value,
            length: value.length
        });
    });
    sessionCandidates.sort((a, b) => b.length - a.length);
    const sessionCookie = sessionCandidates[0];
    if (!sessionCookie || !sessionCookie.value) {
        console.log("[Flow2API] No Google Labs session token cookie found.");
        return;
    }
    console.log("[Flow2API] Syncing Google Labs session cookie:", sessionCookie.name, "len=", sessionCookie.length);
    ws.send(JSON.stringify({
        type: "sync_session",
        st: sessionCookie.value,
        cookie_name: sessionCookie.name,
        route_key: settings.routeKey,
        client_label: settings.clientLabel
    }));
}

async function refreshFlowTabsAndSync(settings) {
    const now = Date.now();
    if (now - lastSessionRefreshAt < 45000) return;
    lastSessionRefreshAt = now;
    try {
        const flowTabs = await queryTabs({ url: ["https://labs.google/fx/tools/flow*"] });
        let tab = flowTabs.sort((a, b) => Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0))[0];
        if (tab && tab.id) {
            console.log("[Flow2API] Refreshing Google Flow tab to renew session cookie:", tab.url);
            await reloadTab(tab.id);
            await waitForTabReady(tab.id, 18000);
            await sleep(2500);
        } else {
            console.log("[Flow2API] Opening Google Flow tab to renew session cookie.");
            tab = await createTab({ url: "https://labs.google/fx/tools/flow", active: false });
            if (tab && tab.id) {
                await waitForTabReady(tab.id, 18000);
                await sleep(2500);
            }
        }
        await syncSessionToken(settings);
    } catch (err) {
        console.log("[Flow2API] Flow tab refresh/session retry failed:", err);
    }
}

function waitForTabReady(tabId, timeoutMs = 12000) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            chrome.tabs.onUpdated.removeListener(onUpdated);
            clearTimeout(timer);
            resolve();
        };
        const onUpdated = (updatedTabId, changeInfo) => {
            if (updatedTabId === tabId && changeInfo.status === "complete") {
                finish();
            }
        };
        const timer = setTimeout(finish, timeoutMs);

        chrome.tabs.onUpdated.addListener(onUpdated);
        getTab(tabId).then((tab) => {
            if (tab && tab.status === "complete") {
                finish();
            }
        });
    });
}

async function connectWS() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    const settings = await getSettings();
    let url;
    try {
        url = new URL(settings.serverUrl || DEFAULT_SETTINGS.serverUrl);
    } catch (err) {
        console.log("[Flow2API] Invalid serverUrl, falling back to default:", settings.serverUrl);
        url = new URL(DEFAULT_SETTINGS.serverUrl);
    }
    if (settings.apiKey) {
        url.searchParams.set("key", settings.apiKey);
    }
    if (settings.routeKey) {
        url.searchParams.set("route_key", settings.routeKey);
    }
    if (settings.clientLabel) {
        url.searchParams.set("client_label", settings.clientLabel);
    }

    ws = new WebSocket(url.toString());

    ws.onopen = () => {
        console.log("[Flow2API] Background connected to WebSocket", url.toString());
        ws.send(JSON.stringify({
            type: "register",
            route_key: settings.routeKey,
            client_label: settings.clientLabel
        }));
        syncSessionToken(settings).catch(err => {
            console.log("[Flow2API] Session sync failed:", err);
        });
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "ping" }));
            }
        }, 20000);
    };

    let tokenQueue = Promise.resolve();

    ws.onmessage = async (event) => {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (e) {
            return;
        }

        if (data.type === "register_ack") {
            console.log("[Flow2API] Registered route key:", data.route_key || "(empty)");
            syncSessionToken(settings).catch(err => {
                console.log("[Flow2API] Session sync after register failed:", err);
            });
            return;
        }

        if (data.type === "sync_session_ack") {
            if (data.ok) {
                console.log("[Flow2API] Google Labs session synced:", data.email || "(unknown)");
            } else {
                console.log("[Flow2API] Google Labs session sync rejected:", data.error || "unknown error");
                if (/ACCESS_TOKEN_REFRESH_NEEDED|expired/i.test(String(data.error || ""))) {
                    refreshFlowTabsAndSync(settings).catch(err => {
                        console.log("[Flow2API] Session refresh retry failed:", err);
                    });
                }
            }
            return;
        }

        if (data.type === "get_token") {
            tokenQueue = tokenQueue.then(() => handleGetToken(data)).catch(err => {
                console.error("[Flow2API] Queue Error:", err);
            });
        }
    };

    ws.onclose = () => {
        console.log("[Flow2API] WebSocket Closed. Reconnecting in 2s...");
        ws = null;
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(connectWS, 2000);
    };

    ws.onerror = (e) => {
        console.log("[Flow2API] WebSocket Error", e);
    };
}

async function handleGetToken(data) {
    let newTabId = null;
    try {
        const projectNeedle = data.project_id ? `/project/${data.project_id}` : "";
        const flowTabs = await queryTabs({ url: ["https://labs.google/fx/tools/flow*"] });
        const matchingTab = flowTabs.find(tab => projectNeedle && String(tab.url || "").includes(projectNeedle));
        const activeTab = flowTabs.find(tab => tab.active);
        const recentTab = flowTabs.sort((a, b) => Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0))[0];
        let tokenTab = matchingTab || activeTab || recentTab;

        if (!tokenTab) {
            console.log("[Flow2API] No existing Flow tab found; opening project page...");
            const projectUrl = data.project_id
                ? `https://labs.google/fx/tools/flow/project/${data.project_id}`
                : "https://labs.google/fx/tools/flow";
            tokenTab = await createTab({ url: projectUrl, active: false });
            if (!tokenTab || !tokenTab.id) {
                throw new Error("Failed to open Google Flow tab.");
            }
            newTabId = tokenTab.id;
            await waitForTabReady(newTabId);
            await sleep(1200);
        } else {
            console.log("[Flow2API] Reusing signed-in Flow tab:", tokenTab.url);
        }

        const tokenTabId = tokenTab.id;

        let successResponse = null;
        let lastErrorMsg = "No response from tab.";
        const scriptTimeoutMs = data.action === "VIDEO_GENERATION" ? 30000 : 20000;

        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: tokenTabId },
                world: "MAIN",
                func: async (action, timeoutMs) => {
                    return new Promise((resolve, reject) => {
                        let settled = false;
                        const finish = (fn, value) => {
                            if (settled) return;
                            settled = true;
                            fn(value);
                        };
                        try {
                            function run() {
                                grecaptcha.enterprise.ready(function() {
                                    grecaptcha.enterprise.execute("6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV", { action: action })
                                        .then(token => finish(resolve, token))
                                        .catch(err => finish(reject, err.message || "reCAPTCHA evaluation failed internally"));
                                });
                            }

                            if (typeof grecaptcha !== "undefined" && grecaptcha.enterprise) {
                                run();
                            } else {
                                const s = document.createElement("script");
                                s.src = "https://www.google.com/recaptcha/enterprise.js?render=6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV";
                                s.onload = run;
                                s.onerror = () => finish(reject, "Failed to load enterprise.js via network");
                                document.head.appendChild(s);
                            }

                            setTimeout(() => finish(reject, "Timeout generating reCAPTCHA locally"), timeoutMs);
                        } catch (e) {
                            finish(reject, e.message);
                        }
                    });
                },
                args: [data.action || "IMAGE_GENERATION", scriptTimeoutMs]
            });

            if (results && results[0] && results[0].result) {
                successResponse = { status: "success", token: results[0].result };
            }
        } catch (e) {
            lastErrorMsg = e.message || "Script execution failed";
        }

        if (successResponse) {
            ws.send(JSON.stringify({
                req_id: data.req_id,
                status: successResponse.status,
                token: successResponse.token
            }));
        } else {
            ws.send(JSON.stringify({
                req_id: data.req_id,
                status: "error",
                error: "Extension script failed: " + lastErrorMsg
            }));
        }
    } catch (err) {
        ws.send(JSON.stringify({
            req_id: data.req_id,
            status: "error",
            error: err.message
        }));
    } finally {
        if (newTabId) {
            try {
                await removeTab(newTabId);
                console.log("[Flow2API] Closed temporary token tab.");
            } catch (e) {
                console.log("[Flow2API] Error closing tab:", e);
            }
        }
    }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.routeKey || changes.serverUrl || changes.apiKey || changes.clientLabel) {
        console.log("[Flow2API] Extension settings changed, reconnecting WebSocket...");
        closeSocket();
        connectWS().catch(err => console.log("[Flow2API] reconnect failed:", err));
    }
});

chrome.runtime.onInstalled.addListener(() => {
    connectWS().catch(err => console.log("[Flow2API] onInstalled connect failed:", err));
    chrome.alarms.create("flow2api_keepalive", { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
    connectWS().catch(err => console.log("[Flow2API] onStartup connect failed:", err));
    chrome.alarms.create("flow2api_keepalive", { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === "flow2api_keepalive") {
        connectWS().catch(err => console.log("[Flow2API] keepalive connect failed:", err));
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "flow2api_connect") return false;
    connectWS()
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
    return true;
});

chrome.alarms.create("flow2api_keepalive", { periodInMinutes: 1 });
connectWS().catch(err => console.log("[Flow2API] initial connect failed:", err));
