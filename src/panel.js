// Initialize variables
let currentAssistantMessageId = null;
let historyVisible = false;
let controlsCollapsed = localStorage.getItem('controlsCollapsed') === 'true';

// DOM elements
const vscode = acquireVsCodeApi();
const userInput = document.getElementById('userInput');
const selectFilesBtn = document.getElementById('selectFiles');
const estimateTokensBtn = document.getElementById('estimateTokens');
const sendRequestBtn = document.getElementById('sendRequest');
const statusEl = document.getElementById('status');
const fileListEl = document.getElementById('fileList');
const filesContainer = document.getElementById('filesContainer');
const responseContainer = document.getElementById('responseContainer');
const excludeDirsInput = document.getElementById('excludeDirs');
const historyCountSelect = document.getElementById('historyCount');
const newConversationBtn = document.getElementById('newConversation');
const toggleHistoryBtn = document.getElementById('toggleHistory');
const conversationList = document.getElementById('conversationList');
const controlsContainer = document.getElementById('controlsContainer');
const toggleControlsBtn = document.getElementById('toggleControls');
const fileTypesInput = document.getElementById('fileTypes');

// Initialize UI
function initializeUI() {
    updateControlsToggleState(controlsCollapsed);
    document.getElementById('conversationHistory').classList.toggle('visible', historyVisible);
}

// Update controls toggle button state
function updateControlsToggleState(isCollapsed) {
    const icon = toggleControlsBtn.querySelector('.icon');
    if (icon) {
        icon.textContent = isCollapsed ? '▼' : '▲';
    }
    toggleControlsBtn.classList.toggle('collapsed', isCollapsed);
    controlsContainer.classList.toggle('collapsed', isCollapsed);
}

// Helper functions
function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe.toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function renderCodeBlocks(content) {
    return content.replace(/```(\w*)\n([\s\S]*?)\n```/g, 
        '<div class="code-block"><pre><code>$2</code></pre><span class="lang-tag">$1</span></div>');
}

function createMessageElement(role, content, timestamp, id = '') {
    const container = document.createElement('div');
    container.className = 'message-container';
    if (id) container.id = id;
    
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${role}-message`;
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    contentDiv.innerHTML = renderCodeBlocks(escapeHtml(content));
    
    const timeDiv = document.createElement('div');
    timeDiv.className = 'message-time';
    timeDiv.textContent = formatTime(timestamp);
    
    messageDiv.appendChild(contentDiv);
    messageDiv.appendChild(timeDiv);
    container.appendChild(messageDiv);
    
    return container;
}

function updateMessageInUI(message) {
    let messageEl = document.querySelector(`#${message.id} .message-content`);
    if (messageEl) {
        messageEl.innerHTML = renderCodeBlocks(escapeHtml(message.content));
    }
    
    const timeEl = document.querySelector(`#${message.id} .message-time`);
    if (timeEl) {
        timeEl.textContent = formatTime(message.timestamp);
    }
}

function addMessageToUI(message) {
    const container = createMessageElement(
        message.role, 
        message.content, 
        message.timestamp,
        message.id
    );
    
    responseContainer.appendChild(container);
    responseContainer.scrollTop = responseContainer.scrollHeight;
    
    if (message.role === 'assistant') {
        currentAssistantMessageId = message.id;
    }
}

function updateConversationView(conversation, history) {
    // Clear and re-render all messages
    responseContainer.innerHTML = '';
    
    if (conversation?.messages) {
        conversation.messages.forEach(msg => {
            const container = createMessageElement(
                msg.role, 
                msg.content, 
                msg.timestamp
            );
            responseContainer.appendChild(container);
        });
        
        responseContainer.scrollTop = responseContainer.scrollHeight;
    }
    
    // Update history panel
    conversationList.innerHTML = history.map(conv => `
        <div class="conversation-item ${conv.id === conversation?.id ? 'active' : ''}" 
             data-id="${conv.id}">
            <div class="conversation-item-content">
                <div>${formatTime(conv.createdAt)}</div>
                <div class="conversation-preview">${conv.preview || 'New conversation'}</div>
            </div>
            <div class="conversation-item-actions">
                <button class="delete-conversation" data-id="${conv.id}">×</button>
            </div>
        </div>
    `).join('');

    // Add delete button events
    document.querySelectorAll('.delete-conversation').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const conversationId = btn.dataset.id;
            vscode.postMessage({
                command: 'deleteConversation',
                conversationId: conversationId
            });
        });
    });

    // Add conversation switch events
    document.querySelectorAll('.conversation-item').forEach(item => {
        item.addEventListener('click', () => {
            vscode.postMessage({
                command: 'switchConversation',
                conversationId: item.dataset.id
            });
        });
    });
}

// Event listeners
toggleControlsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    controlsCollapsed = !controlsCollapsed;
    updateControlsToggleState(controlsCollapsed);
    localStorage.setItem('controlsCollapsed', controlsCollapsed);
    
    vscode.postMessage({
        command: 'resizeWebview',
        collapsed: controlsCollapsed
    });
});

toggleHistoryBtn.addEventListener('click', () => {
    historyVisible = !historyVisible;
    document.getElementById('conversationHistory').classList.toggle('visible', historyVisible);
});

selectFilesBtn.addEventListener('click', () => {
    const fileTypes = fileTypesInput.value.trim()
        .split(' ')
        .map(type => type.trim())
        .filter(type => type.startsWith('.') && type.length > 1)
        .map(type => type.substring(1));
    
    if (fileTypes.length === 0) {
        vscode.postMessage({
            command: 'updateStatus',
            text: 'Please enter valid file types (e.g. .js .html .css)'
        });
        return;
    }

    vscode.postMessage({
        command: 'selectFiles',
        fileTypes: fileTypes,
        excludeDirs: excludeDirsInput.value.trim()
    });
});

estimateTokensBtn.addEventListener('click', () => {
    vscode.postMessage({
        command: 'estimateTokens'
    });
});

sendRequestBtn.addEventListener('click', () => {
    const text = userInput.value.trim();
    if (!text) {
        statusEl.textContent = 'Please enter your question';
        return;
    }
    
    vscode.postMessage({
        command: 'sendRequest',
        text: text,
        excludeDirs: excludeDirsInput.value.trim(),
        historyCount: historyCountSelect.value
    });
    
    userInput.value = '';
});

newConversationBtn.addEventListener('click', () => {
    vscode.postMessage({
        command: 'newConversation'
    });
});

// Handle messages from extension
window.addEventListener('message', event => {
    const message = event.data;
    switch (message.command) {
        case 'updateStatus':
            statusEl.textContent = message.text;
            break;
            
        case 'updateFileList':
            fileListEl.style.display = 'block';
            const sortedFiles = message.files.sort((a, b) => 
                a.localeCompare(b, undefined, { sensitivity: 'base' })
            );
            filesContainer.innerHTML = sortedFiles
                .map(file => `<div class="file-item">${file}</div>`)
                .join('');
            break;
            
        case 'showTokenEstimate':
            statusEl.textContent = message.estimate;
            break;
            
        case 'addMessage':
            addMessageToUI(message);
            break;
            
        case 'updateMessage':
            updateMessageInUI(message);
            break;
            
        case 'clearMessages':
            responseContainer.innerHTML = '';
            break;
            
        case 'updateConversation':
            updateConversationView(message.conversation, message.history);
            break;
    }
});

// Initialize UI
initializeUI();

// Request initial data
vscode.postMessage({
    command: 'updateConversation'
});