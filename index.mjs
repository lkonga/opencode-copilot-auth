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
    return Array.isArray(data?.data) ? data.data : [];
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
