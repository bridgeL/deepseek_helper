// 状态管理
const state = {
    currentAssistantMessageId: null,
    historyVisible: false,
    controlsVisible: false,
    isResizing: false,
    startX: 0,
    startWidth: 0,
};

// DOM 元素缓存
const elements = {
    vscode: window.acquireVsCodeApi?.() || null,
    responseContainer: document.getElementById("responseContainer"),
    controlsContainer: document.getElementById("controlsContainer"),
    toggleControlsBtn: document.getElementById("toggleControls"),
    toggleHistoryBtn: document.getElementById("toggleHistory"),
    newConversationBtn: document.getElementById("newConversation"),
    selectFilesBtn: document.getElementById("selectFiles"),
    estimateTokensBtn: document.getElementById("estimateTokens"),
    sendRequestBtn: document.getElementById("sendRequest"),
    userInput: document.getElementById("userInput"),
    excludeDirsInput: document.getElementById("excludeDirs"),
    fileTypesInput: document.getElementById("fileTypes"),
    historyCountSelect: document.getElementById("historyCount"),
    statusEl: document.getElementById("status"),
    filesContainer: document.getElementById("filesContainer"),
    resizeHandle: document.querySelector(".resize-handle"),
    conversationHistory: document.getElementById("conversationHistory"),
    conversationList: document.getElementById("conversationList"),
};

// 初始化应用
function initializeApp() {
    // 设置事件监听
    // 控制面板切换
    elements.toggleControlsBtn.addEventListener("click", handleToggleControls);

    // 历史面板切换
    elements.toggleHistoryBtn.addEventListener("click", handleToggleHistory);

    // 新建对话
    elements.newConversationBtn.addEventListener(
        "click",
        handleNewConversation
    );

    // 文件操作
    elements.selectFilesBtn.addEventListener("click", handleSelectFiles);
    elements.estimateTokensBtn.addEventListener("click", handleEstimateTokens);
    elements.sendRequestBtn.addEventListener("click", handleSendRequest);

    // 来自扩展的消息
    window.addEventListener("message", handleExtensionMessages);

    // 请求初始数据
    elements.vscode.postMessage({ command: "init" });
}

// 控制面板切换处理
function handleToggleControls() {
    state.controlsVisible = !state.controlsVisible;
    elements.controlsContainer.classList.toggle(
        "visible",
        state.controlsVisible
    );
}

// 历史面板切换处理
function handleToggleHistory() {
    state.historyVisible = !state.historyVisible;
    elements.conversationHistory.classList.toggle(
        "visible",
        state.historyVisible
    );
}

// 新建对话处理
function handleNewConversation() {
    elements.vscode.postMessage({ command: "newConversation" });
}

// 选择文件处理
function handleSelectFiles() {
    const fileTypes = elements.fileTypesInput.value
        .trim()
        .split(" ")
        .filter((type) => type.startsWith("."))
        .map((type) => type.substring(1));

    if (fileTypes.length === 0) {
        updateStatus("Please enter valid file types (e.g. .js .html .css)");
        return;
    }

    elements.vscode.postMessage({
        command: "selectFiles",
        fileTypes: fileTypes,
        excludeDirs: elements.excludeDirsInput.value.trim(),
    });
}

// 估算令牌处理
function handleEstimateTokens() {
    elements.vscode.postMessage({ command: "estimateTokens" });
}

// 发送请求处理
function handleSendRequest() {
    const text = elements.userInput.value.trim();
    if (!text) {
        updateStatus("Please enter your question");
        return;
    }

    elements.vscode.postMessage({
        command: "sendRequest",
        text: text,
        historyCount: elements.historyCountSelect.value,
    });

    elements.userInput.value = "";
}

// 处理来自扩展的消息
function handleExtensionMessages(event) {
    const message = event.data;

    switch (message.command) {
        case "updateStatus":
            updateStatus(message.text);
            break;
        case "updateFileList":
            updateFileList(message.files);
            break;
        case "showTokenEstimate":
            showTokenEstimate(message.estimate);
            break;
        case "addMessage":
            addMessage(message);
            break;
        case "updateMessage":
            updateMessage(message);
            break;
        case "updateConversation":
            updateConversationView(message.conversation, message.history);
            break;
        default:
            console.warn("Unknown message:", message);
    }
}

// 更新状态显示
function updateStatus(text) {
    elements.statusEl.textContent = text;
}

// 更新文件列表
function updateFileList(files) {
    updateStatus("Files selected. Click 'Send Request' to proceed.");
    elements.filesContainer.innerHTML = files
        .map((file) => `<div class="file-item">${file}</div>`)
        .join("");
    elements.filesContainer.style.display = "block";
}

// 显示令牌估算
function showTokenEstimate(estimate) {
    elements.statusEl.textContent = estimate;
}

// 添加消息到UI
function addMessage(message) {
    const container = createMessageElement(
        message.role,
        message.content,
        message.timestamp,
        message.id
    );

    elements.responseContainer.appendChild(container);
    elements.responseContainer.scrollTop =
        elements.responseContainer.scrollHeight;

    if (message.role === "assistant") {
        state.currentAssistantMessageId = message.id;
    }
}

// 更新消息内容
function updateMessage(message) {
    const messageEl = document.getElementById(message.id);
    if (!messageEl) return;

    const contentEl = messageEl.querySelector(".message-content");
    if (contentEl) {
        contentEl.innerHTML = renderCodeBlocks(escapeHtml(message.content));
    }

    const timeEl = messageEl.querySelector(".message-time");
    if (timeEl) {
        timeEl.textContent = formatTime(message.timestamp);
    }

    // elements.responseContainer.scrollTop =
    //     elements.responseContainer.scrollHeight;
}

// 更新对话视图
function updateConversationView(conversation, history) {
    clearResponseContainer();

    if (conversation?.messages) {
        conversation.messages.forEach((msg) => {
            addMessage(msg);
        });
    }

    updateHistoryPanel(history, conversation?.id);
}

// 清空消息容器
function clearResponseContainer() {
    elements.responseContainer.innerHTML = "";
}

// 更新历史面板
function updateHistoryPanel(history, currentId) {
    elements.conversationList.innerHTML = history
        .map(
            (conv) => `
      <div class="conversation-item ${conv.id === currentId ? "active" : ""}" 
           data-id="${conv.id}">
        <div class="conversation-item-content">
          <div>${formatTime(conv.createdAt)}</div>
          <div class="conversation-preview">${
              conv.preview || "New conversation"
          }</div>
        </div>
        <div class="conversation-item-actions">
          <button class="delete-conversation" data-id="${conv.id}">×</button>
        </div>
      </div>
    `
        )
        .join("");

    setupHistoryItemEvents();
}

// 设置历史项事件
function setupHistoryItemEvents() {
    // 删除按钮
    document.querySelectorAll(".delete-conversation").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            elements.vscode.postMessage({
                command: "deleteConversation",
                conversationId: btn.dataset.id,
            });
        });
    });

    // 对话切换
    document.querySelectorAll(".conversation-item").forEach((item) => {
        item.addEventListener("click", () => {
            elements.vscode.postMessage({
                command: "switchConversation",
                conversationId: item.dataset.id,
            });
        });
    });
}

// 工具函数: 创建消息元素
function createMessageElement(role, content, timestamp, id = "") {
    const container = document.createElement("div");
    container.className = "message-container";
    if (id) container.id = id;

    const messageDiv = document.createElement("div");
    messageDiv.className = `message ${role}-message`;

    const contentDiv = document.createElement("div");
    contentDiv.className = "message-content";
    contentDiv.innerHTML = renderCodeBlocks(escapeHtml(content));

    const timeDiv = document.createElement("div");
    timeDiv.className = "message-time";
    timeDiv.textContent = formatTime(timestamp);

    messageDiv.appendChild(contentDiv);
    messageDiv.appendChild(timeDiv);
    container.appendChild(messageDiv);

    return container;
}

// 工具函数: 渲染代码块
function renderCodeBlocks(content) {
    return content.replace(
        /```(\w*)\n([\s\S]*?)\n```/g,
        '<div class="code-block"><pre>$2</pre><span class="lang-tag">$1</span></div>'
    );
}

// 工具函数: HTML转义
function escapeHtml(unsafe) {
    if (!unsafe) return "";
    return unsafe
        .toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// 工具函数: 格式化时间
function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
    });
}

// 启动应用
document.addEventListener("DOMContentLoaded", initializeApp);
