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
    if (isCurrentConversationEmpty()) {
        // 如果当前已经是空对话，就不需要新建
        updateStatus("Current conversation is already empty");
        return;
    }
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
    elements.vscode.postMessage({
        command: "estimateTokens",
        text: elements.userInput.value.trim(),
        historyCount: elements.historyCountSelect.value,
    });
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
        // 清空现有内容
        contentEl.innerHTML = "";
        // 添加新的内容
        contentEl.appendChild(renderContent(message.content, false));
    }

    // elements.responseContainer.scrollTop =
    //     elements.responseContainer.scrollHeight;
}

// 更新对话视图
function updateConversationView(conversation, history) {
    clearResponseContainer();

    if (conversation?.messages && conversation.messages.length > 0) {
        conversation.messages.forEach((msg) => {
            addMessage(msg);
        });
    } else {
        showBlankConversation();
    }

    updateHistoryPanel(history, conversation?.id);
}

// 检查当前对话是否为空
function isCurrentConversationEmpty() {
    const messages = document.querySelectorAll(".message-container");
    return messages.length === 0;
}

// 显示空白对话提示
function showBlankConversation() {
    const blankDiv = document.createElement("div");
    blankDiv.className = "blank-conversation";
    blankDiv.textContent = "Blank Conversation";
    elements.responseContainer.appendChild(blankDiv);
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
    contentDiv.appendChild(renderContent(content, false));

    const timeDiv = document.createElement("div");
    timeDiv.className = "message-time";
    timeDiv.textContent = formatTime(timestamp);

    // 添加复制按钮
    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-btn";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(content).catch((err) => {
            console.error("Failed to copy: ", err);
        });
        updateStatus("Copied to clipboard!");
    });

    messageDiv.appendChild(contentDiv);
    messageDiv.appendChild(timeDiv);
    messageDiv.appendChild(copyBtn); // 添加复制按钮
    container.appendChild(messageDiv);

    return container;
}

function parseMixedContent(content, prefer_code = false) {
    const result = [];
    let index = 0;
    let state = "text";
    const length = content.length;

    while (index < length) {
        if (state === "text") {
            const blockStart = content.indexOf("```", index);
            if (blockStart !== -1) {
                const textContent = content.slice(index, blockStart);
                if (textContent) {
                    result.push(...parseTextSnip(textContent, prefer_code));
                }
                state = "code";
                index = blockStart + 3; // 跳过```
            } else {
                const textContent = content.slice(index);
                if (textContent) {
                    result.push(...parseTextSnip(textContent, prefer_code));
                }
                break;
            }
        } else if (state === "code") {
            const blockEnd = content.indexOf("```", index);
            if (blockEnd !== -1) {
                const codeContent = content.slice(index, blockEnd).trim();

                // 修改后的语言检测逻辑
                let language = "";
                let pureCode = codeContent;
                const firstNewLine = codeContent.indexOf("\n");

                if (firstNewLine !== -1) {
                    const potentialLang = codeContent
                        .slice(0, firstNewLine)
                        .trim();
                    // 只有当第一行看起来像语言标记时才视为语言
                    if (/^[a-zA-Z0-9+#-]+$/.test(potentialLang)) {
                        language = potentialLang;
                        pureCode = codeContent.slice(firstNewLine + 1);
                    }
                }

                result.push({
                    type: "code",
                    language: language,
                    content: pureCode.trim(),
                    closed: true,
                });
                state = "text";
                index = blockEnd + 3;
            } else {
                const codeContent = content.slice(index).trim();
                if (prefer_code) {
                    let language = "";
                    let pureCode = codeContent;
                    const firstNewLine = codeContent.indexOf("\n");

                    if (firstNewLine !== -1) {
                        const potentialLang = codeContent
                            .slice(0, firstNewLine)
                            .trim();
                        if (/^[a-zA-Z0-9+#-]+$/.test(potentialLang)) {
                            language = potentialLang;
                            pureCode = codeContent.slice(firstNewLine + 1);
                        }
                    }

                    result.push({
                        type: "code",
                        language: language,
                        content: pureCode.trim(),
                        closed: false,
                    });
                } else {
                    result.push({
                        type: "text",
                        content: "```" + codeContent,
                    });
                }
                break;
            }
        }
    }

    return result;
}

function parseTextSnip(content, prefer_code = false) {
    const result = [];
    let index = 0;
    let state = "text";
    const length = content.length;

    while (index < length) {
        if (state === "text") {
            // 在text状态下查找行内代码起始标记
            const snipStart = content.indexOf("`", index);
            if (snipStart !== -1) {
                // 处理纯文本内容
                const textContent = content.slice(index, snipStart);
                if (textContent) {
                    result.push({
                        type: "text",
                        content: textContent,
                    });
                }
                // 切换到snip状态
                state = "snip";
                index = snipStart + 1; // 跳过`
            } else {
                // 没有更多行内代码，处理剩余文本
                const textContent = content.slice(index);
                if (textContent) {
                    result.push({
                        type: "text",
                        content: textContent,
                    });
                }
                break;
            }
        } else if (state === "snip") {
            // 在snip状态下查找行内代码结束标记
            const snipEnd = content.indexOf("`", index);
            if (snipEnd !== -1) {
                // 提取行内代码内容
                const snipContent = content.slice(index, snipEnd).trim();
                if (snipContent) {
                    result.push({
                        type: "snip",
                        content: snipContent,
                    });
                }
                // 切换回text状态
                state = "text";
                index = snipEnd + 1; // 跳过`
            } else {
                // 未闭合的行内代码
                const snipContent = content.slice(index).trim();
                if (prefer_code) {
                    result.push({
                        type: "snip",
                        content: snipContent,
                    });
                } else {
                    // 视为普通文本（补回开头的`）
                    result.push({
                        type: "text",
                        content: "`" + snipContent,
                    });
                }
                break;
            }
        }
    }

    return result;
}

// 工具函数: 渲染内容为DOM元素
function renderContent(content, need_escape) {
    const container = document.createElement("div");
    const parsedContent = parseMixedContent(content, true);

    parsedContent.forEach((item) => {
        switch (item.type) {
            case "code":
                const codeBlock = document.createElement("div");
                codeBlock.className = "code-block";

                const pre = document.createElement("pre");
                pre.textContent = need_escape
                    ? escapeHtml(item.content)
                    : item.content;

                // 添加语言标签
                const langTag = document.createElement("span");
                langTag.className = "lang-tag";
                langTag.textContent = item.language
                    ? item.language
                    : "plain text";
                codeBlock.appendChild(langTag);

                // 添加复制按钮
                const copyBtn = document.createElement("button");
                copyBtn.className = "copy-btn";
                copyBtn.textContent = "Copy";
                copyBtn.addEventListener("click", () => {
                    navigator.clipboard.writeText(item.content).catch((err) => {
                        console.error("Failed to copy: ", err);
                    });
                });

                codeBlock.appendChild(pre);
                codeBlock.appendChild(copyBtn);
                container.appendChild(codeBlock);
                break;

            case "snip":
                const code = document.createElement("code");
                code.textContent = need_escape
                    ? escapeHtml(item.content)
                    : item.content;
                container.appendChild(code);
                break;

            default:
                const textNode = document.createTextNode(
                    need_escape ? escapeHtml(item.content) : item.content
                );
                container.appendChild(textNode);
        }
    });

    return container;
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
