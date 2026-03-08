// ==UserScript==
// @name         AI Studio Chat Compressor
// @namespace    https://lxchx.github.io/aistudio-compressor
// @version      0.3.2
// @description  在 Google AI Studio 提供一键压缩聊天记录、注入快照、监控 GenerateContent 请求的工具，方便长对话续写与历史迁移 | Provides a one-click tool in Google AI Studio to compress chat history, inject snapshots, and monitor GenerateContent requests, facilitating long conversation continuation and history migration
// @author       lxchx
// @match        https://aistudio.google.com/prompts/*
// @match        https://aistudio.google.com/prompts/new_chat
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    "use strict";

    // ---------------------------
    // Constants & environment
    // ---------------------------

    const Config = {
        TAGS: {
            UI: "[Compressor UI]",
            NET: "[Compressor Monitor]"
        },
        TARGETS: {
            GENERATE: "/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent",
            RESOLVE: "/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ResolveDriveResource",
            CREATE_PROMPT: "/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/CreatePrompt"
        },
        NETWORK: {
            RPC_ORIGIN: "https://alkalimakersuite-pa.clients6.google.com"
        },
        EVENTS: {
            REQUEST: "aistudio-compressor:generatecontent-request",
            RESPONSE: "aistudio-compressor:generatecontent-response"
        },
        UI: {
            BUTTON_ID: "compressor-button-hybrid",
            TOOLBAR_SELECTORS: [
                "ms-toolbar .toolbar-right",
                "ms-playground-toolbar .toolbar-right",
                "ms-playground-toolbar .toolbar-container .toolbar-right",
                ".toolbar-right"
            ],
            TARGET_PATH: "/prompts/",
            INPUT_SELECTORS: [
                "ms-autosize-textarea textarea",
                'textarea[aria-label="Start typing a prompt"]',
                "textarea"
            ],
            SEND_BUTTON_SELECTORS: [
                "ms-run-button button",
                "ms-run-button button.run-button",
                'button[aria-label="Run"]',
                'button[aria-label^="Run"]',
                'button[description*="Send prompt"]',
                'button[aria-label*="keyboard_return"]',
                'button[type="submit"]'
            ]
        },
        SETTINGS: {
            PAGE_URL: "https://lxchx.github.io/aistudio-compressor"
        },
        PROMPTS: {
            FULL: `That concludes the above topic. Please remember the chat history and switch roles:
            
  You are the component that summarizes internal chat history into a given structure.

  When the conversation history grows too large, you will be invoked to distill the entire history into a concise, structured
  XML snapshot. This snapshot is CRITICAL, as it will become the agent's *only* memory of the past. The agent will resume its
  work based solely on this snapshot. All crucial details, plans, errors, and user directives MUST be preserved.

  First, you will think through the entire history in a private <scratchpad>. Review the user's overall goal, the agent's
  actions, tool outputs, file modifications, and any unresolved questions. Identify every piece of information that is essential
  for future actions.

  After your reasoning is complete, generate the final <state_snapshot> XML object. Be incredibly dense with information. Omit
  any irrelevant conversational filler.

  The structure MUST be as follows:

  <state_snapshot>
      <overall_goal>
          <!-- A single, concise sentence describing the user's high-level objective. -->
          <!-- Example: "Refactor the authentication service to use a new JWT library." -->
      </overall_goal>

      <key_knowledge>
          <!-- Crucial facts, conventions, and constraints the agent must remember based on the conversation history and
  interaction with the user. Use bullet points. -->
          <!-- Example:
           - Build Command: \`npm run build\`
           - Testing: Tests are run with \`npm test\`. Test files must end in \`.test.ts\`.
           - API Endpoint: The primary API endpoint is \`https://api.example.com/v2\`.

          -->
      </key_knowledge>

      <file_system_state>
          <!-- List files that have been created, read, modified, or deleted. Note their status and critical learnings. -->
          <!-- Example:
           - CWD: \`/home/user/project/src\`
           - READ: \`package.json\` - Confirmed 'axios' is a dependency.
           - MODIFIED: \`services/auth.ts\` - Replaced 'jsonwebtoken' with 'jose'.
           - CREATED: \`tests/new-feature.test.ts\` - Initial test structure for the new feature.
          -->
      </file_system_state>

      <recent_actions>
          <!-- A summary of the last few significant agent actions and their outcomes. Focus on facts. -->
          <!-- Example:
           - Ran \`grep 'old_function'\` which returned 3 results in 2 files.
           - Ran \`npm run test\`, which failed due to a snapshot mismatch in \`UserProfile.test.ts\`.
           - Ran \`ls -F static/\` and discovered image assets are stored as \`.webp\`.
          -->
      </recent_actions>

      <current_plan>
          <!-- The agent's step-by-step plan. Mark completed steps. -->
          <!-- Example:
           1. [DONE] Identify all files using the deprecated 'UserAPI'.
           2. [IN PROGRESS] Refactor \`src/components/UserProfile.tsx\` to use the new 'ProfileAPI'.
           3. [TODO] Refactor the remaining files.
           4. [TODO] Update tests to reflect the API change.
          -->
      </current_plan>
  </state_snapshot>`,
            SNIPPET: "You are the component that summarizes internal chat history"
        }
    };

    const env = {
        isMac: /Mac|iPhone|iPad/.test(navigator.platform),
        isAppContext: location.pathname.startsWith("/app/"),
        topWindow: unsafeWindow?.top || window
    };
    const settingsOrigin = getSettingsOrigin();
    const SCRIPT_VERSION = "0.3.2";

    const state = {
        compressionInProgress: false,
        compressionRequestPending: false,
        compressionResponsePending: false,
        lastPromptHistory: null,
        lastPromptHistoryUpdatedAt: 0,
        lastResolvedPromptThread: null,
        lastResolvedPromptRoot: null,
        lastResolvedPromptId: null,
        lastResolvedPromptUpdatedAt: 0,
        googleApiKey: "",
        googleApiKeyUpdatedAt: 0,
        pendingBranchTurns: null,
        historyCapturePending: false,
        branchInProgress: false,
        activeCompressionPrompt: "",
        activeCompressionSnippet: Config.PROMPTS.SNIPPET
    };

    const log = {
        ui: (...args) => console.log(Config.TAGS.UI, ...args),
        net: (...args) => console.log(Config.TAGS.NET, ...args)
    };

    const STORAGE_KEY = "__aistudio_compressor_settings_v1";
    const DEFAULT_SETTINGS = {
        compressPrompt: Config.PROMPTS.FULL,
        snapshotRegex: "",
        tailPercent: 30,
        tailMinChars: 2000
    };
    let userSettings = loadUserSettings();
    refreshActivePromptFromSettings();

    function loadUserSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) {
                return { ...DEFAULT_SETTINGS };
            }
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") {
                return { ...DEFAULT_SETTINGS, ...parsed };
            }
            return { ...DEFAULT_SETTINGS };
        } catch (err) {
            console.warn(Config.TAGS.NET, "Failed to load compressor settings", err);
            return { ...DEFAULT_SETTINGS };
        }
    }

    function persistUserSettings() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(userSettings));
        } catch (err) {
            console.warn(Config.TAGS.NET, "Failed to store compressor settings", err);
        }
    }

    function updateUserSettings(partial) {
        userSettings = { ...userSettings, ...partial };
        persistUserSettings();
    }

    function getCompressPrompt() {
        return userSettings?.compressPrompt || Config.PROMPTS.FULL;
    }

    function getSnapshotRegex() {
        return (userSettings?.snapshotRegex || "").trim();
    }

    function getTailRetentionConfig() {
        const percent = Number(userSettings?.tailPercent);
        const minChars = Number(userSettings?.tailMinChars);
        const normalizedPercent = Number.isFinite(percent) ? Math.min(Math.max(percent, 0), 100) : DEFAULT_SETTINGS.tailPercent;
        const normalizedMinChars = Number.isFinite(minChars) && minChars > 0 ? Math.floor(minChars) : DEFAULT_SETTINGS.tailMinChars;
        return { percent: normalizedPercent, minChars: normalizedMinChars };
    }

    function deriveSnippet(prompt) {
        const text = (prompt || "").trim();
        if (!text) {
            return Config.PROMPTS.SNIPPET;
        }
        return text.slice(0, 120);
    }

    function refreshActivePromptFromSettings() {
        state.activeCompressionPrompt = getCompressPrompt();
        state.activeCompressionSnippet = deriveSnippet(state.activeCompressionPrompt);
    }

    function getSettingsOrigin() {
        const url = Config.SETTINGS?.PAGE_URL;
        if (!url) return null;
        try {
            return new URL(url, location.href).origin;
        } catch {
            return null;
        }
    }

    function getSettingsSnapshot() {
        return {
            compressPrompt: userSettings?.compressPrompt || Config.PROMPTS.FULL,
            snapshotRegex: userSettings?.snapshotRegex || "",
            tailPercent: Number.isFinite(userSettings?.tailPercent) ? userSettings.tailPercent : DEFAULT_SETTINGS.tailPercent,
            tailMinChars: Number.isFinite(userSettings?.tailMinChars) ? userSettings.tailMinChars : DEFAULT_SETTINGS.tailMinChars
        };
    }

    function normalizeSettingsPayload(payload) {
        if (!payload || typeof payload !== "object") {
            return { ...DEFAULT_SETTINGS };
        }
        const next = { ...DEFAULT_SETTINGS };
        if (typeof payload.compressPrompt === "string") {
            const trimmed = payload.compressPrompt.trim();
            next.compressPrompt = trimmed || Config.PROMPTS.FULL;
        }
        if (typeof payload.snapshotRegex === "string") {
            next.snapshotRegex = payload.snapshotRegex.trim();
        }
        if (payload.tailPercent != null) {
            const parsedPercent = Number(payload.tailPercent);
            if (Number.isFinite(parsedPercent)) {
                next.tailPercent = Math.min(Math.max(parsedPercent, 0), 100);
            }
        }
        if (payload.tailMinChars != null) {
            const parsedMinChars = Number(payload.tailMinChars);
            if (Number.isFinite(parsedMinChars) && parsedMinChars >= 0) {
                next.tailMinChars = Math.floor(parsedMinChars);
            }
        }
        return next;
    }

    function scheduleSettingsHydration(win) {
        if (!win) return;
        const targetOrigin = settingsOrigin || "*";
        const message = {
            source: "aistudio-compressor",
            type: "hydrate",
            payload: getSettingsSnapshot()
        };
        let attempts = 0;
        const maxAttempts = 10;
        let timer = null;

        const dispatch = () => {
            if (!win || win.closed) {
                clearInterval(timer);
                return;
            }
            attempts += 1;
            try {
                win.postMessage(message, targetOrigin);
                log.ui("Sent settings hydration message", { attempts });
            } catch (err) {
                log.ui("Failed to send settings hydration message", err);
            }
            if (attempts >= maxAttempts) {
                clearInterval(timer);
            }
        };

        dispatch();
        timer = setInterval(dispatch, 1200);
    }

    function installSettingsMessageBridge() {
        window.addEventListener("message", handleSettingsMessage);
    }

    function handleSettingsMessage(event) {
        if (!event || !event.data) return;
        if (settingsOrigin && event.origin !== settingsOrigin) {
            return;
        }
        const data = event.data;
        if (data?.source !== "aistudio-compressor") {
            return;
        }
        if (data.type === "update-settings" && data.payload) {
            const normalized = normalizeSettingsPayload(data.payload);
            updateUserSettings(normalized);
            if (!state.compressionInProgress) {
                refreshActivePromptFromSettings();
            }
            log.ui("Settings updated via external page");
        }
    }

    function openSettingsWindow() {
        const targetUrl = Config.SETTINGS?.PAGE_URL;
        if (!targetUrl) {
            alert("未配置外部设置页面 URL，请更新脚本以启用设置界面。");
            return;
        }
        const win = window.open(targetUrl, "aistudio_compressor_settings", "width=720,height=720,resizable=yes,scrollbars=yes");
        if (!win || win.closed) {
            alert("无法打开设置窗口，请允许弹窗或在目标标签页手动执行脚本设置。");
            return;
        }
        scheduleSettingsHydration(win);
    }

    function resetSettingsToDefault() {
        if (!confirm("确认恢复 Compressed Prompt 及相关设置为默认值？")) {
            return;
        }
        userSettings = { ...DEFAULT_SETTINGS };
        persistUserSettings();
        if (!state.compressionInProgress) {
            refreshActivePromptFromSettings();
        }
        alert("已恢复默认设置。");
    }

    function registerMenuCommands() {
        if (typeof GM_registerMenuCommand !== "function") {
            return;
        }
        GM_registerMenuCommand("打开 Compressor 设置...", openSettingsWindow);
        GM_registerMenuCommand("重置 Compressor 设置", resetSettingsToDefault);
    }

    // ---------------------------
    // Event bridge & handlers
    // ---------------------------

    function installTopLevelHandlers() {
        if (!env.topWindow.__aistudio_compressor_handlers_installed) {
            env.topWindow.addEventListener(Config.EVENTS.REQUEST, Compression.handleRequestEvent);
            env.topWindow.addEventListener(Config.EVENTS.RESPONSE, Compression.handleResponseEvent);
            env.topWindow.__aistudio_compressor_handlers_installed = true;
        }

        if (!env.topWindow.__aistudio_compressor_request_logger) {
            env.topWindow.addEventListener(Config.EVENTS.REQUEST, event => {
                const detail = event?.detail || {};
                log.net("GenerateContent request detail:", {
                    url: detail.url,
                    headers: detail.headers,
                    bodyText: detail.bodyText
                });
            });
            env.topWindow.__aistudio_compressor_request_logger = true;
        }
    }

    function emitNetworkEvent(name, detail) {
        try {
            env.topWindow.dispatchEvent(new CustomEvent(name, { detail }));
        } catch (err) {
            log.net("Failed to dispatch network event", name, err);
        }
    }

    // ---------------------------
    // Network monitor module
    // ---------------------------

    const NetworkMonitor = {
        init() {
            const label = env.isAppContext ? "app-window" : "top-window";
            hookContext(window, label);

            window.addEventListener("DOMContentLoaded", () => {
                hookContext(window, `${label} DOMContentLoaded`);
                hookChildFrames("DOMContentLoaded");
            });

            window.addEventListener("load", () => {
                hookContext(window, `${label} load`);
                hookChildFrames("load");
            });

            setInterval(() => hookChildFrames("poll"), 2000);
        }
    };

    function hookChildFrames(reason) {
        if (!document?.querySelectorAll) return;
        for (const frame of document.querySelectorAll("iframe")) {
            const ctx = frame.contentWindow;
            if (!ctx || !canAccessWindow(ctx)) continue;
            try {
                hookContext(ctx, `iframe ${frame.src || frame.name || "unnamed"} via ${reason}`);
            } catch (err) {
                log.net("cannot hook iframe:", err);
            }
        }
    }

    function hookContext(ctx, label) {
        if (!canAccessWindow(ctx)) {
            log.net(`skip hooking for ${label}: cross-origin window`);
            return;
        }
        installFetchHook(ctx, label);
        installXHRHook(ctx, label);
    }

    function canAccessWindow(ctx) {
        try {
            return ctx && ctx.location && ctx.location.origin === location.origin;
        } catch {
            return false;
        }
    }

    function installFetchHook(ctx, label) {
        if (!ctx || typeof ctx.fetch !== "function") {
            log.net(`skip hooking for ${label}: fetch not available`);
            return;
        }
        if (ctx.__aistudio_compressor_fetch_hooked) return;

        const originalFetch = ctx.fetch.bind(ctx);

        ctx.fetch = async function interceptFetch(input, init = {}) {
            const request = input instanceof Request ? input : new Request(input, init);
            const shouldLogGenerate = isTargetRequest(request.url, "GENERATE");
            const shouldCaptureResolve = isTargetRequest(request.url, "RESOLVE");

            if (shouldLogGenerate) {
                await logRequestPayload(request);
            }

            const response = await originalFetch(request);

            if (shouldLogGenerate || shouldCaptureResolve) {
                await logResponsePayload(request.url, response.clone());
            }

            return response;
        };

        ctx.__aistudio_compressor_fetch_hooked = true;
        log.net(`fetch hooked in ${label}`);

        if (ctx !== unsafeWindow && typeof unsafeWindow.fetch === "function" && !unsafeWindow.__aistudio_compressor_fetch_hooked) {
            unsafeWindow.fetch = ctx.fetch;
            unsafeWindow.__aistudio_compressor_fetch_hooked = true;
            log.net("fetch mirrored to unsafeWindow");
        }
    }

    async function logRequestPayload(request) {
        try {
            const clonedRequest = request.clone();
            const bodyText = await clonedRequest.text();
            const headers = Object.fromEntries(clonedRequest.headers.entries());
            rememberGoogleApiKey(headers, clonedRequest.url);
            console.groupCollapsed(`${Config.TAGS.NET} request -> ${clonedRequest.url}`);
            console.log("Headers:", headers);
            try {
                console.log("Parsed payload:", JSON.parse(bodyText));
            } catch {
                console.log("Raw payload:", bodyText);
            }
            console.groupEnd();
            emitNetworkEvent(Config.EVENTS.REQUEST, {
                url: clonedRequest.url,
                headers,
                bodyText
            });
        } catch (err) {
            console.warn(Config.TAGS.NET, "Failed to read request body:", err);
        }
    }

    async function logResponsePayload(url, response) {
        try {
            const bodyText = await response.text();
            const parsed = safeParseJSON(bodyText);
            maybeCaptureResolvedPromptThread(url, bodyText, parsed);
            console.groupCollapsed(`${Config.TAGS.NET} response <- ${url}`);
            console.log("Status:", response.status, response.statusText);
            if (isTargetRequest(url, "RESOLVE")) {
                console.log("Resolve response summary:", describeResolvedPromptCapture(extractResolvedPromptThread(parsed)));
            } else if (parsed) {
                console.log("Parsed response:", parsed);
            } else {
                console.log("Raw response:", bodyText);
            }
            console.groupEnd();
            emitNetworkEvent(Config.EVENTS.RESPONSE, {
                url,
                status: response.status,
                statusText: response.statusText,
                bodyText
            });
        } catch (err) {
            console.warn(Config.TAGS.NET, "Failed to read response body:", err);
        }
    }

    function installXHRHook(ctx, label) {
        if (!ctx || typeof ctx.XMLHttpRequest !== "function") {
            log.net(`skip hooking XHR for ${label}: XMLHttpRequest not available`);
            return;
        }
        if (ctx.__aistudio_compressor_xhr_hooked) return;

        const OriginalXHR = ctx.XMLHttpRequest;

        function WrappedXHR() {
            const realXHR = new OriginalXHR();
            let monitored = false;
            let requestUrl = null;
            const requestHeaders = {};

            const originalOpen = realXHR.open;
            realXHR.open = function (...args) {
                const [, url] = args;
                requestUrl = url || null;
                monitored = Boolean(url) && (isTargetRequest(url, "GENERATE") || isTargetRequest(url, "RESOLVE"));
                if (monitored) {
                    log.net("Monitored XHR detected in", label, url);
                }
                return originalOpen.apply(this, args);
            };

            const originalSetRequestHeader = realXHR.setRequestHeader;
            realXHR.setRequestHeader = function (name, value) {
                if (typeof name === "string") {
                    requestHeaders[name] = value;
                    rememberGoogleApiKey(requestHeaders, resolveUrl(requestUrl));
                }
                return originalSetRequestHeader.apply(this, arguments);
            };

            const originalSend = realXHR.send;
            realXHR.send = function (body) {
                if (monitored) {
                    const absoluteUrl = resolveUrl(requestUrl);
                    const bodyText = bodyToText(body);
                    const headers = Object.keys(requestHeaders).length ? { ...requestHeaders } : null;
                    rememberGoogleApiKey(headers, absoluteUrl);
                    console.groupCollapsed(`${Config.TAGS.NET} XHR request -> ${absoluteUrl}`);
                    console.log("Headers:", headers);
                    if (bodyText) {
                        try {
                            console.log("Parsed payload:", JSON.parse(bodyText));
                        } catch {
                            console.log("Raw payload:", bodyText);
                        }
                    } else {
                        console.log("Request body unavailable or non-text");
                    }
                    console.groupEnd();
                    emitNetworkEvent(Config.EVENTS.REQUEST, {
                        url: absoluteUrl,
                        headers,
                        bodyText
                    });
                }
                return originalSend.apply(this, arguments);
            };

            realXHR.addEventListener("readystatechange", function () {
                if (realXHR.readyState !== 4 || !monitored) {
                    return;
                }
                const responseUrl = realXHR.responseURL || resolveUrl(requestUrl);
                const parsed = safeParseJSON(realXHR.responseText);
                maybeCaptureResolvedPromptThread(responseUrl, realXHR.responseText, parsed);
                console.groupCollapsed(`${Config.TAGS.NET} XHR response <- ${responseUrl}`);
                console.log("Status:", realXHR.status, realXHR.statusText);
                if (isTargetRequest(responseUrl, "RESOLVE")) {
                    console.log("Resolve response summary:", describeResolvedPromptCapture(extractResolvedPromptThread(parsed)));
                } else if (parsed) {
                    console.log("Parsed response:", parsed);
                } else {
                    console.log("Raw response:", realXHR.responseText);
                }
                console.groupEnd();
                emitNetworkEvent(Config.EVENTS.RESPONSE, {
                    url: responseUrl,
                    status: realXHR.status,
                    statusText: realXHR.statusText,
                    bodyText: realXHR.responseText
                });
            });

            return realXHR;
        }

        ctx.XMLHttpRequest = WrappedXHR;
        ctx.__aistudio_compressor_xhr_hooked = true;
        log.net(`XMLHttpRequest hooked in ${label}`);

        if (ctx !== unsafeWindow && typeof unsafeWindow.XMLHttpRequest === "function" && !unsafeWindow.__aistudio_compressor_xhr_hooked) {
            unsafeWindow.XMLHttpRequest = WrappedXHR;
            unsafeWindow.__aistudio_compressor_xhr_hooked = true;
            log.net("XMLHttpRequest mirrored to unsafeWindow");
        }
    }

    function resolveUrl(init) {
        if (!init || typeof init !== "object") return undefined;
        return {
            body: cloneBody(init.body),
            cache: init.cache,
            credentials: init.credentials,
            headers: init.headers,
            integrity: init.integrity,
            keepalive: init.keepalive,
            method: init.method,
            mode: init.mode,
            redirect: init.redirect,
            referrer: init.referrer,
            referrerPolicy: init.referrerPolicy,
            signal: init.signal,
            window: init.window
        };
    }

    function resolveUrl(url) {
        if (!url) return "";
        try {
            return new URL(url, location.origin).toString();
        } catch {
            return url;
        }
    }

    function bodyToText(body) {
        if (!body) return null;
        if (typeof body === "string") return body;
        if (body instanceof ArrayBuffer) {
            try {
                return new TextDecoder().decode(body);
            } catch {
                return null;
            }
        }
        if (ArrayBuffer.isView(body)) {
            try {
                return new TextDecoder().decode(body.buffer);
            } catch {
                return null;
            }
        }
        return null;
    }

    function isTargetRequest(url, key = "GENERATE") {
        try {
            const parsed = new URL(url, location.origin);
            return parsed.pathname.endsWith(Config.TARGETS[key]);
        } catch {
            return false;
        }
    }

    // ---------------------------
    // Compression lifecycle
    // ---------------------------

    const Compression = {
        run() {
            if (state.compressionInProgress) {
                log.ui("Compression already running");
                return;
            }
            const textarea = UI.findInput();
            if (!textarea) {
                log.ui("Input box not found, cannot run compression");
                return;
            }
            const prompt = getCompressPrompt();
            Compression.prepareRunContext();
            state.activeCompressionPrompt = prompt;
            state.activeCompressionSnippet = deriveSnippet(prompt);
            state.compressionInProgress = true;
            state.compressionRequestPending = true;
            state.compressionResponsePending = false;
            UI.setButtonLoading(true);
            setTextareaValue(textarea, prompt);
            textarea.focus();
            textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: prompt, inputType: "insertText" }));
            textarea.dispatchEvent(new Event("change", { bubbles: true }));
            enableSendButton();
            sendCompressionRequest(textarea).then(sent => {
                if (sent) {
                    log.ui("Compression request sent");
                    return;
                }
                log.ui("Failed to trigger compression request; aborting this run");
                Compression.finalizeRun();
            });
        },

        prepareRunContext() {
            state.lastPromptHistory = null;
            state.lastPromptHistoryUpdatedAt = 0;
            state.pendingBranchTurns = null;
            state.historyCapturePending = true;
            state.compressionRequestPending = false;
            state.compressionResponsePending = false;
        },

        handleRequestEvent(event) {
            const detail = event?.detail;
            if (!detail?.bodyText) return;
            const isCompressionBody = Compression.isCompressionPrompt(detail.bodyText);

            if (!state.historyCapturePending && !state.compressionInProgress) {
                log.net("GenerateContent request observed outside compression run");
                return;
            }

            if (isCompressionBody && state.historyCapturePending) {
                state.historyCapturePending = false;
                const payload = safeParseJSON(detail.bodyText);
                if (payload) {
                    state.lastPromptHistory = payload;
                    state.lastPromptHistoryUpdatedAt = Date.now();
                    log.net("Stored prompt history snapshot for compression", {
                        ...describePromptHistory(payload)
                    });
                } else {
                    log.net("Compression request detected but prompt history parse failed");
                }
            } else if (state.historyCapturePending && !isCompressionBody) {
                log.net("Compression history capture pending, skipping non-compression request");
            }

            if (isCompressionBody && state.compressionInProgress) {
                state.compressionRequestPending = false;
                state.compressionResponsePending = true;
                log.net("Compression GenerateContent request captured");
            } else {
                log.net("Regular GenerateContent request observed");
            }
        },

        handleResponseEvent(event) {
            if (!state.compressionInProgress || !state.compressionResponsePending) {
                log.net("GenerateContent response event ignored", {
                    compressionInProgress: state.compressionInProgress,
                    compressionResponsePending: state.compressionResponsePending
                });
                return;
            }
            const detail = event?.detail;
            if (!detail?.bodyText) {
                log.net("GenerateContent response missing bodyText");
                Compression.finalizeRun();
                return;
            }
            const data = safeParseJSON(detail.bodyText);
            if (!data) {
                log.net("Failed to parse compression response");
                Compression.finalizeRun();
                return;
            }
            const snapshot = extractStateSnapshot(data);
            if (!snapshot) {
                log.net("No snapshot found in compression response");
                Compression.finalizeRun();
                return;
            }
            log.net("Compression snapshot extracted, rebuilding conversation");
            rebuildConversation(snapshot).catch(err => {
                log.net("Failed to rebuild conversation", err);
            });
            Compression.finalizeRun();
        },

        finalizeRun() {
            state.compressionRequestPending = false;
            state.compressionResponsePending = false;
            state.compressionInProgress = false;
            state.historyCapturePending = false;
            UI.setButtonLoading(false);
        },

        isCompressionPrompt(bodyText) {
            if (typeof bodyText !== "string") {
                return false;
            }
            const snippet = state.activeCompressionSnippet || deriveSnippet(getCompressPrompt());
            if (!snippet) {
                return bodyText.includes(Config.PROMPTS.SNIPPET);
            }
            const variants = buildSnippetVariants(snippet);
            for (const candidate of variants) {
                if (candidate && bodyText.includes(candidate)) {
                    return true;
                }
            }
            return false;
        }
    };

    function enableSendButton() {
        const sendButton = UI.findSendButton();
        if (sendButton) {
            sendButton.removeAttribute("disabled");
            sendButton.removeAttribute("aria-disabled");
            sendButton.disabled = false;
            sendButton.classList.remove("disabled");
        }
    }

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function nextFrame() {
        return new Promise(resolve => requestAnimationFrame(() => resolve()));
    }

    async function waitForCompressionRequestCapture(timeoutMs = 1800) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (!state.compressionInProgress) {
                return false;
            }
            if (state.compressionResponsePending || !state.compressionRequestPending) {
                return true;
            }
            await delay(50);
        }
        return state.compressionResponsePending || !state.compressionRequestPending;
    }

    function dispatchPointerClickSequence(el) {
        if (!el || typeof el.dispatchEvent !== "function") return false;
        const doc = el.ownerDocument || document;
        const view = doc.defaultView || window;
        const rect = typeof el.getBoundingClientRect === "function"
            ? el.getBoundingClientRect()
            : { left: 0, top: 0, width: 0, height: 0 };
        const centerX = rect.left + (rect.width || 0) / 2;
        const centerY = rect.top + (rect.height || 0) / 2;
        const eventSteps = [
            { type: "pointerdown", pointer: true, buttons: 1, detail: 0 },
            { type: "mousedown", buttons: 1, detail: 1 },
            { type: "pointerup", pointer: true, buttons: 0, detail: 0 },
            { type: "mouseup", buttons: 0, detail: 1 },
            { type: "click", buttons: 0, detail: 1 }
        ];

        try {
            if (typeof el.focus === "function") {
                el.focus({ preventScroll: true });
            }
        } catch {
            if (typeof el.focus === "function") {
                el.focus();
            }
        }

        for (const step of eventSteps) {
            const init = {
                bubbles: true,
                cancelable: true,
                composed: true,
                view,
                clientX: centerX,
                clientY: centerY,
                button: 0,
                buttons: step.buttons,
                detail: step.detail
            };
            let event;
            if (step.pointer && typeof view.PointerEvent === "function") {
                event = new view.PointerEvent(step.type, {
                    ...init,
                    pointerId: 1,
                    pointerType: "mouse",
                    isPrimary: true
                });
            } else {
                event = new view.MouseEvent(step.type, init);
            }
            el.dispatchEvent(event);
        }
        return true;
    }

    function triggerKeyboardSend(textarea) {
        const doc = textarea.ownerDocument || document;
        const view = doc.defaultView || window;
        const keyOptions = {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            bubbles: true,
            cancelable: true,
            view
        };
        if (env.isMac) {
            keyOptions.metaKey = true;
        } else {
            keyOptions.ctrlKey = true;
        }
        textarea.dispatchEvent(new view.KeyboardEvent("keydown", keyOptions));
        textarea.dispatchEvent(new view.KeyboardEvent("keyup", keyOptions));
        log.ui("Prompt send attempted via keyboard shortcut fallback");
    }

    async function sendPromptWithRetries(textarea, options = {}) {
        const clickPlan = [
            { label: "immediate", delayMs: 0, useFrame: false },
            { label: "next-frame", delayMs: 0, useFrame: true },
            { label: "delay-80ms", delayMs: 80, useFrame: false },
            { label: "delay-220ms", delayMs: 220, useFrame: false }
        ];
        const verifyFn = typeof options.verifyFn === "function" ? options.verifyFn : null;
        const labelPrefix = options.labelPrefix || "Prompt send";
        const abortCheck = typeof options.abortCheck === "function" ? options.abortCheck : null;

        for (const step of clickPlan) {
            if (step.useFrame) {
                await nextFrame();
            } else if (step.delayMs > 0) {
                await delay(step.delayMs);
            }
            if (abortCheck && abortCheck()) {
                return false;
            }

            enableSendButton();
            const sendButton = UI.findSendButton();
            if (!sendButton) {
                log.ui("Send button missing before click attempt", `${labelPrefix} ${step.label}`);
                continue;
            }

            dispatchPointerClickSequence(sendButton);
            log.ui(`${labelPrefix} click attempted`, step.label);
            if (!verifyFn || await verifyFn()) {
                log.ui(`${labelPrefix} confirmed`, step.label);
                return true;
            }
        }

        triggerKeyboardSend(textarea);
        if (!verifyFn || await verifyFn()) {
            log.ui(`${labelPrefix} confirmed via keyboard fallback`);
            return true;
        }
        return false;
    }

    async function sendCompressionRequest(textarea) {
        return sendPromptWithRetries(textarea, {
            labelPrefix: "Compression request",
            verifyFn: () => waitForCompressionRequestCapture(),
            abortCheck: () => !state.compressionInProgress
        });
    }

    function setTextareaValue(textarea, value) {
        if ("value" in textarea) {
            const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
            const setter = descriptor?.set;
            if (setter) {
                setter.call(textarea, value);
                return;
            }
            textarea.value = value;
        } else {
            textarea.textContent = value;
        }
    }

    // ---------------------------
    // Conversation rebuild & branch creation
    // ---------------------------

    async function rebuildConversation(snapshotText) {
        log.net("rebuildConversation invoked", {
            hasHistory: Boolean(state.lastPromptHistory),
            hasResolvedThread: Boolean(state.lastResolvedPromptThread),
            snapshotLength: snapshotText?.length || 0
        });

        const turns = await getRebuildSourceTurns();
        if (!turns.length) {
            log.net("No prompt history available to rebuild conversation");
            return;
        }
        const sanitizedTurns = stripCompressionArtifacts(turns);
        if (!sanitizedTurns.length) {
            log.net("History only contained compression prompt turn, abort rebuild");
            return;
        }
        const preserved = pickTailTurns(sanitizedTurns);
        const newTurns = [
            createTurn("user", snapshotText),
            createTurn("model", "Got it. Thanks for the additional context!"),
            ...preserved
        ];
        state.pendingBranchTurns = newTurns;
        log.net("Prepared compressed branch turns", newTurns.length, "turns");
        Branching.branchFromHere().catch(err => {
            log.net("Compressed branch creation failed", err);
        });
    }

    function extractStateSnapshot(events) {
        const fullText = collectModelOutputText(events);
        if (!fullText) {
            log.net("collectModelOutputText returned empty string");
            return null;
        }
        const pattern = getSnapshotRegex();
        if (pattern) {
            const matched = matchByRegex(fullText, pattern);
            if (matched) {
                log.net("state_snapshot extracted via custom regex");
                return matched;
            }
            log.net("Custom snapshot regex did not match content");
        }
        log.net("No custom regex provided, returning raw model output as snapshot");
        return fullText.trim();
    }

    function collectModelOutputText(events) {
        const eventList = normalizeEvents(events);
        if (!eventList.length) {
            return "";
        }
        let buffer = "";
        for (const event of eventList) {
            const candidates = Array.isArray(event?.[0]) ? event[0] : null;
            if (!candidates) continue;
            for (const candidate of candidates) {
                if (!Array.isArray(candidate)) continue;
                const contentBlock = Array.isArray(candidate[0]) ? candidate[0] : null;
                if (!contentBlock) continue;
                const parts = Array.isArray(contentBlock[0]) ? contentBlock[0] : null;
                if (!parts) continue;
                for (const part of parts) {
                    if (!Array.isArray(part)) continue;
                    const text = part[1];
                    const isThought = Boolean(part[12]);
                    if (typeof text === "string" && !isThought) {
                        buffer += text;
                    }
                }
            }
        }
        log.net("collectModelOutputText aggregated", {
            eventCount: eventList.length,
            textLength: buffer.length
        });
        return buffer;
    }

    function normalizeEvents(payload) {
        if (!Array.isArray(payload)) {
            return [];
        }
        if (payload.length === 1 && Array.isArray(payload[0])) {
            const inner = payload[0];
            if (inner.every(item => Array.isArray(item))) {
                return inner;
            }
        }
        return payload;
    }

    function extractTurns(payload) {
        try {
            if (!Array.isArray(payload)) {
                log.net("Prompt history payload is not an array");
                return [];
            }
            const rawTurns = payload[1];
            if (!Array.isArray(rawTurns)) {
                log.net("Prompt history array missing turn entries");
                return [];
            }
            const turns = [];
            for (const entry of rawTurns) {
                if (!Array.isArray(entry) || entry.length < 2) continue;
                const role = entry[1];
                const text = extractTurnText(entry[0], role);
                if (typeof role === "string" && text) {
                    turns.push({
                        role,
                        text,
                        entry: deepClone(entry)
                    });
                }
            }
            log.net("Extracted", turns.length, "turns from prompt history");
            return turns;
        } catch (err) {
            log.net("Failed to extract turns", err);
            return [];
        }
    }

    async function getRebuildSourceTurns() {
        const currentPromptId = Branching.getCurrentPromptId();
        if (state.lastResolvedPromptThread?.length) {
            if (!currentPromptId || !state.lastResolvedPromptId || state.lastResolvedPromptId === currentPromptId) {
                const resolvedTurns = extractResolvedTurns(state.lastResolvedPromptThread);
                if (resolvedTurns.length) {
                    log.net("Rebuilding conversation from resolved prompt thread", {
                        promptId: state.lastResolvedPromptId,
                        turnCount: resolvedTurns.length,
                        updatedAt: state.lastResolvedPromptUpdatedAt
                    });
                    return resolvedTurns;
                }
            } else {
                log.net("Resolved prompt thread does not match current prompt, skipping", {
                    currentPromptId,
                    resolvedPromptId: state.lastResolvedPromptId
                });
            }
        }

        const fetchedCapture = await ensureResolvedPromptThread(currentPromptId);
        if (fetchedCapture?.entries?.length) {
            const fetchedTurns = extractResolvedTurns(fetchedCapture.entries);
            if (fetchedTurns.length) {
                log.net("Rebuilding conversation from on-demand resolved prompt thread", {
                    promptId: fetchedCapture.promptId,
                    turnCount: fetchedTurns.length
                });
                return fetchedTurns;
            }
        }

        if (!state.lastPromptHistory) {
            return [];
        }

        log.net("Rebuilding conversation using stored GenerateContent history", {
            summary: describePromptHistory(state.lastPromptHistory)
        });
        return extractTurns(state.lastPromptHistory);
    }

    async function ensureResolvedPromptThread(promptId) {
        if (!promptId) {
            return null;
        }
        if (state.lastResolvedPromptThread?.length && (!state.lastResolvedPromptId || state.lastResolvedPromptId === promptId)) {
            return {
                promptId: state.lastResolvedPromptId || promptId,
                title: getResolvedPromptTitle(state.lastResolvedPromptRoot),
                root: state.lastResolvedPromptRoot ? deepClone(state.lastResolvedPromptRoot) : null,
                entries: state.lastResolvedPromptThread.map(entry => deepClone(entry))
            };
        }
        return fetchResolvedPromptThread(promptId);
    }

    async function fetchResolvedPromptThread(promptId) {
        const authHeader = await buildSapisidAuthHeader();
        if (!authHeader) {
            log.net("Unable to build SAPISIDHASH auth header for ResolveDriveResource fetch");
            return null;
        }
        const endpoint = `${Config.NETWORK.RPC_ORIGIN}${Config.TARGETS.RESOLVE}`;
        const apiKey = getGoogleApiKey();
        try {
            const response = await fetch(endpoint, {
                method: "POST",
                credentials: "include",
                headers: {
                    "content-type": "application/json+protobuf",
                    "x-goog-api-key": apiKey,
                    "x-goog-authuser": "0",
                    authorization: authHeader
                },
                body: JSON.stringify([promptId])
            });
            const bodyText = await response.text();
            if (!response.ok) {
                log.net("ResolveDriveResource fetch failed", {
                    promptId,
                    status: response.status,
                    bodyText
                });
                return null;
            }
            const capture = extractResolvedPromptThread(safeParseJSON(bodyText));
            if (!capture?.entries?.length) {
                log.net("ResolveDriveResource fetch returned no reusable thread", { promptId });
                return null;
            }
            rememberResolvedPromptCapture(capture, "Fetched resolved prompt thread on demand");
            return capture;
        } catch (err) {
            log.net("ResolveDriveResource fetch threw", err);
            return null;
        }
    }

    function getCookieValue(name) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
        return match ? decodeURIComponent(match[1]) : "";
    }

    function getHeaderValue(headers, name) {
        if (!headers || typeof headers !== "object" || !name) {
            return "";
        }
        const normalizedName = String(name).toLowerCase();
        for (const [key, value] of Object.entries(headers)) {
            if (String(key).toLowerCase() === normalizedName && typeof value === "string") {
                return value;
            }
        }
        return "";
    }

    function rememberGoogleApiKey(headers, sourceUrl = "") {
        const candidate = getHeaderValue(headers, "x-goog-api-key").trim();
        if (!candidate) {
            return "";
        }
        if (candidate !== state.googleApiKey) {
            log.net("Captured Google API key from native request headers", {
                sourceUrl,
                length: candidate.length
            });
        }
        state.googleApiKey = candidate;
        state.googleApiKeyUpdatedAt = Date.now();
        return candidate;
    }

    function getGoogleApiKey() {
        const apiKey = (state.googleApiKey || "").trim();
        if (!apiKey) {
            throw new Error("Google API key has not been captured yet; trigger one native AI Studio request first");
        }
        return apiKey;
    }

    async function buildSapisidAuthHeader() {
        const sapisid = getCookieValue("SAPISID") || getCookieValue("__Secure-3PAPISID") || getCookieValue("APISID");
        if (!sapisid || !globalThis.crypto?.subtle) {
            return null;
        }
        const timestamp = Math.floor(Date.now() / 1000);
        const origin = location.origin;
        const encoder = new TextEncoder();
        const source = `${timestamp} ${sapisid} ${origin}`;
        const digest = await globalThis.crypto.subtle.digest("SHA-1", encoder.encode(source));
        const hash = Array.from(new Uint8Array(digest))
            .map(byte => byte.toString(16).padStart(2, "0"))
            .join("");
        return `SAPISIDHASH ${timestamp}_${hash} SAPISID1PHASH ${timestamp}_${hash} SAPISID3PHASH ${timestamp}_${hash}`;
    }

    function extractResolvedTurns(entries) {
        if (!Array.isArray(entries)) {
            return [];
        }
        const turns = [];
        for (const entry of entries) {
            if (!Array.isArray(entry) || entry.length < 9) continue;
            const role = entry[8];
            const text = extractResolvedEntryText(entry);
            if (typeof role === "string" && text) {
                turns.push({
                    role,
                    text,
                    entry: deepClone(entry)
                });
            }
        }
        log.net("Extracted", turns.length, "turns from resolved prompt thread");
        return turns;
    }

    function extractResolvedEntryText(entry) {
        if (!Array.isArray(entry)) return "";
        if (typeof entry[0] === "string" && entry[0]) {
            return entry[0];
        }
        const parts = Array.isArray(entry[29]) ? entry[29] : null;
        if (!parts) {
            return "";
        }
        let buffer = "";
        for (const part of parts) {
            if (!Array.isArray(part)) continue;
            const chunk = part[1];
            if (typeof chunk === "string") {
                buffer += chunk;
            }
        }
        return buffer;
    }

    function rememberResolvedPromptCapture(capture, label = "Captured resolved prompt thread") {
        if (!capture?.entries?.length) {
            return;
        }
        state.lastResolvedPromptThread = capture.entries.map(entry => deepClone(entry));
        state.lastResolvedPromptRoot = Array.isArray(capture.root) ? deepClone(capture.root) : null;
        state.lastResolvedPromptId = capture.promptId;
        state.lastResolvedPromptUpdatedAt = Date.now();
        log.net(label, describeResolvedPromptCapture(capture));
    }

    function maybeCaptureResolvedPromptThread(url, bodyText, parsed = null) {
        if (!isTargetRequest(url, "RESOLVE") || typeof bodyText !== "string") {
            return;
        }
        const payload = parsed || safeParseJSON(bodyText);
        const capture = extractResolvedPromptThread(payload);
        if (!capture?.entries?.length) {
            return;
        }
        rememberResolvedPromptCapture(capture);
    }

    function collectPromptIds(value, matches = [], seen = new Set()) {
        if (value == null) {
            return matches;
        }
        if (typeof value === "string") {
            const match = value.match(/(?:^|\b)prompts\/([^/?#\s"']+)/);
            if (match && !matches.includes(match[1])) {
                matches.push(match[1]);
            }
            return matches;
        }
        if (typeof value !== "object") {
            return matches;
        }
        if (seen.has(value)) {
            return matches;
        }
        seen.add(value);
        if (Array.isArray(value)) {
            for (const item of value) {
                collectPromptIds(item, matches, seen);
            }
            return matches;
        }
        for (const nested of Object.values(value)) {
            collectPromptIds(nested, matches, seen);
        }
        return matches;
    }

    function extractResolvedPromptThread(payload) {
        if (!Array.isArray(payload) || !Array.isArray(payload[0])) {
            return null;
        }
        const root = payload[0];
        if (!Array.isArray(root) || root.length < 14) {
            return null;
        }
        const threads = Array.isArray(root[13]) ? root[13] : null;
        const primaryThread = Array.isArray(threads?.[0]) ? threads[0] : null;
        if (!primaryThread?.length) {
            return null;
        }
        return {
            promptId: extractMutationPromptId(root),
            title: getResolvedPromptTitle(root),
            root: deepClone(root),
            entries: primaryThread.filter(Array.isArray).map(entry => deepClone(entry))
        };
    }

    function describeResolvedPromptCapture(capture) {
        if (!capture) {
            return { valid: false };
        }
        return {
            valid: true,
            promptId: capture.promptId,
            title: capture.title || "",
            turnCount: capture.entries?.length || 0,
            firstRole: capture.entries?.[0]?.[8]
        };
    }


    function getResolvedPromptTitle(root) {
        const candidate = Array.isArray(root?.[4]) ? root[4][0] : null;
        if (typeof candidate === "string" && candidate.trim()) {
            return candidate.trim();
        }
        const heading = document.querySelector("main h1")?.textContent || document.querySelector("h1")?.textContent || "";
        return heading.trim();
    }

    function buildDirectBranchCreateBody(capture, turnRecords = null) {
        const sourceRoot = Array.isArray(capture?.root) ? capture.root : state.lastResolvedPromptRoot;
        if (!Array.isArray(sourceRoot) || sourceRoot.length < 14) {
            return null;
        }
        const modelConfig = Array.isArray(sourceRoot[3]) ? deepClone(sourceRoot[3]) : null;
        if (!modelConfig) {
            return null;
        }
        const threads = Array.isArray(sourceRoot[13]) ? sourceRoot[13] : [];
        const secondaryThread = Array.isArray(threads[1]) ? deepClone(threads[1]) : [];
        const primaryThread = Array.isArray(turnRecords) && turnRecords.length
            ? turnRecords.map((turn, index) => buildMutationThreadEntry(turn, index))
            : (Array.isArray(threads[0]) ? deepClone(threads[0]) : []);
        if (!primaryThread.length) {
            return null;
        }
        const baseTitle = getResolvedPromptTitle(sourceRoot) || "Compressed Chat";
        const normalizedTitle = baseTitle.replace(/^branch of\s+/i, "").trim() || baseTitle;
        const branchTitle = `Compression of ${normalizedTitle}`;
        const createRoot = new Array(Math.max(14, sourceRoot.length)).fill(null);
        createRoot[3] = modelConfig;
        createRoot[4] = [branchTitle];
        createRoot[12] = Array.isArray(sourceRoot[12]) ? deepClone(sourceRoot[12]) : [];
        createRoot[13] = [primaryThread, secondaryThread];
        return JSON.stringify([createRoot]);
    }

    function describePromptHistory(payload) {
        if (!Array.isArray(payload)) {
            return { valid: false, type: typeof payload };
        }
        const rawTurns = Array.isArray(payload[1]) ? payload[1] : null;
        if (!rawTurns) {
            return { valid: false, reason: "missing turns array" };
        }
        const firstTurn = rawTurns[0];
        return {
            valid: true,
            turnCount: rawTurns.length,
            firstRole: firstTurn?.[1],
            firstChunkType: Array.isArray(firstTurn?.[0]) ? "chunks" : typeof firstTurn?.[0]
        };
    }

    function stripCompressionArtifacts(turns) {
        if (!turns.length) return turns;
        const sanitized = turns.slice();
        let removed = 0;
        let removedSnapshotTurn = false;

        while (sanitized.length) {
            const lastTurn = sanitized[sanitized.length - 1];
            if (isCompressionPromptTurn(lastTurn)) {
                sanitized.pop();
                removed += 1;
                removedSnapshotTurn = false;
                continue;
            }
            if (isCompressionSnapshotTurn(lastTurn)) {
                sanitized.pop();
                removed += 1;
                removedSnapshotTurn = true;
                continue;
            }
            if (removedSnapshotTurn && isThoughtOnlyTurn(lastTurn)) {
                sanitized.pop();
                removed += 1;
                continue;
            }
            break;
        }

        if (removed > 0) {
            log.net("Removed compression artifact turns from tail", {
                removed,
                remaining: sanitized.length
            });
        }
        return sanitized;
    }

    function isCompressionPromptTurn(turn) {
        const snippet = state.activeCompressionSnippet || deriveSnippet(getCompressPrompt());
        return Boolean(
            turn?.role === "user" &&
            typeof turn.text === "string" &&
            snippet &&
            turn.text.includes(snippet)
        );
    }

    function isCompressionSnapshotTurn(turn) {
        if (turn?.role !== "model" || typeof turn.text !== "string" || !turn.text) {
            return false;
        }
        if (/<state_snapshot>[\s\S]*<\/state_snapshot>/i.test(turn.text)) {
            return true;
        }
        const pattern = getSnapshotRegex();
        if (pattern && matchByRegex(turn.text, pattern)) {
            return true;
        }
        return /<scratchpad>/i.test(turn.text) && /state[_ -]?snapshot/i.test(turn.text);
    }

    function isThoughtOnlyTurn(turn) {
        return Boolean(
            turn?.role === "model" &&
            Array.isArray(turn.entry) &&
            turn.entry.length >= 33 &&
            turn.entry[19] === 1
        );
    }

    function extractTurnText(rawContent, role) {
        if (!rawContent) return "";
        if (typeof rawContent === "string") return rawContent;
        if (!Array.isArray(rawContent)) return "";

        let buffer = "";
        const shouldSkipFirstBlock = role === "model";
        let skipThoughtChunk = shouldSkipFirstBlock;
        let skippedChunk = "";
        for (const block of rawContent) {
            if (!Array.isArray(block)) continue;
            const isThought = Boolean(block[12]);
            if (isThought) continue;
            const chunk = block[1];
            if (typeof chunk === "string") {
                if (skipThoughtChunk) {
                    skipThoughtChunk = false;
                    skippedChunk = chunk;
                    continue;
                }
                buffer += chunk;
            }
        }
        if (!buffer && skippedChunk) {
            return skippedChunk;
        }
        return buffer;
    }

    function pickTailTurns(turns) {
        if (!turns.length) return [];
        const fullText = turns.map(t => t.text).join("\n");
        const { percent, minChars } = getTailRetentionConfig();
        if (percent >= 100) {
            log.net("Tail retention percent at 100, preserving all turns");
            return turns.slice();
        }
        const computedTarget = Math.floor(fullText.length * (percent / 100));
        const targetLength = Math.min(fullText.length, Math.max(minChars, computedTarget));
        if (targetLength <= 0) {
            log.net("Tail retention target is zero, skipping preserved turns");
            return [];
        }
        let acc = 0;
        let startIndex = turns.length - 1;
        while (startIndex >= 0) {
            acc += turns[startIndex].text.length;
            if (acc >= targetLength && turns[startIndex].role === "user") {
                break;
            }
            startIndex--;
        }
        startIndex = Math.max(0, startIndex);
        while (startIndex > 0 && turns[startIndex].role !== "user") {
            startIndex--;
        }
        log.net("Preserving tail turns from index", startIndex, "approx chars", acc);
        return turns.slice(startIndex);
    }

    function createTurn(role, text) {
        return { role, text };
    }

    // ---------------------------
    // Branching controls
    // ---------------------------

    const Branching = {
        async branchFromHere() {
            if (state.branchInProgress) {
                log.ui("Compression branch already running");
                return;
            }
            log.net("Attempting to create compressed prompt");
            state.branchInProgress = true;
            try {
                const promptChange = await Branching.branchFromHereViaCreatePrompt();
                log.ui("Compression prompt created, navigating");
                log.net("Direct CreatePrompt compression completed", promptChange);
                location.assign(`${location.origin}/prompts/${promptChange.promptId}`);
            } catch (err) {
                log.net("Compressed branch creation failed", err);
                state.pendingBranchTurns = null;
                throw err;
            } finally {
                state.branchInProgress = false;
            }
        },

        async branchFromHereViaCreatePrompt() {
            const previousPromptId = Branching.getCurrentPromptId();
            if (!previousPromptId) {
                throw new Error("current prompt id not found");
            }
            if (!state.pendingBranchTurns?.length) {
                throw new Error("no pending turns available for branch creation");
            }
            const capture = await ensureResolvedPromptThread(previousPromptId);
            const body = buildDirectBranchCreateBody(capture, state.pendingBranchTurns);
            if (!body) {
                throw new Error("unable to build CreatePrompt branch payload");
            }
            const authHeader = await buildSapisidAuthHeader();
            if (!authHeader) {
                throw new Error("unable to build SAPISIDHASH auth header");
            }

            const pendingBranchTurns = state.pendingBranchTurns;
            const apiKey = getGoogleApiKey();
            state.pendingBranchTurns = null;
            try {
                const response = await fetch(`${Config.NETWORK.RPC_ORIGIN}${Config.TARGETS.CREATE_PROMPT}`, {
                    method: "POST",
                    credentials: "include",
                    headers: {
                        "content-type": "application/json+protobuf",
                        "x-goog-api-key": apiKey,
                        "x-goog-authuser": "0",
                        authorization: authHeader
                    },
                    body
                });
                const bodyText = await response.text();
                if (!response.ok) {
                    throw new Error(`CreatePrompt failed: ${response.status} ${bodyText.slice(0, 300)}`);
                }
                const parsed = safeParseJSON(bodyText);
                const promptId = Branching.pickCreatedPromptId(parsed, previousPromptId);
                if (!promptId) {
                    throw new Error("CreatePrompt succeeded but no prompt id was returned");
                }
                return {
                    promptId,
                    via: "direct-create-prompt"
                };
            } catch (err) {
                state.pendingBranchTurns = pendingBranchTurns;
                throw err;
            }
        },

        pickCreatedPromptId(payload, previousPromptId = null) {
            const topLevelPrompt = typeof payload?.[0] === "string" ? payload[0] : "";
            const topLevelMatch = topLevelPrompt.match(/^prompts\/([^/?#]+)/);
            if (topLevelMatch && (!previousPromptId || topLevelMatch[1] !== previousPromptId)) {
                return topLevelMatch[1];
            }
            const promptIds = collectPromptIds(payload);
            return promptIds.find(id => id && id !== previousPromptId) || null;
        },

        getCurrentPromptId() {
            const path = location.pathname || "";
            const match = path.match(/\/prompts\/([^/?#]+)/);
            return match ? match[1] : null;
        }
    };

    // ---------------------------
    // UI module (toolbar button)
    // ---------------------------

    const UI = {
        init() {
            UI.injectButton();

            window.addEventListener("DOMContentLoaded", () => {
                log.ui("DOMContentLoaded");
                UI.injectButton();
            });

            window.addEventListener("load", () => {
                log.ui("window load event");
                UI.injectButton();
            });

            const observer = new MutationObserver(() => {
                UI.injectButton();
            });

            function startObserver() {
                let attached = false;
                for (const doc of UI.getCandidateDocuments()) {
                    if (doc.body) {
                        observer.observe(doc.body, { childList: true, subtree: true });
                        attached = true;
                    }
                }
                if (attached) {
                    log.ui("MutationObserver for button injection started");
                } else {
                    log.ui("Document body not ready for observer");
                }
            }

            if (document.readyState === "loading") {
                document.addEventListener("DOMContentLoaded", startObserver, { once: true });
            } else {
                startObserver();
            }

            setInterval(() => UI.injectButton(), 2000);
        },

        injectButton() {
            if (!window.location.href.includes(Config.UI.TARGET_PATH)) return;
            for (const doc of UI.getCandidateDocuments()) {
                if (doc.getElementById(Config.UI.BUTTON_ID)) return;
                const toolbar = UI.findToolbar(doc);
                if (!toolbar) continue;
                const button = UI.createButton(doc);
                const moreButton = toolbar.querySelector(
                    'button[iconname="more_vert"], button[aria-label="View more actions"], button[aria-label="More actions"], button[aria-label="More options"]'
                );
                let referenceNode = null;
                if (moreButton) {
                    if (moreButton.parentElement === toolbar) {
                        referenceNode = moreButton;
                    } else if (moreButton.parentElement && moreButton.parentElement.parentElement === toolbar) {
                        referenceNode = moreButton.parentElement;
                    }
                }
                if (referenceNode) {
                    toolbar.insertBefore(button, referenceNode);
                    log.ui("Compressor button inserted before menu button");
                } else {
                    toolbar.appendChild(button);
                    log.ui("Compressor button appended to toolbar");
                }
                return;
            }
            log.ui("Toolbar not found, wait for next mutation");
        },
        findToolbar(doc) {
            const selectors = Array.isArray(Config.UI.TOOLBAR_SELECTORS)
                ? Config.UI.TOOLBAR_SELECTORS
                : [Config.UI.TOOLBAR_SELECTORS || Config.UI.TOOLBAR_SELECTOR].filter(Boolean);
            for (const selector of selectors) {
                const nodes = Array.from(doc.querySelectorAll(selector));
                for (const node of nodes) {
                    if (UI.isToolbarCandidate(node)) return node;
                }
            }
            return null;
        },
        isToolbarCandidate(node) {
            if (!node || typeof node.querySelector !== "function") return false;
            const hasMenuButton = node.querySelector(
                'button[iconname="more_vert"], button[aria-label="View more actions"], button[aria-label="More actions"], button[aria-label="More options"]'
            );
            if (hasMenuButton) return true;
            const hasRunSettings = node.querySelector('button[aria-label="Toggle run settings panel"]');
            if (hasRunSettings) return true;
            const hasNewChat = node.querySelector('button[aria-label="New chat"]');
            if (hasNewChat) return true;
            return false;
        },

        createButton(doc = document) {
            UI.ensureStyles(doc);
            const button = doc.createElement("button");
            button.id = Config.UI.BUTTON_ID;
            button.title = "Compress Chat History";
            button.setAttribute("ms-button", "");
            button.setAttribute("variant", "icon-borderless");
            button.setAttribute("mattooltip", "Compress Chat History");
            button.setAttribute("mattooltipposition", "below");
            button.setAttribute("iconname", "summarize");
            button.className = "mat-mdc-tooltip-trigger ms-button-borderless ms-button-icon";
            button.setAttribute("aria-label", "Compress Chat History");
            button.setAttribute("aria-disabled", "false");
            button.type = "button";
            button.addEventListener("click", Compression.run);

            const iconSpan = doc.createElement("span");
            iconSpan.className = "material-symbols-outlined notranslate ms-button-icon-symbol compressor-icon";
            iconSpan.setAttribute("aria-hidden", "true");
            iconSpan.textContent = "docs";
            button.appendChild(iconSpan);

            const spinnerSpan = doc.createElement("span");
            spinnerSpan.className = "compressor-spinner";
            spinnerSpan.setAttribute("aria-hidden", "true");
            button.appendChild(spinnerSpan);

            return button;
        },

        ensureStyles(doc) {
            const styleId = `${Config.UI.BUTTON_ID}-style`;
            if (doc.getElementById(styleId)) return;
            const style = doc.createElement("style");
            style.id = styleId;
            style.textContent = `@keyframes aistudio-compressor-spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
}
#${Config.UI.BUTTON_ID} {
    position: relative;
    width: 36px !important;
    min-width: 36px !important;
    height: 36px !important;
    padding: 6px !important;
    border-radius: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
}
#${Config.UI.BUTTON_ID} .compressor-spinner {
    box-sizing: border-box;
    width: 20px;
    height: 20px;
    border: 2px solid rgba(0, 0, 0, 0.2);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: aistudio-compressor-spin 0.8s linear infinite;
    display: none;
}
#${Config.UI.BUTTON_ID}.compressor-loading .compressor-spinner {
    display: inline-flex;
    align-items: center;
    justify-content: center;
}
#${Config.UI.BUTTON_ID}.compressor-loading .compressor-icon {
    display: none;
}`;
            const target = doc.head || doc.documentElement || doc.body;
            if (target) {
                target.appendChild(style);
            }
        },

        findInput() {
            const docs = UI.getCandidateDocuments();
            for (const doc of docs) {
                for (const selector of Config.UI.INPUT_SELECTORS) {
                    const el = doc.querySelector(selector);
                    if (el) {
                        log.ui("Input box found via selector", selector);
                        return el;
                    }
                }
            }
            return null;
        },

        findSendButton() {
            const docs = UI.getCandidateDocuments();
            for (const doc of docs) {
                for (const selector of Config.UI.SEND_BUTTON_SELECTORS) {
                    const btn = doc.querySelector(selector);
                    if (btn) {
                        log.ui("Send button found via selector", selector);
                        return btn;
                    }
                }
            }
            return null;
        },

        getCandidateDocuments() {
            const docs = [document];
            const frameDoc = document.querySelector('iframe[src*="bscframe"]')?.contentDocument;
            if (frameDoc && frameDoc !== document) {
                docs.push(frameDoc);
            }
            return docs;
        },

        setButtonLoading(isLoading) {
            const button = UI.findButton();
            if (!button) return;
            if (isLoading) {
                button.classList.add("compressor-loading");
                button.setAttribute("disabled", "true");
                button.setAttribute("aria-disabled", "true");
            } else {
                button.classList.remove("compressor-loading");
                button.removeAttribute("disabled");
                button.removeAttribute("aria-disabled");
            }
        },

        findButton() {
            for (const doc of UI.getCandidateDocuments()) {
                const btn = doc.getElementById(Config.UI.BUTTON_ID);
                if (btn) return btn;
            }
            return null;
        }
    };

    // ---------------------------
    // Prompt thread builders
    // ---------------------------

    function extractMutationPromptId(root) {
        const resourceName = typeof root?.[0] === "string" ? root[0] : "";
        const match = resourceName.match(/prompts\/([^/?#]+)/);
        return match ? match[1] : null;
    }

    function buildMutationThreadEntry(turn, sequence = 0) {
        if (isReusablePromptThreadEntry(turn?.entry)) {
            const entry = deepClone(turn.entry);
            entry[0] = turn?.text || "";
            entry[8] = turn?.role === "model" ? "model" : "user";
            if (Array.isArray(entry[21]) && typeof entry[21][0] === "string" && /^prompts\//.test(entry[21][0])) {
                entry[21] = null;
            }
            entry[32] = buildEntryTimestamp(sequence);
            return entry;
        }
        return buildCreatePromptEntry(turn, sequence);
    }

    function isReusablePromptThreadEntry(entry) {
        return Array.isArray(entry) && entry.length >= 33 && typeof entry[8] === "string";
    }

    function buildCreatePromptEntry(turn, sequence = 0) {
        const text = turn?.text || "";
        const role = turn?.role === "model" ? "model" : "user";
        const entry = new Array(33).fill(null);
        entry[0] = text;
        entry[8] = role;
        const tokenEstimate = estimateTokenCount(text);
        if (tokenEstimate > 0) {
            entry[18] = tokenEstimate;
        }
        entry[32] = buildEntryTimestamp(sequence);
        return entry;
    }

    function buildEntryTimestamp(sequence = 0) {
        const timestampMs = Date.now() + Math.max(0, Number(sequence) || 0);
        const seconds = Math.floor(timestampMs / 1000);
        const nanos = (timestampMs % 1000) * 1_000_000;
        return [seconds, nanos];
    }

    function estimateTokenCount(text) {
        if (!text) return 0;
        return Math.max(1, Math.round(text.length / 4));
    }

    function deepClone(value) {
        return value == null ? value : JSON.parse(JSON.stringify(value));
    }

    function safeParseJSON(text) {
        if (typeof text !== "string") return null;
        try {
            return JSON.parse(text);
        } catch {
            return null;
        }
    }

    function buildSnippetVariants(snippet) {
        if (typeof snippet !== "string" || !snippet) {
            return [];
        }
        const variants = [snippet];
        const escaped = escapeForJSON(snippet);
        if (escaped && escaped !== snippet) {
            variants.push(escaped);
        }
        return variants;
    }

    function escapeForJSON(text) {
        try {
            const encoded = JSON.stringify(text);
            return typeof encoded === "string" ? encoded.slice(1, -1) : text;
        } catch {
            return text;
        }
    }

    function matchByRegex(text, pattern) {
        if (!pattern) return null;
        try {
            const regex = new RegExp(pattern, "s");
            const result = text.match(regex);
            return result ? result[0] : null;
        } catch (err) {
            log.net("Invalid snapshot regex", err);
            return null;
        }
    }

    function bootstrap() {
        const runtimeInfo = {
            version: SCRIPT_VERSION,
            href: location.href,
            loadedAt: new Date().toISOString()
        };
        env.topWindow.__AISTUDIO_COMPRESSOR_RUNTIME__ = runtimeInfo;
        console.info(Config.TAGS.UI, "Script version", runtimeInfo.version, "loaded", runtimeInfo);

        installTopLevelHandlers();
        registerMenuCommands();
        installSettingsMessageBridge();
        NetworkMonitor.init();
        if (!env.isAppContext) {
            UI.init();
        }
    }

    bootstrap();

})();
