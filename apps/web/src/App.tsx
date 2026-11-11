import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, getToolName, isToolUIPart } from 'ai';
import { useEffect, useRef, useState, type FormEvent } from 'react';

const transport = new DefaultChatTransport({ api: '/api/chat' });
const toolLabels: Record<string, string> = {
  getCurrentTime: '查詢時間',
  loadSkill: '載入技能指引',
  readSkillFile: '讀取參考資料',
  bash: '處理檔案',
  publishFile: '準備下載',
};

function getDownload(output: unknown, chatId: string): { name: string; url: string } | undefined {
  if (typeof output !== 'object' || output === null || !('name' in output) || !('url' in output)) return;
  if (typeof output.name !== 'string' || typeof output.url !== 'string') return;
  if (!output.url.startsWith(`/api/chats/${chatId}/files/`) || !/^\/api\/chats\/[a-f0-9-]{36}\/files\/[a-f0-9-]{36}$/.test(output.url)) return;
  return { name: output.name, url: output.url };
}

export function App() {
  const [chatId, setChatId] = useState(() => crypto.randomUUID());
  const { messages, sendMessage, status, error, stop, regenerate, setMessages, clearError } = useChat({ id: chatId, transport });
  const [input, setInput] = useState('');
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState('');
  const transcript = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const stickToBottom = useRef(true);
  const generating = status === 'submitted' || status === 'streaming';
  const busy = generating || resetting;

  useEffect(() => {
    const cleanup = () => {
      // Page unload cleanup is best effort; the server also expires the session.
      void fetch(`/api/chats/${chatId}`, { method: 'DELETE', keepalive: true }).catch(() => {});
    };
    window.addEventListener('pagehide', cleanup);
    return () => { window.removeEventListener('pagehide', cleanup); cleanup(); };
  }, [chatId]);

  useEffect(() => {
    if (transcript.current && stickToBottom.current) {
      transcript.current.scrollTop = transcript.current.scrollHeight;
    }
  }, [messages, status]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    stickToBottom.current = true;
    clearError();
    setResetError('');
    setInput('');
    void sendMessage({ text });
  }

  async function clearChat() {
    if (busy) return;
    setResetting(true);
    setResetError('');
    try {
      const response = await fetch(`/api/chats/${chatId}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Reset failed');
      setMessages([]);
      clearError();
      setInput('');
      setChatId(crypto.randomUUID());
    } catch {
      setResetError('暫時無法清除對話，請稍後再試。');
    } finally {
      setResetting(false);
      composer.current?.focus();
    }
  }

  return (
    <main className="chat-shell">
      <header className="chat-header">
        <div>
          <p className="eyebrow">LET’S TALK</p>
          <h1>對話助理<span aria-hidden="true">.</span></h1>
        </div>
        <button className="quiet-button" type="button" onClick={() => { void clearChat(); }} disabled={busy || messages.length === 0}>
          {resetting ? '清除中…' : '清除對話'}
        </button>
      </header>

      <div className="chat-panel">
        <div
          className="transcript" ref={transcript} role="log" aria-label="對話內容" aria-live="polite" aria-busy={busy}
          onScroll={event => {
            const element = event.currentTarget;
            stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          }}
        >
          {messages.length === 0 && (
            <div className="empty-state">
              <div className="empty-mark" aria-hidden="true">✳</div>
              <h2>有什麼想聊的？</h2>
              <p>從一個問題開始。<br />試試「台北現在幾點？」或「幫我整理一個概念」。</p>
            </div>
          )}
          {messages.map(message => (
            <article key={message.id} className={`message message-${message.role}`} aria-label={message.role === 'user' ? '你' : '助理'}>
              <p className="message-label">{message.role === 'user' ? '你' : '助理'}</p>
              <div className="message-content">
                {message.parts.map((part, index) => {
                  if (part.type === 'text') return <div className="message-text" key={index}>{part.text}</div>;
                  if (isToolUIPart(part)) {
                    const failed = part.state === 'output-error' || part.state === 'output-denied';
                    const download = getToolName(part) === 'publishFile' && part.state === 'output-available' ? getDownload(part.output, chatId) : undefined;
                    return (
                      <div key={index}>
                        <div className={`tool-status${failed ? ' tool-error' : ''}`}>
                          <span aria-hidden="true">↳</span> {toolLabels[getToolName(part)] ?? '執行工具'}
                          <span>{part.state === 'output-available' ? '完成' : failed ? '失敗' : '處理中…'}</span>
                        </div>
                        {download && <a className="download-link" href={download.url} download={download.name}>下載 {download.name} <span aria-hidden="true">↓</span></a>}
                      </div>
                    );
                  }
                  return null;
                })}
              </div>
            </article>
          ))}
          {generating && <p className="working" role="status">{status === 'submitted' ? '正在思考…' : '正在回覆…'}</p>}
        </div>

        {(error || resetError) && (
          <div className="error-banner" role="alert">
            <span>{resetError || '回覆失敗，請重試；若對話過長，請清除後重新開始。'}</span>
            {error && !resetError && <button className="quiet-button" type="button" onClick={() => { void regenerate(); }} disabled={busy}>重試</button>}
          </div>
        )}

        <form className="composer" onSubmit={submit}>
          <label className="sr-only" htmlFor="message">輸入訊息</label>
          <textarea
            id="message" ref={composer} value={input} rows={2} maxLength={16_000}
            placeholder="輸入你的問題…" disabled={busy}
            onChange={event => setInput(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="composer-actions">
            <span className="keyboard-hint">Enter 送出 · Shift + Enter 換行</span>
            {generating ? (
              <button className="send-button" type="button" onClick={() => { void stop(); }}>停止回覆</button>
            ) : (
              <button className="send-button" type="submit" disabled={busy || !input.trim()}>送出 <span aria-hidden="true">↑</span></button>
            )}
          </div>
        </form>
      </div>
      <p className="page-note">對話只保留在此頁；產出檔案請於 10 分鐘內下載，清除對話後即失效。</p>
    </main>
  );
}
