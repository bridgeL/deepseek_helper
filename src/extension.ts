import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import OpenAI from 'openai';
import { format } from 'date-fns';
import { v4 as uuidv4 } from 'uuid';

interface Conversation {
    id: string;
    createdAt: number;
    lastActive: number;
    messages: Message[];
    filePath?: string;
    preview?: string;
}

interface Message {
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek.analyze', () => {
            DeepSeekPanel.createOrShow(context);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('deepseek.ds_key')) {
                DeepSeekPanel.reload();
            }
        })
    );
}

class DeepSeekPanel {
    private static instance: DeepSeekPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _openai: OpenAI | null = null;
    private _context: vscode.ExtensionContext;
    private _selectedFiles: Array<{path: string, content: string}> = [];
    private _currentConversation: Conversation | null = null;
    private _conversations: Conversation[] = [];

    public static createOrShow(context: vscode.ExtensionContext): DeepSeekPanel {
        const column = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;
        
        if (DeepSeekPanel.instance) {
            DeepSeekPanel.instance._panel.reveal(column);
            return DeepSeekPanel.instance;
        }

        const panel = vscode.window.createWebviewPanel(
            'deepseekView',
            'DeepSeek Analysis',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'src')]
            }
        );

        DeepSeekPanel.instance = new DeepSeekPanel(panel, context);
        return DeepSeekPanel.instance;
    }

    public static reload() {
        if (DeepSeekPanel.instance) {
            const config = vscode.workspace.getConfiguration('deepseek');
            const apiKey = config.get<string>('ds_key');
            DeepSeekPanel.instance._openai = apiKey ? new OpenAI({
                baseURL: 'https://api.deepseek.com',
                apiKey: apiKey
            }) : null;
        }
    }

    private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
        this._panel = panel;
        this._context = context;

        // Initialize API client
        const config = vscode.workspace.getConfiguration('deepseek');
        const apiKey = config.get<string>('ds_key');
        if (apiKey) {
            this._openai = new OpenAI({
                baseURL: 'https://api.deepseek.com',
                apiKey: apiKey
            });
        }

        // Load conversation history
        this._conversations = context.workspaceState.get('conversations', []);
        this._startNewConversation();

        // Set webview content
        this._updateWebview();

        // Handle messages from webview
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                try {
                    switch (message.command) {
                        case 'newConversation':
                            this._startNewConversation();
                            this._updateWebview();
                            break;
                        case 'switchConversation':
                            this._switchConversation(message.conversationId);
                            this._updateWebview();
                            break;
                        case 'deleteConversation':
                            await this._deleteConversation(message.conversationId);
                            break;
                        case 'estimateTokens':
                            await this._handleEstimateTokens();
                            break;
                        case 'sendRequest':
                            await this._handleSendRequest({
                                text: message.text,
                                excludeDirs: message.excludeDirs,
                                historyCount: message.historyCount ? parseInt(message.historyCount) : 5
                            });
                            break;
                        case 'selectFiles':
                            await this._handleSelectFiles({
                                fileTypes: message.fileTypes,
                                excludeDirs: message.excludeDirs
                            });
                            break;
                        case 'resizeWebview':
                            this._resizePanel(message.collapsed);
                            break;
                    }
                } catch (error) {
                    this._panel.webview.postMessage({
                        command: 'updateStatus',
                        text: `Error: ${error instanceof Error ? error.message : String(error)}`
                    });
                }
            },
            null,
            this._disposables
        );

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    private _resizePanel(collapsed: boolean) {
        if (this._panel.viewColumn) {
            setTimeout(() => {
                this._panel.reveal(this._panel.viewColumn, true);
            }, 200);
        }
    }

    private _startNewConversation() {
        // Clean empty conversations except current
        this._conversations = this._conversations.filter(conv => 
            conv.messages.length > 0 || 
            conv.id === this._currentConversation?.id
        );

        const conversationId = uuidv4();
        this._currentConversation = {
            id: conversationId,
            createdAt: Date.now(),
            lastActive: Date.now(),
            messages: [],
            filePath: this._generateMarkdownPath(conversationId)
        };
        this._conversations.unshift(this._currentConversation);
        this._saveConversations();
    }

    private async _deleteConversation(conversationId: string) {
        const confirm = await vscode.window.showWarningMessage(
            'Delete this conversation?',
            { modal: true },
            'Delete'
        );

        if (confirm !== 'Delete') {
            return;
        }

        // Delete associated markdown file
        const conversation = this._conversations.find(c => c.id === conversationId);
        if (conversation?.filePath && fs.existsSync(conversation.filePath)) {
            try {
                fs.unlinkSync(conversation.filePath);
            } catch (error) {
                console.error('Failed to delete conversation file:', error);
            }
        }

        // Update conversation list
        this._conversations = this._conversations.filter(c => c.id !== conversationId);
        
        // If deleting current conversation, create new one
        if (this._currentConversation?.id === conversationId) {
            this._startNewConversation();
        }
        
        this._saveConversations();
        this._updateWebview();

        this._panel.webview.postMessage({
            command: 'updateStatus',
            text: 'Conversation deleted'
        });
    }

    private _switchConversation(conversationId: string) {
        const conversation = this._conversations.find(c => c.id === conversationId);
        if (conversation) {
            this._currentConversation = conversation;
            this._currentConversation.lastActive = Date.now();
            this._saveConversations();
        }
    }

    private _getConversationHistory() {
        return this._conversations.map(c => ({
            id: c.id,
            createdAt: c.createdAt,
            lastActive: c.lastActive,
            preview: c.messages.length > 0 
                ? c.messages[0].content.substring(0, 50) + (c.messages[0].content.length > 50 ? '...' : '')
                : 'New conversation'
        }));
    }

    private _saveConversations() {
        // Filter out empty conversations except current
        const conversationsToSave = this._conversations.filter(conv => 
            conv.messages.length > 0 || 
            conv.id === this._currentConversation?.id
        );
        
        this._context.workspaceState.update('conversations', conversationsToSave);
    }

    private _generateMarkdownPath(conversationId: string): string {
        const workspaceRoot = vscode.workspace.rootPath;
        if (!workspaceRoot) return '';
        
        const outputDir = path.join(workspaceRoot, 'deepseek');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir);
        }
        
        return path.join(outputDir, `${conversationId}.md`);
    }

    private async _handleSelectFiles(params: {fileTypes: string[], excludeDirs?: string}) {
        const { fileTypes, excludeDirs = '' } = params;
        
        if (!fileTypes || fileTypes.length === 0) {
            this._panel.webview.postMessage({
                command: 'updateStatus',
                text: 'No file types selected'
            });
            return;
        }

        this._panel.webview.postMessage({
            command: 'updateStatus',
            text: 'Collecting files...'
        });

        try {
            this._selectedFiles = await this._collectFiles(fileTypes, excludeDirs);

            this._panel.webview.postMessage({
                command: 'updateFileList',
                files: this._selectedFiles.map(f => f.path)
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'updateStatus',
                text: `Failed to collect files: ${error instanceof Error ? error.message : String(error)}`
            });
        }
    }

    private async _collectFiles(fileTypes: string[], excludeDirs: string): Promise<Array<{path: string, content: string}>> {
        const pattern = `**/*{${fileTypes.join(',')}}`;
        const excludePattern = excludeDirs.split(' ')
            .filter(Boolean)
            .map(dir => `**/${dir}/**`)
            .join(',');
        
        const uris = await vscode.workspace.findFiles(
            pattern, 
            `{${excludePattern},**/node_modules/**}`
        );

        // Get files and sort by path
        const files = await Promise.all(
            uris.map(async uri => ({
                path: vscode.workspace.asRelativePath(uri),
                content: (await vscode.workspace.fs.readFile(uri)).toString()
            }))
        );

        return files.sort((a, b) => 
            a.path.localeCompare(b.path, undefined, { sensitivity: 'base' })
        );
    }

    private async _handleEstimateTokens() {
        if (!this._selectedFiles.length) {
            this._panel.webview.postMessage({
                command: 'showTokenEstimate',
                estimate: 'No files selected'
            });
            return;
        }

        const totalTokens = Math.floor(
            this._selectedFiles.reduce((sum, file) => sum + file.content.length, 0) * 0.3
        );

        this._panel.webview.postMessage({
            command: 'showTokenEstimate',
            estimate: `Estimated tokens: ${totalTokens}`
        });
    }

    private _formatFiles(files: Array<{path: string, content: string}>): string {
        return files.map(f => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n');
    }

    private async _handleSendRequest(params: {text: string, excludeDirs?: string, historyCount?: number}) {
        const { text, excludeDirs = "", historyCount = 5 } = params;

        if (!this._openai || !this._currentConversation) {
            this._panel.webview.postMessage({
                command: "updateStatus",
                text: "API key not configured"
            });
            return;
        }

        if (!text) {
            this._panel.webview.postMessage({
                command: "updateStatus",
                text: "Please enter your question"
            });
            return;
        }

        try {
            // Add user message
            const userMessage = {
                role: 'user' as const,
                content: text,
                timestamp: Date.now()
            };
            
            this._panel.webview.postMessage({
                command: "addMessage",
                ...userMessage
            });

            this._currentConversation.messages.push(userMessage);

            // Prepare API request with markdown code blocks
            const formattedFiles = this._formatFiles(this._selectedFiles);
            const messages: OpenAI.ChatCompletionMessageParam[] = [
                { 
                    role: "system", 
                    content: "You are an expert programming assistant. When providing code examples, always use markdown code blocks with language tags." 
                },
                ...this._currentConversation.messages
                    .slice(-historyCount)
                    .map(msg => ({
                        role: msg.role,
                        content: msg.content
                    })),
                {
                    role: "user",
                    content: `${text}\n\n### Relevant Code Files:\n${formattedFiles}`
                }
            ];

            // Create assistant message placeholder
            const assistantMessageId = `msg-${Date.now()}`;
            this._panel.webview.postMessage({
                command: "addMessage",
                role: "assistant",
                content: "",
                timestamp: Date.now(),
                id: assistantMessageId
            });

            // Stream response
            const stream = await this._openai.chat.completions.create({
                messages,
                model: "deepseek-chat",
                max_tokens: 2000,
                stream: true
            });

            let fullResponse = '';
            for await (const chunk of stream) {
                const content = chunk.choices[0]?.delta?.content || "";
                fullResponse += content;
                
                // Escape HTML but preserve code blocks
                const escapedContent = fullResponse
                    .replace(/&/g, "&amp;")
                    .replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;");
                
                this._panel.webview.postMessage({
                    command: "updateMessage",
                    id: assistantMessageId,
                    content: escapedContent,
                    timestamp: Date.now()
                });
            }

            // Save assistant response
            const assistantMessage = {
                role: 'assistant' as const,
                content: fullResponse,
                timestamp: Date.now()
            };
            
            this._currentConversation.messages.push(assistantMessage);
            this._currentConversation.lastActive = Date.now();
            this._currentConversation.preview = text.substring(0, 50) + (text.length > 50 ? '...' : '');
            this._saveConversations();
            this._saveFullConversation();

            this._panel.webview.postMessage({
                command: "updateConversation",
                conversation: this._currentConversation,
                history: this._getConversationHistory()
            });

        } catch (error) {
            this._panel.webview.postMessage({
                command: "updateStatus",
                text: `Error: ${error instanceof Error ? error.message : String(error)}`
            });
        }
    }

    private _saveFullConversation() {
        if (!this._currentConversation?.filePath) return;
        
        const content = this._currentConversation.messages
            .map(msg => {
                const role = msg.role === "user" ? "User" : "DeepSeek";
                return `## [${format(new Date(msg.timestamp), 'yyyy-MM-dd HH:mm:ss')}] ${role}\n${msg.content}\n`;
            })
            .join("\n---\n\n");
        
        try {
            fs.writeFileSync(this._currentConversation.filePath, content);
        } catch (error) {
            console.error('Failed to save conversation:', error);
        }
    }

    private _updateWebview() {
        // Get local resource paths
        const htmlPath = vscode.Uri.joinPath(this._context.extensionUri, 'src', 'panel.html');
        const cssPath = vscode.Uri.joinPath(this._context.extensionUri, 'src', 'panel.css');
        const jsPath = vscode.Uri.joinPath(this._context.extensionUri, 'src', 'panel.js');

        // Read file contents
        let html = fs.readFileSync(htmlPath.fsPath, 'utf8');
        const css = this._panel.webview.asWebviewUri(cssPath);
        const js = this._panel.webview.asWebviewUri(jsPath);

        // Replace resource references
        html = html.replace(
            /<link rel="stylesheet" href="panel.css">/,
            `<link rel="stylesheet" href="${css}">`
        ).replace(
            /<script src="panel.js"><\/script>/,
            `<script src="${js}"></script>`
        );

        this._panel.webview.html = html;

        // Send initial data
        this._panel.webview.postMessage({
            command: 'updateConversation',
            conversation: this._currentConversation,
            history: this._getConversationHistory()
        });
    }

    public dispose() {
        DeepSeekPanel.instance = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}