// Utility: UUID v4 without external libs
function uuidv4() {
    if (crypto && crypto.getRandomValues) {
        const buf = new Uint8Array(16);
        crypto.getRandomValues(buf);
        // RFC 4122 compliance
        buf[6] = (buf[6] & 0x0f) | 0x40;
        buf[8] = (buf[8] & 0x3f) | 0x80;
        const hex = [...buf].map(b => b.toString(16).padStart(2, '0'));
        return [
            hex.slice(0, 4).join(''),
            hex.slice(4, 6).join(''),
            hex.slice(6, 8).join(''),
            hex.slice(8, 10).join(''),
            hex.slice(10, 16).join('')
        ].join('-');
    }
    // Fallback
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Deterministic color from string (HSL)
function stringToColor(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = (h * 31 + str.charCodeAt(i)) >>> 0;
    }
    const hue = h % 360;
    const s = 78; // saturation
    const l = 46; // lightness
    const bg = `hsl(${hue} ${s}% ${l}%)`;
    return {
        bg,
        // Slightly darker for caret for contrast on light backgrounds
        caret: `hsl(${hue} ${Math.min(92, s + 10)}% ${Math.max(36, l - 8)}%)`
    };
}

// Toast helper
function toast(msg, ms = 1800) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), ms);
}

// Compute caret coordinates inside a textarea without external libs
function getCaretCoordinates(textarea, position) {
    const div = document.createElement('div');
    const style = getComputedStyle(textarea);
    const props = [
        'boxSizing', 'width', 'height', 'overflowX', 'overflowY',
        'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
        'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
        'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'fontFamily',
        'lineHeight', 'letterSpacing', 'textTransform', 'textAlign', 'textIndent',
        'whiteSpace', 'wordBreak', 'wordSpacing'
    ];
    props.forEach(p => div.style[p] = style[p]);
    div.style.position = 'absolute';
    div.style.visibility = 'hidden';
    div.style.whiteSpace = 'pre-wrap';
    div.style.wordWrap = 'break-word';
    div.style.overflow = 'auto';
    div.style.height = 'auto';
    div.style.minHeight = style.height;

    const value = textarea.value.substring(0, position);
    // Escape and mirror content
    const esc = value
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\n$/g, '\n\u200b'); // keep last newline
    div.innerHTML = esc;

    const span = document.createElement('span');
    span.textContent = '\u200b'; // zero-width space as caret marker
    div.appendChild(span);

    document.body.appendChild(div);
    const rect = span.getBoundingClientRect();
    const rectDiv = div.getBoundingClientRect();
    const left = rect.left - rectDiv.left - parseFloat(style.borderLeftWidth);
    const top = rect.top - rectDiv.top - parseFloat(style.borderTopWidth);

    document.body.removeChild(div);
    return {
        left,
        top,
        lineHeight: parseFloat(style.lineHeight) || 18
    };
}

class RealtimeEditor {
    constructor() {
        // State
        this.ws = null;
        this.userId = null;
        this.username = '';
        this.documentId = '';
        this.title = 'Untitled Document';
        this.isRemoteChange = false;
        this.remoteUsers = new Map(); // userId -> { name, color }
        this.remoteCursors = new Map(); // userId -> position
        this.lastCursorSend = 0;

        // Elements
        this.editor = document.getElementById('editor');
        this.cursorLayer = document.getElementById('cursorLayer');

        // UI init
        this.bindUI();
        this.showJoinModalPrefilled();
    }

    bindUI() {
        // Buttons
        document.getElementById('copyUrlBtn').addEventListener('click', () => {
            const el = document.getElementById('joinUrl');
            el.select();
            document.execCommand('copy');
            toast('Join URL copied');
        });
        document.getElementById('saveBtn').addEventListener('click', () => this.save());
        document.getElementById('renameBtn').addEventListener('click', () => {
            const newTitle = prompt('Document title', this.title) || this.title;
            this.title = newTitle.trim() || this.title;
            document.getElementById('docTitle').textContent = this.title;
            this.send({ type: 'rename', title: this.title });
        });

        // Modal
        document.getElementById('randomizeDocId').addEventListener('click', () => {
            document.getElementById('docIdInput').value = uuidv4();
        });
        document.getElementById('joinBtn').addEventListener('click', () => this.joinFromModal());
        document.getElementById('userNameInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.joinFromModal();
        });
        document.getElementById('docIdInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.joinFromModal();
        });

        // Editor events
        this.editor.addEventListener('input', () => {
            if (!this.isRemoteChange) {
                this.sendTextChange();
            }
            this.isRemoteChange = false;
            this.renderRemoteCursors(); // reflow overlay
        });

        // Cursor updates: throttle to ~20fps
        const sendCursor = () => {
            const now = performance.now();
            if (now - this.lastCursorSend > 50) {
                this.lastCursorSend = now;
                this.sendCursor();
            }
        };
        ['keyup', 'mouseup', 'click'].forEach(ev => {
            this.editor.addEventListener(ev, sendCursor);
        });
        this.editor.addEventListener('select', sendCursor);
        this.editor.addEventListener('scroll', () => this.renderRemoteCursors());
        window.addEventListener('resize', () => this.renderRemoteCursors());
    }

    showJoinModalPrefilled() {
        const params = new URLSearchParams(location.search);
        const urlDoc = params.get('doc') || params.get('docId') || '';
        const urlUser = params.get('user') || params.get('name') || '';
        const initialDoc = urlDoc || uuidv4();

        const docInput = document.getElementById('docIdInput');
        const userInput = document.getElementById('userNameInput');
        docInput.value = initialDoc;
        userInput.value = urlUser;

        // Update share URL preview early
        this.updateJoinUrl(initialDoc);

        // Focus name if empty, else doc
        setTimeout(() => (userInput.value ? docInput : userInput).focus(), 50);
    }

    joinFromModal() {
        const docId = (document.getElementById('docIdInput').value || '').trim() || uuidv4();
        const name = (document.getElementById('userNameInput').value || '').trim() || 'Anonymous';
        this.documentId = docId;
        this.username = name;

        // Update UI
        this.updateJoinUrl(this.documentId);
        document.getElementById('docTitle').textContent = this.title;
        document.getElementById('mePill').textContent = `You: ${this.username}`;
        document.getElementById('joinModal').classList.add('hidden');

        // Push doc param to URL (no reload)
        const u = new URL(location.href);
        u.searchParams.set('doc', this.documentId);
        history.replaceState({}, '', u.toString());

        // Connect
        this.connect();
    }

    updateJoinUrl(docId) {
        const url = `${location.origin}${location.pathname}?doc=${encodeURIComponent(docId)}`;
        const el = document.getElementById('joinUrl');
        el.value = url;
    }

    connect() {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${location.host}/ws?doc=${encodeURIComponent(this.documentId)}&user=${encodeURIComponent(this.username)}`;
        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            this.setStatus(true);
            toast('Connected');
            // announce our name (in case server also supports this message)
            this.send({ type: 'username_change', username: this.username });
            // send initial cursor quickly
            this.sendCursor();
        };
        this.ws.onclose = () => {
            this.setStatus(false);
            toast('Disconnected');
            // Optional: basic retry with backoff
            setTimeout(() => this.connect(), 1200);
        };
        this.ws.onerror = () => {
            this.setStatus(false);
            toast('Connection error');
        };
        this.ws.onmessage = (ev) => {
            try {
                const msg = JSON.parse(ev.data);
                this.handleMessage(msg);
            } catch (e) {
                console.warn('Bad message', ev.data);
            }
        };
    }

    // WebSocket helpers
    send(obj) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const payload = { ...obj, username: this.username };
            this.ws.send(JSON.stringify(payload));
        }
    }
    setStatus(connected) {
        const d = document.getElementById('statusDot');
        const t = document.getElementById('statusText');
        d.classList.toggle('disconnected', !connected);
        t.textContent = connected ? 'Connected' : 'Disconnected';
    }

    // Messages
    handleMessage(msg) {
        switch (msg.type) {
            case 'init': {
                // Expecting content, title, userId, users
                if (typeof msg.content === 'string') {
                    this.isRemoteChange = true;
                    this.editor.value = msg.content;
                }
                if (msg.title) {
                    this.title = msg.title;
                    document.getElementById('docTitle').textContent = this.title;
                }
                if (msg.userId) this.userId = msg.userId;
                if (Array.isArray(msg.users)) {
                    this.remoteUsers.clear();
                    msg.users.forEach(u => {
                        if (u.userId && u.userId !== this.userId) {
                            const key = u.userId;
                            const name = u.username || 'Anonymous';
                            const colors = stringToColor(key || name);
                            this.remoteUsers.set(key, { name, colors });
                        }
                    });
                    this.updateUsersList();
                }
                break;
            }
            case 'text_change': {
                if (msg.userId === this.userId) break; // ignore own echo
                const cur = this.editor.selectionStart;
                const scrollTop = this.editor.scrollTop;

                this.isRemoteChange = true;
                this.editor.value = msg.content ?? '';
                // restore cursor/scroll for local user
                this.editor.setSelectionRange(cur, cur);
                this.editor.scrollTop = scrollTop;

                this.renderRemoteCursors();
                break;
            }
            case 'cursor_position': {
                if (msg.userId === this.userId) break;
                const key = msg.userId || (msg.username || 'user');
                if (!this.remoteUsers.has(key)) {
                    const colors = stringToColor(key || msg.username || 'user');
                    this.remoteUsers.set(key, { name: msg.username || 'Anonymous', colors });
                    this.updateUsersList();
                } else if (msg.username) {
                    // keep name fresh
                    const item = this.remoteUsers.get(key);
                    item.name = msg.username || item.name;
                    this.remoteUsers.set(key, item);
                    this.updateUsersList();
                }
                if (typeof msg.position === 'number') {
                    this.remoteCursors.set(key, msg.position);
                    this.renderRemoteCursors();
                }
                break;
            }
            case 'users_list': {
                this.remoteUsers.clear();
                (msg.users || []).forEach(u => {
                    if (u.userId !== this.userId) {
                        const colors = stringToColor(u.userId || u.username || 'user');
                        this.remoteUsers.set(u.userId, { name: u.username || 'Anonymous', colors });
                    }
                });
                this.updateUsersList();
                break;
            }
            case 'user_joined': {
                const key = msg.userId || (msg.username || 'user');
                const colors = stringToColor(key);
                this.remoteUsers.set(key, { name: msg.username || 'Anonymous', colors });
                this.updateUsersList();
                toast(`${msg.username || 'A user'} joined`);
                break;
            }
            case 'user_left': {
                const key = msg.userId || (msg.username || 'user');
                const who = this.remoteUsers.get(key)?.name || 'A user';
                this.remoteUsers.delete(key);
                this.remoteCursors.delete(key);
                this.updateUsersList();
                this.renderRemoteCursors();
                toast(`${who} left`);
                break;
            }
            case 'rename': {
                if (msg.title) {
                    this.title = msg.title;
                    document.getElementById('docTitle').textContent = this.title;
                }
                break;
            }
            case 'save_success': {
                toast('Saved');
                break;
            }
            case 'error': {
                toast(`Error: ${msg.message || 'Unknown error'}`);
                break;
            }
        }
    }

    // Sending changes
    sendTextChange() {
        this.send({
            type: 'text_change',
            content: this.editor.value,
            cursor: this.editor.selectionStart,
            timestamp: Date.now()
        });
    }
    sendCursor() {
        this.send({
            type: 'cursor_position',
            position: this.editor.selectionStart
        });
    }
    save() {
        this.send({ type: 'save', content: this.editor.value });
    }

    // UI helpers
    updateUsersList() {
        const list = document.getElementById('usersList');
        const entries = [...this.remoteUsers.entries()];
        if (entries.length === 0) {
            list.textContent = 'Just you';
            return;
        }
        list.innerHTML = entries.map(([id, data]) => {
            const bg = data.colors.bg;
            return `
            <span class="user-badge" title="${data.name}">
              <span class="swatch" style="background:${bg}"></span>
              ${data.name}
            </span>
          `;
        }).join('');
    }

    renderRemoteCursors() {
        // Clear layer
        const layer = this.cursorLayer;
        layer.innerHTML = '';
        const ta = this.editor;
        const scrollTop = ta.scrollTop;

        // For each remote cursor, compute position in the textarea
        this.remoteCursors.forEach((pos, userId) => {
            try {
                // Guard for out-of-range positions
                const clamped = Math.max(0, Math.min(pos, ta.value.length));
                const { left, top, lineHeight } = getCaretCoordinates(ta, clamped);

                const meta = this.remoteUsers.get(userId);
                const name = meta?.name || 'User';
                const caretColor = meta?.colors?.caret || '#f87171';
                const labelBg = meta?.colors?.bg || '#ef4444';

                // Create caret
                const caret = document.createElement('div');
                caret.className = 'caret';
                caret.style.background = caretColor;
                caret.style.left = `${left + 18}px`;   // + textarea horizontal padding
                caret.style.top = `${top + 20 - scrollTop}px`; // + textarea vertical padding - scroll
                caret.style.height = `${lineHeight}px`;

                // Label
                const label = document.createElement('div');
                label.className = 'caret-label';
                label.textContent = name;
                label.style.background = labelBg;
                label.style.left = `${left + 18 + 4}px`;
                label.style.top = `${top + 20 - scrollTop - 4}px`;

                layer.appendChild(caret);
                layer.appendChild(label);
            } catch (e) {
                // ignore bad coordinate computations
            }
        });
    }
}

// Boot
window.addEventListener('DOMContentLoaded', () => {
    new RealtimeEditor();
});
