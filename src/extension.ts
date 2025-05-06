import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import dayjs from "dayjs";
import OpenAI from "openai";
import { randomInt } from "crypto";

// ===== 类型定义 =====
interface Conversation {
    id: string;
    createdAt: number;
    lastActive: number;
    messages: Message[];
    filePath?: string;
    preview?: string;
}

interface Message {
    id: string;
    role: "user" | "assistant";
    content: string;
    timestamp: number;
}

interface WebviewMessage {
    command: string;
    [key: string]: any;
}

// ===== 扩展主类 =====
export class DeepSeekPanel {
    private static instance: DeepSeekPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _openai: OpenAI | null = null;
    private _context: vscode.ExtensionContext;
    private _selectedFiles: Array<{ path: string; content: string }> = [];
    private _currentConversation: Conversation | null = null;
    private _conversations: Conversation[] = [];
    private _currentRequest: AbortController | null = null;

    // ===== 初始化 =====
    public static createOrShow(context: vscode.ExtensionContext) {
        const column =
            vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;

        if (DeepSeekPanel.instance) {
            DeepSeekPanel.instance._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            "deepseekView",
            "DeepSeek Analysis",
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, "src"),
                ],
            }
        );

        DeepSeekPanel.instance = new DeepSeekPanel(panel, context);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        context: vscode.ExtensionContext
    ) {
        this._panel = panel;
        this._context = context;

        // 初始化API
        this._initializeApiClient();

        // 加载对话历史
        this._conversations = context.workspaceState.get<Conversation[]>(
            "conversations",
            []
        );
        this._startNewConversation();

        // 设置Webview
        this._updateWebview();

        // 消息处理
        this._panel.webview.onDidReceiveMessage(
            this._handleWebviewMessage.bind(this),
            null,
            this._disposables
        );

        // 清理
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    // ===== 核心方法 =====
    private _initializeApiClient() {
        const config = vscode.workspace.getConfiguration("deepseek");
        const dsKey = config.get<string>("ds_key");

        if (dsKey) {
            this._openai = new OpenAI({
                baseURL: "https://api.deepseek.com/v1",
                apiKey: dsKey,
            });
            this._log("API client initialized");
        } else {
            this._log("No API key found in configuration");
        }
    }

    private _startNewConversation() {
        this._conversations = this._conversations.filter(
            (conv) =>
                conv.messages.length > 0 ||
                conv.id === this._currentConversation?.id
        );

        const conversationId = `conv-${Date.now()}-${randomInt(1000)}`;
        this._currentConversation = {
            id: conversationId,
            createdAt: Date.now(),
            lastActive: Date.now(),
            messages: [],
            filePath: this._generateMarkdownPath(conversationId),
        };
        this._conversations.unshift(this._currentConversation);
        this._saveConversations();

        this._log("New conversation started", { id: conversationId });
    }

    private updateConversation() {
        console.log("Updating conversation in webview");
        this._panel.webview.postMessage({
            command: "updateConversation",
            conversation: this._currentConversation,
            history: this._getConversationHistory(),
        });
    }

    private _handleNewConversation() {
        this._startNewConversation();
        this.updateConversation();
        this._log("Created new conversation");
    }

    private async _handleDeleteConversation(conversationId: string) {
        const confirm = await vscode.window.showWarningMessage(
            "Delete this conversation?",
            { modal: true },
            "Delete"
        );

        if (confirm !== "Delete") {
            return;
        }

        const conversation = this._conversations.find(
            (c) => c.id === conversationId
        );
        if (conversation?.filePath && fs.existsSync(conversation.filePath)) {
            try {
                fs.unlinkSync(conversation.filePath);
                this._log("Deleted conversation file", {
                    path: conversation.filePath,
                });
            } catch (error) {
                this._log("Failed to delete conversation file", {
                    error: this._errorToString(error),
                    path: conversation.filePath,
                });
            }
        }

        this._conversations = this._conversations.filter(
            (c) => c.id !== conversationId
        );
        this._saveConversations();
        this.updateConversation();
    }

    // 在 _handleWebviewMessage 方法中确保完整处理所有消息类型：
    private _handleWebviewMessage(message: WebviewMessage) {
        this._log("Received message", message);

        try {
            switch (message.command) {
                case "init":
                    this._handleSendInitialData();
                    break;
                case "newConversation":
                    this._handleNewConversation();
                    break;
                case "switchConversation":
                    this._handleSwitchConversation(message.conversationId);
                    break;
                case "deleteConversation":
                    this._handleDeleteConversation(message.conversationId);
                    break;
                case "selectFiles":
                    this._handleSelectFiles({
                        fileTypes: message.fileTypes,
                        excludeDirs: message.excludeDirs,
                    });
                    break;
                case "estimateTokens":
                    this._handleEstimateTokens(
                        message.text,
                        message.historyCount
                    );
                    break;
                case "sendRequest":
                    this._handleSendRequest(message.text, message.historyCount);
                    break;
                case "log":
                    this._handleFrontendLog(message);
                    break;
                default:
                    this._log("Unknown message command", message);
            }
        } catch (error) {
            this._log("Error handling message", {
                error: this._errorToString(error),
                message,
            });
        }
    }

    private _handleSendInitialData() {
        this.updateConversation();

        this._log("Sent initial data to webview");
    }

    private _handleSwitchConversation(id: string) {
        const targetConv = this._conversations.find((c) => c.id === id);
        if (!targetConv) {
            this._log("Conversation not found", { requestedId: id });
            return;
        }

        // 保存当前请求的已接收内容
        this._saveConversations(); // 确保保存当前对话
        this._saveFullConversation(); // 确保保存已接收的内容
        this.updateConversation(); // 更新当前对话

        // 取消当前请求
        if (this._currentRequest) {
            this._currentRequest.abort();
            this._log("Aborted pending request");
        }

        this._currentConversation = targetConv;
        this._currentConversation.lastActive = Date.now();

        this.updateConversation();

        this._log("Switched conversation", {
            id,
            messageCount: targetConv.messages.length,
        });
    }

    // ===== 功能处理 =====
    private async _handleSelectFiles(params: {
        fileTypes: string[];
        excludeDirs?: string;
    }) {
        try {
            this._selectedFiles = await this._collectFiles(
                params.fileTypes,
                params.excludeDirs || ""
            );
            this._log("Selected files", {
                count: this._selectedFiles.length,
                data: this._selectedFiles.map((f) => f.path),
            });

            this._panel.webview.postMessage({
                command: "updateFileList",
                files: this._selectedFiles.map((f) => f.path),
            });
        } catch (error) {
            this._log("Error selecting files", {
                error: this._errorToString(error),
                params,
            });
            this._panel.webview.postMessage({
                command: "updateStatus",
                text: `Failed to collect files: ${this._errorToString(error)}`,
            });
        }
    }

    private async _handleEstimateTokens(text: string, historyCount: number) {
        let totalTokens = Math.floor(
            text.length * 0.3 +
                this._selectedFiles.reduce(
                    (sum, file) => sum + file.content.length,
                    0
                ) *
                    0.3
        );

        if (this._currentConversation && historyCount > 0) {
            totalTokens += Math.floor(
                this._currentConversation.messages
                    .slice(-historyCount)
                    .reduce((sum, msg) => sum + msg.content.length, 0) * 0.3
            );
        }

        this._panel.webview.postMessage({
            command: "showTokenEstimate",
            estimate: `Estimated tokens: ${totalTokens}`,
        });
    }

    private async _handleSendRequest(text: string, historyCount: number) {
        if (!this._openai) {
            this._panel.webview.postMessage({
                command: "updateStatus",
                text: "API key not configured",
            });
            return;
        }

        if (!this._currentConversation) {
            this._panel.webview.postMessage({
                command: "updateStatus",
                text: "Conversation error",
            });
            return;
        }

        if (!text) {
            this._panel.webview.postMessage({
                command: "updateStatus",
                text: "Please enter your question",
            });
            return;
        }

        try {
            // 添加用户消息
            const userMessage: Message = {
                id: `msg-${Date.now()}`,
                role: "user",
                content: text,
                timestamp: Date.now(),
            };

            this._panel.webview.postMessage({
                command: "addMessage",
                ...userMessage,
            });

            this._currentConversation.messages.push(userMessage);
            this._log("User message added", { length: text.length });

            // 准备API请求
            const formattedFiles = this._formatFiles(this._selectedFiles);
            const messages: OpenAI.ChatCompletionMessageParam[] = [
                {
                    role: "system",
                    content:
                        "You are an expert programming assistant. When providing code examples, always use markdown code blocks with language tags.",
                },
                {
                    role: "user",
                    content: `### Relevant Code Files:\n${formattedFiles}`,
                },
                ...(historyCount > 0
                    ? this._currentConversation.messages
                          .slice(-historyCount)
                          .map((msg) => ({
                              role: msg.role,
                              content: msg.content,
                          }))
                    : []),
                {
                    role: "user",
                    content: text,
                },
            ];

            this._log("Prepared API request", {
                messageCount: messages.length,
                filesCount: this._selectedFiles.length,
            });

            // 添加助手消息占位符
            const assistantMessageId = `msg-${Date.now()}-${randomInt(1000)}`;
            this._panel.webview.postMessage({
                command: "addMessage",
                role: "assistant",
                content: "",
                timestamp: Date.now(),
                id: assistantMessageId,
            });

            // 发送请求
            this._currentRequest = new AbortController();
            const stream = await this._openai.chat.completions.create(
                {
                    messages,
                    model: "deepseek-chat",
                    max_tokens: 8000,
                    stream: true,
                },
                {
                    signal: this._currentRequest.signal,
                }
            );

            // 处理流式响应
            const assistantMessage: Message = {
                id: assistantMessageId,
                role: "assistant",
                content: "",
                timestamp: Date.now(),
            };

            this._currentConversation.messages.push(assistantMessage);
            this._currentConversation.lastActive = Date.now();
            this._currentConversation.preview =
                text.substring(0, 50) + (text.length > 50 ? "..." : "");

            this._saveConversations();
            this._saveFullConversation();

            this.updateConversation();

            for await (const chunk of stream) {
                // console.log("Received chunk", chunk);
                const content = chunk.choices[0]?.delta?.content || "";
                assistantMessage.content += content;

                this._panel.webview.postMessage({
                    command: "updateMessage",
                    id: assistantMessageId,
                    content: assistantMessage.content,
                    timestamp: Date.now(),
                });

                if (chunk.usage) {
                    this._panel.webview.postMessage({
                        command: "updateUsage",
                        usage: chunk.usage,
                    });
                }
            }

            // 保存完整响应
            this._currentConversation.lastActive = Date.now();
            this._currentConversation.preview =
                text.substring(0, 50) + (text.length > 50 ? "..." : "");

            this._saveConversations();
            this._saveFullConversation();

            this.updateConversation();

            this._log("API request completed", {
                responseLength: assistantMessage.content.length,
                conversationId: this._currentConversation.id,
            });
        } catch (error) {
            this._log("API request failed", {
                error: this._errorToString(error),
            });

            const errorMsg = this._currentRequest?.signal.aborted
                ? "Request aborted"
                : `Error: ${this._errorToString(error)}`;

            this._panel.webview.postMessage({
                command: "updateStatus",
                text: errorMsg,
            });
        } finally {
            this._currentRequest = null;
        }
    }

    // ===== 工具方法 =====
    private _formatFiles(
        files: Array<{ path: string; content: string }>
    ): string {
        return files
            .map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
            .join("\n\n");
    }

    private _generateMarkdownPath(conversationId: string): string {
        const workspaceRoot = vscode.workspace.rootPath;
        if (!workspaceRoot) {
            this._log("No workspace root found for markdown path");
            return "";
        }

        const outputDir = path.join(workspaceRoot, ".deepseek");
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
            this._log("Created output directory", { path: outputDir });
        }

        return path.join(outputDir, `${conversationId}.md`);
    }

    private _saveFullConversation() {
        if (!this._currentConversation?.filePath) {
            return;
        }

        const content = this._currentConversation.messages
            .map((msg) => {
                const role = msg.role === "user" ? "User" : "DeepSeek";
                return `## [${dayjs(msg.timestamp).format(
                    "YYYY-MM-DD HH:mm:ss"
                )}] ${role}\n${msg.content}\n`;
            })
            .join("\n---\n\n");

        try {
            fs.writeFileSync(this._currentConversation.filePath, content);
            this._log("Saved conversation", {
                path: this._currentConversation.filePath,
            });
        } catch (error) {
            this._log("Failed to save conversation", {
                error: this._errorToString(error),
                path: this._currentConversation.filePath,
            });
        }
    }

    private _saveConversations() {
        const conversationsToSave = this._conversations.filter(
            (conv) =>
                conv.messages.length > 0 ||
                conv.id === this._currentConversation?.id
        );
        this._context.workspaceState.update(
            "conversations",
            conversationsToSave
        );
        this._log("Saved conversations", { count: conversationsToSave.length });
    }

    private _getConversationHistory() {
        // 使用preview减少前后端通信数据量
        return this._conversations.map((c) => ({
            id: c.id,
            createdAt: c.createdAt,
            lastActive: c.lastActive,
            preview:
                c.messages.length > 0
                    ? c.messages[0].content.substring(0, 50) +
                      (c.messages[0].content.length > 50 ? "..." : "")
                    : "New conversation",
        }));
    }

    private async _collectFiles(
        fileTypes: string[],
        excludePatterns: string
    ): Promise<Array<{ path: string; content: string }>> {
        const pattern = `**/*.{${fileTypes.join(",")}}`;

        // Split exclude patterns by space and filter out empty strings
        const excludeItems = excludePatterns.split(" ").filter(Boolean);

        // Separate directories and files
        const excludeDirs = excludeItems.filter((item) => !item.includes("."));
        const excludeFiles = excludeItems.filter((item) => item.includes("."));

        // Create exclude patterns
        const dirExcludePattern = excludeDirs
            .map((dir) => `**/${dir}/**`)
            .join(",");
        const fileExcludePattern = excludeFiles
            .map((file) => `**/${file}`)
            .join(",");

        // Combine all exclude patterns
        const fullExcludePattern = [
            dirExcludePattern,
            fileExcludePattern,
            "**/node_modules/**",
        ]
            .filter(Boolean)
            .join(",");

        this._log("Searching for files", { pattern, fullExcludePattern });
        const uris = await vscode.workspace.findFiles(
            pattern,
            `{${fullExcludePattern}}`
        );
        this._log("Found files", { count: uris.length });

        const files = await Promise.all(
            uris.map(async (uri) => ({
                path: vscode.workspace.asRelativePath(uri),
                content: (await vscode.workspace.fs.readFile(uri)).toString(),
            }))
        );

        return files.sort((a, b) =>
            a.path.localeCompare(b.path, undefined, { sensitivity: "base" })
        );
    }

    // ===== 日志系统 =====
    private _log(message: string, data?: any) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${message}`;

        console.log(logMessage, data || "");
    }

    private _errorToString(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    private _handleFrontendLog(message: any) {
        const level = message.level || "INFO";
        const logMessage = `[FRONTEND ${level}] ${message.message}`;

        console.log(logMessage, message.data || "");
    }

    // ===== 生命周期管理 =====
    public dispose() {
        this._log("Disposing panel");
        DeepSeekPanel.instance = undefined;

        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }

    private _updateWebview() {
        const htmlPath = vscode.Uri.joinPath(
            this._context.extensionUri,
            "src",
            "panel.html"
        );
        const cssPath = vscode.Uri.joinPath(
            this._context.extensionUri,
            "src",
            "panel.css"
        );
        const jsPath = vscode.Uri.joinPath(
            this._context.extensionUri,
            "src",
            "panel.js"
        );

        const html = fs
            .readFileSync(htmlPath.fsPath, "utf8")
            .replace(
                "panel.css",
                this._panel.webview.asWebviewUri(cssPath).toString()
            )
            .replace(
                "panel.js",
                this._panel.webview.asWebviewUri(jsPath).toString()
            );

        this._panel.webview.html = html;
        this._log("Webview content updated");
    }
}

// ===== 扩展激活 =====
export function activate(context: vscode.ExtensionContext) {
    console.log("DeepSeek extension activated");

    // 创建输出通道
    const outputChannel = vscode.window.createOutputChannel("DeepSeek");
    context.globalState.update("outputChannel", outputChannel);

    // 注册命令
    context.subscriptions.push(
        vscode.commands.registerCommand("deepseek.analyze", () => {
            DeepSeekPanel.createOrShow(context);
        })
    );

    // 监听配置变化
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("deepseek.ds_key")) {
                DeepSeekPanel.createOrShow(context);
            }
        })
    );
}

export function deactivate() {
    console.log("DeepSeek extension deactivated");
}
