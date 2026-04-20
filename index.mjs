/**
 * @type {import("@opencode-ai/plugin").Plugin}
 */
export async function CopilotAuthPlugin(input = {}) {
  const CLIENT_ID = "Ov23ctDVkRmgkPke0Mmm";
  const API_VERSION = "2025-05-01";
  const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000;
  const OAUTH_SCOPES = "read:user read:org repo gist";
  const RESPONSES_API_ALTERNATE_INPUT_TYPES = [
    "file_search_call",
    "computer_call",
    "computer_call_output",
    "web_search_call",
    "function_call",
    "function_call_output",
    "image_generation_call",
    "code_interpreter_call",
    "local_shell_call",
    "local_shell_call_output",
    "mcp_list_tools",
    "mcp_approval_request",
    "mcp_approval_response",
    "mcp_call",
    "reasoning",
  ];

  // Models that support the native Anthropic Messages API endpoint (/v1/messages).
  // Replaced (not accumulated) on each fetchModels() call so stale data doesn't persist.
  let messagesEndpointModels = new Set();

  function normalizeDomain(url) {
    return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  }

  function getUrls(domain) {
    const apiDomain = domain === "github.com" ? "api.github.com" : `api.${domain}`;
    return {
      DEVICE_CODE_URL: `https://${domain}/login/device/code`,
      ACCESS_TOKEN_URL: `https://${domain}/login/oauth/access_token`,
      COPILOT_ENTITLEMENT_URL: `https://${apiDomain}/copilot_internal/user`,
    };
  }

  async function fetchEntitlement(info) {
    const domain = info.enterpriseUrl ? normalizeDomain(info.enterpriseUrl) : "github.com";
    const urls = getUrls(domain);

    const response = await fetch(urls.COPILOT_ENTITLEMENT_URL, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${info.refresh}`,
        "User-Agent": "GithubCopilot/1.155.0",
      },
    });

    if (!response.ok) {
      throw new Error(`Entitlement fetch failed: ${response.status}`);
    }

    return response.json();
  }

  async function getBaseURL(info) {
    if (info.baseUrl) return info.baseUrl;
    const entitlement = await fetchEntitlement(info);
    return entitlement?.endpoints?.api;
  }

  async function fetchModels(info, baseURL) {
    const response = await fetch(`${baseURL}/models`, {
      headers: {
        Authorization: `Bearer ${info.refresh}`,
        "Copilot-Integration-Id": "copilot-developer-cli",
        "Openai-Intent": "model-access",
        "User-Agent": "opencode-copilot-cli-auth/0.0.16",
        "X-GitHub-Api-Version": API_VERSION,
        "X-Interaction-Type": "model-access",
        "X-Request-Id": crypto.randomUUID(),
      },
    });

    if (!response.ok) {
      throw new Error(`Model fetch failed: ${response.status}`);
    }

    const data = await response.json();
    const models = Array.isArray(data?.data) ? data.data : [];

    // Replace (not accumulate) so stale capabilities don't persist across re-fetches
    messagesEndpointModels = new Set(
      models
        .filter((m) => m.supported_endpoints?.includes("/v1/messages"))
        .map((m) => m.id),
    );

    return models;
  }

  function zeroCost() {
    return {
      input: 0,
      output: 0,
      cache: {
        read: 0,
        write: 0,
      },
    };
  }

  function isLiveChatModel(model) {
    return model?.capabilities?.type === "chat";
  }

  function isPickerModel(model) {
    return isLiveChatModel(model) && model?.model_picker_enabled !== false;
  }

  function getReleaseDate(id, version, fallback = "") {
    if (typeof version === "string" && version.startsWith(`${id}-`)) {
      return version.slice(id.length + 1);
    }
    return version || fallback;
  }

  function createProviderModel(existing, live, baseURL) {
    const limits = live.capabilities?.limits ?? {};
    const supports = live.capabilities?.supports ?? {};
    const vision = !!supports.vision || !!limits.vision;
    const reasoning =
      existing?.capabilities?.reasoning
      ?? (
        !!supports.adaptive_thinking
        || typeof supports.max_thinking_budget === "number"
        || Array.isArray(supports.reasoning_effort)
      );

    return {
      ...structuredClone(existing ?? {}),
      id: live.id,
      api: {
        ...(existing?.api ?? {}),
        id: live.id,
        url: baseURL,
        npm: "@ai-sdk/github-copilot",
      },
      name: live.name ?? existing?.name ?? live.id,
      family: live.capabilities?.family ?? existing?.family ?? "",
      cost: zeroCost(),
      limit: {
        context:
          limits.max_context_window_tokens
          ?? existing?.limit?.context
          ?? 0,
        input:
          limits.max_prompt_tokens
          ?? existing?.limit?.input
          ?? limits.max_context_window_tokens,
        output:
          limits.max_output_tokens
          ?? limits.max_non_streaming_output_tokens
          ?? existing?.limit?.output
          ?? 0,
      },
      capabilities: {
        temperature: existing?.capabilities?.temperature ?? true,
        reasoning,
        attachment: existing?.capabilities?.attachment ?? vision,
        toolcall: !!supports.tool_calls,
        input: {
          text: existing?.capabilities?.input?.text ?? true,
          audio: existing?.capabilities?.input?.audio ?? false,
          image: existing?.capabilities?.input?.image ?? vision,
          video: existing?.capabilities?.input?.video ?? false,
          pdf: existing?.capabilities?.input?.pdf ?? false,
        },
        output: {
          text: existing?.capabilities?.output?.text ?? true,
          audio: existing?.capabilities?.output?.audio ?? false,
          image: existing?.capabilities?.output?.image ?? false,
          video: existing?.capabilities?.output?.video ?? false,
          pdf: existing?.capabilities?.output?.pdf ?? false,
        },
        interleaved: existing?.capabilities?.interleaved ?? false,
      },
      options: existing?.options ?? {},
      headers: existing?.headers ?? {},
      release_date: getReleaseDate(live.id, live.version, existing?.release_date ?? ""),
      variants: existing?.variants ?? {},
      status: "active",
    };
  }

  function buildProviderModels(existingModels, liveModels, baseURL) {
    const existingById = new Map(
      Object.values(existingModels ?? {}).map((model) => [model?.api?.id ?? model?.id, model]),
    );

    return Object.fromEntries(
      liveModels
        .filter(isPickerModel)
        .map((model) => [
          model.id,
          createProviderModel(existingById.get(model.id), model, baseURL),
        ]),
    );
  }

  function normalizeExistingModels(existingModels, baseURL) {
    return Object.fromEntries(
      Object.entries(existingModels ?? {}).map(([id, model]) => [
        id,
        {
          ...structuredClone(model),
          cost: zeroCost(),
          api: {
            ...model.api,
            url: baseURL ?? model.api?.url,
            npm: "@ai-sdk/github-copilot",
          },
        },
      ]),
    );
  }

  async function resolveProviderModels(existingModels, auth) {
    const baseURL = auth ? await getBaseURL(auth) : undefined;
    if (!auth || auth.type !== "oauth" || !baseURL) {
      return normalizeExistingModels(existingModels, baseURL);
    }

    const liveModels = await fetchModels(auth, baseURL);
    return buildProviderModels(existingModels, liveModels, baseURL);
  }

  function getHeader(headers, name) {
    if (!headers) return undefined;
    const target = name.toLowerCase();

    if (typeof Headers !== "undefined" && headers instanceof Headers) {
      return headers.get(name) ?? headers.get(target) ?? undefined;
    }

    if (Array.isArray(headers)) {
      const found = headers.find(([key]) => String(key).toLowerCase() === target);
      return found?.[1];
    }

    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === target) {
        return value;
      }
    }

    return undefined;
  }

  function getConversationMetadata(init) {
    try {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;

      if (body?.messages) {
        const lastMessage = body.messages[body.messages.length - 1];
        return {
          isVision: body.messages.some(
            (message) =>
              Array.isArray(message.content) &&
              message.content.some((part) => part.type === "image_url"),
          ),
          isAgent:
            lastMessage?.role &&
            ["tool", "assistant"].includes(lastMessage.role),
        };
      }

      if (body?.input) {
        const lastInput = body.input[body.input.length - 1];
        const isAssistant = lastInput?.role === "assistant";
        const hasAgentType = lastInput?.type
          ? RESPONSES_API_ALTERNATE_INPUT_TYPES.includes(lastInput.type)
          : false;

        return {
          isVision:
            Array.isArray(lastInput?.content) &&
            lastInput.content.some((part) => part.type === "input_image"),
          isAgent: isAssistant || hasAgentType,
        };
      }
    } catch {}

    return {
      isVision: false,
      isAgent: false,
    };
  }

  function buildHeaders(init, info, isVision, isAgent) {
    const explicitInitiator = getHeader(init?.headers, "x-initiator");
    const headers = {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${info.refresh}`,
      "Copilot-Integration-Id": "copilot-developer-cli",
      "Openai-Intent": "conversation-agent",
      "User-Agent": "opencode-copilot-cli-auth/0.0.16",
      "X-GitHub-Api-Version": API_VERSION,
      "X-Initiator": explicitInitiator ?? (isAgent ? "agent" : "user"),
      "X-Interaction-Id": crypto.randomUUID(),
      "X-Interaction-Type": "conversation-agent",
      "X-Request-Id": crypto.randomUUID(),
    };

    if (isVision) {
      headers["Copilot-Vision-Request"] = "true";
    }

    delete headers["x-api-key"];
    delete headers["authorization"];
    delete headers["x-initiator"];

    return headers;
  }

  function resolveClaudeThinkingBudget(model, variant) {
    if (!model?.id?.includes("claude")) return undefined;
    return variant === "thinking" ? 16000 : undefined;
  }

  // ---------------------------------------------------------------------------
  // OpenAI ↔ Anthropic translation for /v1/messages routing
  // ---------------------------------------------------------------------------

  function convertContentToAnthropic(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return content ?? "";
    return content.map((part) => {
      if (part.type === "text") return { type: "text", text: part.text };
      if (part.type === "image_url") {
        const url = part.image_url?.url ?? "";
        if (url.startsWith("data:")) {
          const match = url.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            return {
              type: "image",
              source: { type: "base64", media_type: match[1], data: match[2] },
            };
          }
        }
        return { type: "image", source: { type: "url", url } };
      }
      return part;
    });
  }

  function openAIToAnthropic(body) {
    const result = {
      model: body.model,
      max_tokens: body.max_tokens ?? 4096,
    };

    if (body.temperature !== undefined) result.temperature = body.temperature;
    if (body.stream !== undefined) result.stream = body.stream;
    if (body.stop) {
      result.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
    }
    if (body.thinking_budget) {
      result.thinking = { type: "enabled", budget_tokens: body.thinking_budget };
    }

    const msgs = body.messages ?? [];
    const systemMsgs = msgs.filter((m) => m.role === "system");
    const otherMsgs = msgs.filter((m) => m.role !== "system");

    if (systemMsgs.length > 0) {
      result.system = systemMsgs
        .map((m) =>
          typeof m.content === "string"
            ? m.content
            : (m.content ?? []).map((p) => p.text ?? "").join("")
        )
        .join("\n");
    }

    const anthropicMessages = [];
    for (const msg of otherMsgs) {
      if (msg.role === "tool") {
        const toolResult = {
          type: "tool_result",
          tool_use_id: msg.tool_call_id,
          content: msg.content ?? "",
        };
        const last = anthropicMessages[anthropicMessages.length - 1];
        if (last?.role === "user" && Array.isArray(last.content)) {
          last.content.push(toolResult);
        } else {
          anthropicMessages.push({ role: "user", content: [toolResult] });
        }
        continue;
      }

      if (msg.role === "assistant") {
        const blocks = [];
        if (msg.content) blocks.push({ type: "text", text: msg.content });
        for (const tc of msg.tool_calls ?? []) {
          let args = {};
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {}
          blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: args });
        }
        anthropicMessages.push({
          role: "assistant",
          content: blocks.length === 1 && blocks[0].type === "text" ? blocks[0].text : blocks,
        });
        continue;
      }

      anthropicMessages.push({ role: "user", content: convertContentToAnthropic(msg.content) });
    }

    result.messages = anthropicMessages;

    const tools = (body.tools ?? []).filter((t) => t.type === "function");
    if (tools.length > 0) {
      result.tools = tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters ?? { type: "object", properties: {} },
      }));

      const tc = body.tool_choice;
      if (tc && tc !== "none") {
        if (tc === "auto" || tc?.type === "auto") {
          result.tool_choice = { type: "auto" };
        } else if (tc === "required" || tc?.type === "required") {
          result.tool_choice = { type: "any" };
        } else if (tc?.type === "function") {
          result.tool_choice = { type: "tool", name: tc.function.name };
        }
      }
    }

    return result;
  }

  function anthropicToOpenAI(anthropicResp) {
    const content = anthropicResp.content ?? [];
    const textBlocks = content.filter((b) => b.type === "text");
    const toolBlocks = content.filter((b) => b.type === "tool_use");

    const STOP_REASON_MAP = {
      end_turn: "stop",
      max_tokens: "length",
      tool_use: "tool_calls",
      stop_sequence: "stop",
    };

    const message = {
      role: "assistant",
      content: textBlocks.map((b) => b.text).join("") || null,
    };
    if (toolBlocks.length > 0) {
      message.tool_calls = toolBlocks.map((b, i) => ({
        index: i,
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
    }

    return {
      id: anthropicResp.id ?? "unknown",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: anthropicResp.model ?? "",
      choices: [{ index: 0, message, finish_reason: STOP_REASON_MAP[anthropicResp.stop_reason] ?? "stop" }],
      usage: {
        prompt_tokens: anthropicResp.usage?.input_tokens ?? 0,
        completion_tokens: anthropicResp.usage?.output_tokens ?? 0,
        total_tokens: (anthropicResp.usage?.input_tokens ?? 0) + (anthropicResp.usage?.output_tokens ?? 0),
      },
    };
  }

  function createSSETranslator(model) {
    let buffer = "";
    let msgId = null;
    let inputTokens = 0;
    let outputTokens = 0;
    const blockTypes = {};
    const blockIndexToToolIndex = {};
    let nextToolIndex = 0;

    const STOP_REASON_MAP = {
      end_turn: "stop",
      max_tokens: "length",
      tool_use: "tool_calls",
      stop_sequence: "stop",
    };

    function makeChunk(delta, finishReason, usage) {
      const obj = {
        id: msgId ?? "unknown",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
      };
      if (usage) obj.usage = usage;
      return `data: ${JSON.stringify(obj)}\n\n`;
    }

    function handleEvent(eventType, data) {
      try {
        const ev = JSON.parse(data);
        const type = eventType ?? ev.type;
        switch (type) {
          case "message_start":
            msgId = ev.message?.id;
            inputTokens = ev.message?.usage?.input_tokens ?? 0;
            return makeChunk({ role: "assistant", content: "" }, null, null);

          case "content_block_start": {
            const idx = ev.index ?? 0;
            blockTypes[idx] = ev.content_block?.type;
            if (ev.content_block?.type === "tool_use") {
              const toolIdx = nextToolIndex++;
              blockIndexToToolIndex[idx] = toolIdx;
              return makeChunk(
                {
                  tool_calls: [{
                    index: toolIdx,
                    id: ev.content_block.id,
                    type: "function",
                    function: { name: ev.content_block.name, arguments: "" },
                  }],
                },
                null,
                null,
              );
            }
            return "";
          }

          case "content_block_delta": {
            const idx = ev.index ?? 0;
            const delta = ev.delta;
            if (delta?.type === "text_delta") {
              return makeChunk({ content: delta.text ?? "" }, null, null);
            }
            if (delta?.type === "input_json_delta") {
              const toolIdx = blockIndexToToolIndex[idx] ?? 0;
              return makeChunk(
                { tool_calls: [{ index: toolIdx, function: { arguments: delta.partial_json ?? "" } }] },
                null,
                null,
              );
            }
            return "";
          }

          case "content_block_stop":
            return "";

          case "message_delta":
            outputTokens = ev.usage?.output_tokens ?? 0;
            return makeChunk(
              {},
              STOP_REASON_MAP[ev.delta?.stop_reason] ?? "stop",
              {
                prompt_tokens: inputTokens,
                completion_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens,
              },
            );

          case "message_stop":
            return "data: [DONE]\n\n";

          default:
            return "";
        }
      } catch {
        return "";
      }
    }

    function parseBlock(block) {
      if (!block.trim()) return "";
      let eventType = null;
      let dataLine = null;
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) eventType = line.slice(7).trim();
        else if (line.startsWith("data: ")) dataLine = line.slice(6);
      }
      return dataLine !== null ? handleEvent(eventType, dataLine) : "";
    }

    return {
      processChunk(text) {
        buffer += text;
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        return blocks.map(parseBlock).join("");
      },
      flush() {
        return buffer.trim() ? parseBlock(buffer) : "";
      },
    };
  }

  function translateStreamResponse(anthropicResponse, model) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const translator = createSSETranslator(model);

    return new Response(
      anthropicResponse.body.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            const out = translator.processChunk(decoder.decode(chunk, { stream: true }));
            if (out) controller.enqueue(encoder.encode(out));
          },
          flush(controller) {
            const out = translator.flush();
            if (out) controller.enqueue(encoder.encode(out));
          },
        }),
      ),
      { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } },
    );
  }

  async function translateAndFetch(chatCompletionsUrl, headers, openAIBody) {
    const messagesUrl = chatCompletionsUrl.replace(/\/chat\/completions(\?.*)?$/, "/v1/messages$1");
    const anthropicBody = openAIToAnthropic(openAIBody);

    const response = await fetch(messagesUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(anthropicBody),
    });

    if (!response.ok) return response;

    if (anthropicBody.stream) return translateStreamResponse(response, openAIBody.model);

    const data = await response.json();
    return new Response(JSON.stringify(anthropicToOpenAI(data)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  return {
    provider: {
      id: "github-copilot",
      models: async (provider, ctx) => {
        try {
          return await resolveProviderModels(provider.models, ctx.auth);
        } catch (error) {
          console.warn("[opencode-copilot-cli-auth] Failed to sync live Copilot models.", error);
          return normalizeExistingModels(provider.models);
        }
      },
    },
    auth: {
      provider: "github-copilot",
      loader: async (getAuth) => {
        const info = await getAuth();
        if (!info || info.type !== "oauth") return {};

        const baseURL = await getBaseURL(info);

        return {
          ...(baseURL && { baseURL }),
          apiKey: "",
          async fetch(input, init) {
            const auth = await getAuth();
            if (!auth || auth.type !== "oauth") {
              return fetch(input, init);
            }

            const { isVision, isAgent } = getConversationMetadata(init);
            const headers = buildHeaders(init, auth, isVision, isAgent);

            // Route Claude models with /v1/messages support to the native Anthropic endpoint
            const url = input instanceof Request ? input.url : String(input);
            const pathname = (() => { try { return new URL(url).pathname; } catch { return url; } })();
            if (pathname.endsWith("/chat/completions") && init?.body && messagesEndpointModels.size > 0) {
              let body;
              try {
                body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
              } catch {}
              if (body?.model && messagesEndpointModels.has(body.model)) {
                return translateAndFetch(url, headers, body);
              }
            }

            return fetch(input, {
              ...init,
              headers,
            });
          },
        };
      },
      methods: [
        {
          type: "oauth",
          label: "Login with GitHub Copilot CLI",
          prompts: [
            {
              type: "select",
              key: "deploymentType",
              message: "Select GitHub deployment type",
              options: [
                {
                  label: "GitHub.com",
                  value: "github.com",
                  hint: "Public",
                },
                {
                  label: "GitHub Enterprise",
                  value: "enterprise",
                  hint: "Data residency or self-hosted",
                },
              ],
            },
            {
              type: "text",
              key: "enterpriseUrl",
              message: "Enter your GitHub Enterprise URL or domain",
              placeholder: "company.ghe.com or https://company.ghe.com",
              condition: (inputs) => inputs.deploymentType === "enterprise",
              validate: (value) => {
                if (!value) return "URL or domain is required";
                try {
                  const url = value.includes("://")
                    ? new URL(value)
                    : new URL(`https://${value}`);
                  if (!url.hostname) {
                    return "Please enter a valid URL or domain";
                  }
                  return undefined;
                } catch {
                  return "Please enter a valid URL (e.g., company.ghe.com or https://company.ghe.com)";
                }
              },
            },
          ],
          async authorize(inputs = {}) {
            const deploymentType = inputs.deploymentType || "github.com";

            let domain = "github.com";
            let actualProvider = "github-copilot";

            if (deploymentType === "enterprise") {
              domain = normalizeDomain(inputs.enterpriseUrl);
              actualProvider = "github-copilot-enterprise";
            }

            const urls = getUrls(domain);

            const deviceResponse = await fetch(urls.DEVICE_CODE_URL, {
              method: "POST",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "User-Agent": "opencode-copilot-cli-auth/0.0.16",
              },
              body: JSON.stringify({
                client_id: CLIENT_ID,
                scope: OAUTH_SCOPES,
              }),
            });

            if (!deviceResponse.ok) {
              throw new Error("Failed to initiate device authorization");
            }

            const deviceData = await deviceResponse.json();

            return {
              url: deviceData.verification_uri,
              instructions: `Enter code: ${deviceData.user_code}`,
              method: "auto",
              callback: async () => {
                while (true) {
                  const response = await fetch(urls.ACCESS_TOKEN_URL, {
                    method: "POST",
                    headers: {
                      Accept: "application/json",
                      "Content-Type": "application/json",
                      "User-Agent": "opencode-copilot-cli-auth/0.0.16",
                    },
                    body: JSON.stringify({
                      client_id: CLIENT_ID,
                      device_code: deviceData.device_code,
                      grant_type:
                        "urn:ietf:params:oauth:grant-type:device_code",
                    }),
                  });

                  if (!response.ok) return { type: "failed" };

                  const data = await response.json();

                  if (data.access_token) {
                    const entitlement = await fetchEntitlement({
                      refresh: data.access_token,
                      enterpriseUrl:
                        actualProvider === "github-copilot-enterprise"
                          ? domain
                          : undefined,
                    });

                    const result = {
                      type: "success",
                      refresh: data.access_token,
                      access: data.access_token,
                      expires: 0,
                      baseUrl: entitlement?.endpoints?.api,
                    };

                    if (actualProvider === "github-copilot-enterprise") {
                      result.provider = "github-copilot-enterprise";
                      result.enterpriseUrl = domain;
                    }

                    return result;
                  }

                  if (data.error === "authorization_pending") {
                    await new Promise((resolve) =>
                      setTimeout(
                        resolve,
                        deviceData.interval * 1000
                          + OAUTH_POLLING_SAFETY_MARGIN_MS,
                      ),
                    );
                    continue;
                  }

                  if (data.error === "slow_down") {
                    const nextInterval =
                      (typeof data.interval === "number" && data.interval > 0 ?
                        data.interval
                      : deviceData.interval + 5) * 1000;
                    await new Promise((resolve) =>
                      setTimeout(
                        resolve,
                        nextInterval + OAUTH_POLLING_SAFETY_MARGIN_MS,
                      ),
                    );
                    continue;
                  }

                  if (data.error) return { type: "failed" };

                  await new Promise((resolve) =>
                    setTimeout(
                      resolve,
                      deviceData.interval * 1000
                        + OAUTH_POLLING_SAFETY_MARGIN_MS,
                    ),
                  );
                }
              },
            };
          },
        },
      ],
    },
    "chat.params": async (input, output) => {
      if (input.model.providerID !== "github-copilot") return;
      if (input.model.api?.npm !== "@ai-sdk/github-copilot") return;
      if (!input.model.id.includes("claude")) return;

      const thinkingBudget = resolveClaudeThinkingBudget(input.model, input.message.variant);
      if (thinkingBudget === undefined) return;

      output.options.thinking_budget = thinkingBudget;
    },
    "chat.headers": async (incoming, output) => {
      if (!incoming.model.providerID.includes("github-copilot")) return;

      const sdk = input.client;
      if (!sdk?.session?.message || !sdk?.session?.get) return;

      const parts = await sdk.session
        .message({
          path: {
            id: incoming.message.sessionID,
            messageID: incoming.message.id,
          },
          query: {
            directory: input.directory,
          },
          throwOnError: true,
        })
        .catch(() => undefined);

      if (parts?.data?.parts?.some((part) => part.type === "compaction")) {
        output.headers["x-initiator"] = "agent";
        return;
      }

      const session = await sdk.session
        .get({
          path: {
            id: incoming.sessionID,
          },
          query: {
            directory: input.directory,
          },
          throwOnError: true,
        })
        .catch(() => undefined);

      if (!session?.data?.parentID) return;

      output.headers["x-initiator"] = "agent";
    },
  };
}
