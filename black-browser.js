const Logger = {
  enabled: true,
  output(...messages) {
    if (!this.enabled) return;
    const timestamp =
      new Date().toLocaleTimeString("zh-CN", { hour12: false }) +
      "." +
      new Date().getMilliseconds().toString().padStart(3, "0");
    console.log(`[ProxyClient] ${timestamp}`, ...messages);
    const logElement = document.createElement("div");
    logElement.textContent = `[${timestamp}] ${messages.join(" ")}`;
    document.body.appendChild(logElement);
  },
};

class ConnectionManager extends EventTarget {
  // =================================================================
  // ===                 *** 请修改此行   *** ===
  constructor(endpoint = "ws://127.0.0.1:9998") {
    // =================================================================
    super();
    this.endpoint = endpoint;
    this.socket = null;
    this.isConnected = false;
    this.reconnectDelay = 5000;
    this.reconnectAttempts = 0;
  }

  async establish() {
    if (this.isConnected) return Promise.resolve();
    Logger.output("正在连接到服务器:", this.endpoint);
    return new Promise((resolve, reject) => {
      try {
        this.socket = new WebSocket(this.endpoint);
        this.socket.addEventListener("open", () => {
          this.isConnected = true;
          this.reconnectAttempts = 0;
          Logger.output("✅ 连接成功!");
          this.dispatchEvent(new CustomEvent("connected"));
          resolve();
        });
        this.socket.addEventListener("close", () => {
          this.isConnected = false;
          Logger.output("❌ 连接已断开，准备重连...");
          this.dispatchEvent(new CustomEvent("disconnected"));
          this._scheduleReconnect();
        });
        this.socket.addEventListener("error", (error) => {
          Logger.output(" WebSocket 连接错误:", error);
          this.dispatchEvent(new CustomEvent("error", { detail: error }));
          if (!this.isConnected) reject(error);
        });
        this.socket.addEventListener("message", (event) => {
          this.dispatchEvent(
            new CustomEvent("message", { detail: event.data })
          );
        });
      } catch (e) {
        Logger.output(
          "WebSocket 初始化失败。请检查地址或浏览器安全策略。",
          e.message
        );
        reject(e);
      }
    });
  }

  transmit(data) {
    if (!this.isConnected || !this.socket) {
      Logger.output("无法发送数据：连接未建立");
      return false;
    }
    this.socket.send(JSON.stringify(data));
    return true;
  }

  _scheduleReconnect() {
    this.reconnectAttempts++;
    setTimeout(() => {
      Logger.output(`正在进行第 ${this.reconnectAttempts} 次重连尝试...`);
      this.establish().catch(() => {});
    }, this.reconnectDelay);
  }
}

class RequestProcessor {
  constructor() {
    this.activeOperations = new Map();
    this.cancelledOperations = new Set();
    this.targetDomain = "generativelanguage.googleapis.com";
    this.maxRetries = 3; // 最多尝试3次
    this.retryDelay = 2000; // 每次重试前等待2秒
  }

  execute(requestSpec, operationId) {
    const IDLE_TIMEOUT_DURATION = 600000;
    const abortController = new AbortController();
    this.activeOperations.set(operationId, abortController);

    let timeoutId = null;

    const startIdleTimeout = () => {
      return new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          const error = new Error(
            `超时: ${IDLE_TIMEOUT_DURATION / 1000} 秒内未收到任何数据`
          );
          abortController.abort();
          reject(error);
        }, IDLE_TIMEOUT_DURATION);
      });
    };

    const cancelTimeout = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        Logger.output("已收到数据块，超时限制已解除。");
      }
    };

    const attemptPromise = new Promise(async (resolve, reject) => {
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        try {
          Logger.output(
            `执行请求 (尝试 ${attempt}/${this.maxRetries}):`,
            requestSpec.method,
            requestSpec.path
          );

          const requestUrl = this._constructUrl(requestSpec);
          const requestConfig = this._buildRequestConfig(
            requestSpec,
            abortController.signal
          );

          const response = await fetch(requestUrl, requestConfig);

          if (!response.ok) {
            const errorBody = await response.text();
            const error = new Error(
              `Google API返回错误: ${response.status} ${response.statusText} ${errorBody}`
            );
            error.status = response.status;
            throw error;
          }

          resolve(response);
          return;
        } catch (error) {
          if (error.name === "AbortError") {
            reject(error);
            return;
          }
          const isNetworkError = error.message.includes("Failed to fetch");
          const isRetryableServerError =
            error.status && [500, 502, 503, 504].includes(error.status);
          if (
            (isNetworkError || isRetryableServerError) &&
            attempt < this.maxRetries
          ) {
            Logger.output(
              `❌ 请求尝试 #${attempt} 失败: ${error.message.substring(0, 200)}`
            );
            Logger.output(`将在 ${this.retryDelay / 1000}秒后重试...`);
            await new Promise((r) => setTimeout(r, this.retryDelay));
            continue;
          } else {
            reject(error);
            return;
          }
        }
      }
    });

    const responsePromise = Promise.race([attemptPromise, startIdleTimeout()]);

    return { responsePromise, cancelTimeout };
  }

  cancelAllOperations() {
    this.activeOperations.forEach((controller, id) => controller.abort());
    this.activeOperations.clear();
  }

  _constructUrl(requestSpec) {
    let pathSegment = requestSpec.path.startsWith("/")
      ? requestSpec.path.substring(1)
      : requestSpec.path;
    const queryParams = new URLSearchParams(requestSpec.query_params);

    // 1. 设定安全的默认值
    if (!requestSpec.streaming_mode) {
      requestSpec.streaming_mode = "real";
    }

    // 2. 检查用户是否通过前缀强制要求假流式
    if (pathSegment.includes("/假流式/")) {
      // 移除前缀，得到干净的模型路径
      pathSegment = pathSegment.replace("/假流式/", "/");
      // 强制设定为假流式模式，这将覆盖来自服务器的任何设置
      requestSpec.streaming_mode = "fake"; 
      Logger.output(`检测到 "假流式/" 前缀，已激活假流式模式。修正路径为: ${pathSegment}`);
    }

    // 增强的后缀移除逻辑，可以处理组合后缀
    const [modelPart, actionPart] = pathSegment.split(":");
    if (actionPart !== undefined) { // 确保路径中包含 ":"
      const originalModelPart = modelPart;
      const cleanedModelPart = originalModelPart
        .replace("-search", "");

      if (originalModelPart !== cleanedModelPart) {
        pathSegment = `${cleanedModelPart}:${actionPart}`;
        Logger.output(`检测到自定义后缀，已修正API路径为: ${pathSegment}`);
      }
    }
    
    if (requestSpec.streaming_mode === "fake") {
      Logger.output("假流式模式激活，正在修改请求...");
      if (pathSegment.includes(":streamGenerateContent")) {
        pathSegment = pathSegment.replace(
          ":streamGenerateContent",
          ":generateContent"
        );
        Logger.output(`API路径已修改为: ${pathSegment}`);
      }
      if (queryParams.has("alt") && queryParams.get("alt") === "sse") {
        queryParams.delete("alt");
        Logger.output('已移除 "alt=sse" 查询参数。');
      }
    }
    const queryString = queryParams.toString();
    return `https://${this.targetDomain}/${pathSegment}${
      queryString ? "?" + queryString : ""
    }`;
  }

  _buildRequestConfig(requestSpec, signal) {
    const config = {
      method: requestSpec.method,
      headers: this._sanitizeHeaders(requestSpec.headers),
      signal,
    };

    if (
      ["POST", "PUT", "PATCH"].includes(requestSpec.method) &&
      requestSpec.body
    ) {
      try {
        let bodyObj = JSON.parse(requestSpec.body);
        const path = requestSpec.path;
        // --- 模块0：加入 "-search"等模式 ---
        // --- 模块0：正确配置联网搜索和工具使用思考 ---
        if (requestSpec.path.includes("-search")) {
          if (!bodyObj.tools) {
            bodyObj.tools = [{
              "google_search": {}
            }];
            Logger.output("✅ 检测到 '-search' 后缀，已为请求开启联网模式。");
          }
        }

        // --- 模块1：智能过滤 ---
        const isImageModel =
          requestSpec.path.includes("-image-") ||
          requestSpec.path.includes("imagen");
            
        if (isImageModel) {
          const incompatibleKeys = ["tool_config", "toolChoice", "tools"];
          incompatibleKeys.forEach((key) => {
            if (bodyObj.hasOwnProperty(key)) delete bodyObj[key];
          });
          if (bodyObj.generationConfig?.thinkingConfig) {
            delete bodyObj.generationConfig.thinkingConfig;
          }
        }
        
        // [已移除] 模块2：智能签名逻辑已被删除

        config.body = JSON.stringify(bodyObj);
      } catch (e) {
        Logger.output("处理请求体时发生错误:", e.message);
        config.body = requestSpec.body;
      }
    }

    return config;
  }

  _sanitizeHeaders(headers) {
    const sanitized = { ...headers };
    [
      "host",
      "connection",
      "content-length",
      "origin",
      "referer",
      "user-agent",
      "sec-fetch-mode",
      "sec-fetch-site",
      "sec-fetch-dest",
    ].forEach((h) => delete sanitized[h]);
    return sanitized;
  }
  cancelOperation(operationId) {
    this.cancelledOperations.add(operationId);
    const controller = this.activeOperations.get(operationId);
    if (controller) {
      Logger.output(`收到取消指令，正在中止操作 #${operationId}...`);
      controller.abort();
    }
  }
}

class ProxySystem extends EventTarget {
  constructor(websocketEndpoint) {
    super();
    this.connectionManager = new ConnectionManager(websocketEndpoint);
    this.requestProcessor = new RequestProcessor();
    this._setupEventHandlers();
  }

  async initialize() {
    Logger.output("系统初始化中...");
    try {
      await this.connectionManager.establish();
      Logger.output("系统初始化完成，等待服务器指令...");
      this.dispatchEvent(new CustomEvent("ready"));
    } catch (error) {
      Logger.output("系统初始化失败:", error.message);
      this.dispatchEvent(new CustomEvent("error", { detail: error }));
      throw error;
    }
  }

  _setupEventHandlers() {
    this.connectionManager.addEventListener("message", (e) =>
      this._handleIncomingMessage(e.detail)
    );
    this.connectionManager.addEventListener("disconnected", () =>
      this.requestProcessor.cancelAllOperations()
    );
  }

  async _handleIncomingMessage(messageData) {
    let requestSpec = {};
    try {
      requestSpec = JSON.parse(messageData);

      switch (requestSpec.event_type) {
        case "cancel_request":
          this.requestProcessor.cancelOperation(requestSpec.request_id);
          break;
        default:
          Logger.output(`收到请求: ${requestSpec.method} ${requestSpec.path}`);
          await this._processProxyRequest(requestSpec);
          break;
      }
    } catch (error) {
      Logger.output("消息处理错误:", error.message);
      if (
        requestSpec.request_id &&
        requestSpec.event_type !== "cancel_request"
      ) {
        this._sendErrorResponse(error, requestSpec.request_id);
      }
    }
  }


  async _processProxyRequest(requestSpec) {
    const operationId = requestSpec.request_id;
    try {
        const { responsePromise, cancelTimeout } = this.requestProcessor.execute(requestSpec, operationId);
        const response = await responsePromise;
        this._transmitHeaders(response, operationId);
        if (!response.body) {
            this._transmitStreamEnd(operationId);
            return;
        }
        const reader = response.body.getReader();
        const textDecoder = new TextDecoder();
        let buffer = "";
        let isThinking = false;
        let firstChunkReceived = false;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!firstChunkReceived) {
                cancelTimeout();
                firstChunkReceived = true;
            }
            buffer += textDecoder.decode(value, { stream: true });
            let newlineIndex;
            while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                const line = buffer.substring(0, newlineIndex).trim();
                buffer = buffer.substring(newlineIndex + 1);
                if (line.length === 0 || !line.startsWith('data:')) continue;
                let jsonStr = line.substring(5).trim();
                if (jsonStr.startsWith(',')) jsonStr = jsonStr.substring(1);
                try {
                    const data = JSON.parse(jsonStr);
                    const toolCallParts = data.candidates?.[0]?.content?.parts?.filter(p => p.functionCall);
                    const textParts = data.candidates?.[0]?.content?.parts?.filter(p => p.text);

                    // Gemini 1.5 Pro 的思考过程在 functionCall.thought 中
                    if (toolCallParts && toolCallParts.length > 0) {
                        for (const part of toolCallParts) {
                            const thoughtText = part.functionCall.thought;
                            if (thoughtText && typeof thoughtText === 'string') {
                                if (!isThinking) {
                                    this._transmitChunk("\n```thought\n", operationId);
                                    isThinking = true;
                                }
                                this._transmitChunk(thoughtText, operationId);
                            }
                        }
                    }
                    
                    if (textParts && textParts.length > 0) {
                         for (const part of textParts) {
                            const regularText = part.text;
                            if (regularText) {
                                if (isThinking) {
                                    this._transmitChunk("\n```\n\n", operationId);
                                    isThinking = false;
                                }
                                this._transmitChunk(regularText, operationId);
                            }
                        }
                    }
                } catch (e) {
                    // 安全地忽略任何无法解析的行
                }
            }
        }
        if (isThinking) {
            this._transmitChunk("\n```\n\n", operationId);
        }
        this._transmitStreamEnd(operationId);
    } catch (error) {
        this._sendErrorResponse(error, operationId);
    }
  }

  _transmitHeaders(response, operationId) {
    const headerMap = {};
    response.headers.forEach((v, k) => { headerMap[k] = v; });
    this.connectionManager.transmit({
      request_id: operationId,
      event_type: "response_headers",
      status: response.status,
      headers: headerMap,
    });
  }

  _transmitChunk(chunk, operationId) {
    if (!chunk) return;
    this.connectionManager.transmit({
      request_id: operationId,
      event_type: "chunk",
      data: chunk,
    });
  }

  _transmitStreamEnd(operationId) {
    this.connectionManager.transmit({
      request_id: operationId,
      event_type: "stream_close",
    });
  }

  _sendErrorResponse(error, operationId) {
    if (!operationId) return;
    this.connectionManager.transmit({
      request_id: operationId,
      event_type: "error",
      status: error.status || 504,
      message: `代理端浏览器错误: ${error.message || "未知错误"}`,
    });
  }
}

async function initializeProxySystem() {
  document.body.innerHTML = "";
  const proxySystem = new ProxySystem();
  try {
    await proxySystem.initialize();
  } catch (error) {
    console.error("代理系统启动失败:", error);
    Logger.output("代理系统启动失败:", error.message);
  }
}

initializeProxySystem();
