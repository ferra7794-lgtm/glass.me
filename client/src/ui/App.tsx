import React, { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

type User = { id: string; email: string; emailVerified: number; username: string | null; displayName: string | null; avatar: string | null; bio: string | null; createdAt: string; updatedAt: string };
type Message = { id: string; chatId: string; senderId: string; text: string; createdAt: string; updatedAt: string };
type Session = { id: string; device: string; ip: string; createdAt: string; lastSeenAt: string; current: boolean };
type Favorite = { id: string; text: string; createdAt: string; updatedAt: string };

const api = async (url: string, init?: RequestInit) => {
  const res = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) }, ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
};

const themeKey = 'gm-theme';

export function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem(themeKey) as any) || 'dark');
  const [me, setMe] = useState<User | null>(null);
  const [email, setEmail] = useState('');
  const [step, setStep] = useState<'register' | 'profile' | 'messenger' | 'account' | 'favorites'>('register');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<User[]>([]);
  const [chats, setChats] = useState<any[]>([]);
  const [currentChat, setCurrentChat] = useState<{ chatId: string; other: User | null; messages: Message[] }>({ chatId: '', other: null, messages: [] });
  const [message, setMessage] = useState('');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [favoriteDraft, setFavoriteDraft] = useState('');
  const socketRef = useRef<Socket | null>(null);
  const isAuthed = !!me;
  const [viewedProfile, setViewedProfile] = useState<User | null>(null);
  const [viewedProfileError, setViewedProfileError] = useState('');

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem(themeKey, theme); }, [theme]);
  useEffect(() => { api('/api/auth/me').then(r => { setMe(r.user); setStep(r.user?.username ? 'messenger' : 'profile'); }).catch(() => null); }, []);
  useEffect(() => { if (me && step === 'messenger') api('/api/chats').then(r => setChats(r.chats)).catch(() => setChats([])); }, [me, step]);
  useEffect(() => { if (me && step === 'account') api('/api/auth/sessions').then(r => setSessions(r.sessions)).catch(() => setSessions([])); }, [me, step]);
  useEffect(() => { if (me && step === 'favorites') api('/api/favorites').then(r => setFavorites(r.items)).catch(() => setFavorites([])); }, [me, step]);
  useEffect(() => {
    if (!me || step !== 'messenger' || !search) { setResults([]); return; }
    const t = setTimeout(() => api('/api/users/search?q=' + encodeURIComponent(search)).then(r => setResults(r.users)).catch(() => setResults([])), 250);
    return () => clearTimeout(t);
  }, [search, me, step]);
  useEffect(() => {
    if (!me) return;
    const socket = io({ withCredentials: true });
    socketRef.current = socket;
    socket.on('message:new', (msg: Message) => setCurrentChat(prev => prev.chatId === msg.chatId ? { ...prev, messages: [...prev.messages, msg] } : prev));
    return () => { socket.disconnect(); };
  }, [me]);

  const openChat = async (username: string) => {
    const data = await api('/api/chats/open', { method: 'POST', body: JSON.stringify({ username }) });
    setCurrentChat(data);
    socketRef.current?.emit('chat:join', data.chatId);
    setStep('messenger');
    setChats(prev => [{ id: data.chatId, createdAt: new Date().toISOString(), otherName: data.other?.displayName || data.other?.username, otherUsername: data.other?.username, lastMessage: data.messages.at(-1)?.text || '', lastAt: data.messages.at(-1)?.createdAt || new Date().toISOString() }, ...prev.filter((c: any) => c.id !== data.chatId)]);
  };

  const submitEmail = async () => {
    if (!email.trim()) return;
    try {
      setStatus('Входим...');
      const r = await api('/api/auth/email-login', { method: 'POST', body: JSON.stringify({ email }) });
      setMe(r.user);
      setStep(r.user?.username ? 'messenger' : 'profile');
      setStatus('');
    } catch (error: any) {
      setStatus(error?.message || 'Ошибка');
    }
  };

  const saveProfile = async (fd: FormData) => {
    try {
      const res = await fetch('/api/profile', { method: 'PUT', credentials: 'include', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка сохранения профиля');
      setMe(data.user);
      setStep('messenger');
    } catch (error: any) {
      setStatus(error?.message || 'Ошибка сохранения профиля');
    }
  };

  const logout = async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* noop */ }
    setMe(null);
    setSessions([]);
    setFavorites([]);
    setChats([]);
    setCurrentChat({ chatId: '', other: null, messages: [] });
    setStep('register');
  };

  const revokeSession = async (id: string) => {
    try {
      await api('/api/auth/sessions/' + id + '/revoke', { method: 'POST' });
      setSessions(prev => prev.filter(s => s.id !== id));
    } catch (error: any) {
      setStatus(error?.message || 'Ошибка');
    }
  };

  const revokeOtherSessions = async () => {
    try {
      await api('/api/auth/sessions/revoke-others', { method: 'POST' });
      setSessions(prev => prev.filter(s => s.current));
    } catch (error: any) {
      setStatus(error?.message || 'Ошибка');
    }
  };

  const addFavorite = async () => {
    if (!favoriteDraft.trim()) return;
    try {
      const r = await api('/api/favorites', { method: 'POST', body: JSON.stringify({ text: favoriteDraft.trim() }) });
      setFavorites(prev => [r.item, ...prev]);
      setFavoriteDraft('');
    } catch (error: any) {
      setStatus(error?.message || 'Ошибка');
    }
  };

  const removeFavorite = async (id: string) => {
    try {
      await api('/api/favorites/' + id, { method: 'DELETE' });
      setFavorites(prev => prev.filter(f => f.id !== id));
    } catch (error: any) {
      setStatus(error?.message || 'Ошибка');
    }
  };

  const openProfileByUsername = async (username: string) => {
    setViewedProfileError('');
    try {
      const r = await api('/api/users/' + encodeURIComponent(username.replace(/^@/, '')));
      setViewedProfile(r.user);
    } catch (error: any) {
      setViewedProfile(null);
      setViewedProfileError(error?.message || 'Пользователь не найден');
    }
  };

  const sendMessage = async () => {
    if (!currentChat.chatId || !message.trim()) return;
    try {
      await api('/api/chats/' + currentChat.chatId + '/messages', { method: 'POST', body: JSON.stringify({ text: message }) });
      setMessage('');
    } catch (error: any) {
      setStatus(error?.message || 'Ошибка отправки');
    }
  };

  return (
    <div className="app-shell">
      <div className="bg-orb orb-a" /><div className="bg-orb orb-b" />
      <header className="topbar glass">
        <div className="brand"><div className="brand-mark">GM</div><div><h1>Glass Messenger</h1><p>Приватный мессенджер в реальном времени</p></div></div>
        <button className="ghost" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? 'Светлая' : 'Тёмная'} тема</button>
      </header>
      <main className="layout">
        {step === 'messenger' && (
          <section className="sidebar glass">
            <div className="section-title">Поиск</div>
            <input className="input" placeholder="Поиск по @username или имени" value={search} onChange={e => setSearch(e.target.value)} />
            <div className="section-title">Чаты</div>
            <div className="search-list">
              {chats.map((chat: any) => (
                <button key={chat.id} className="search-item" onClick={async () => {
                  const data = await api('/api/chats/' + chat.id + '/messages');
                  setCurrentChat({ chatId: chat.id, other: chat.otherUsername ? { id: chat.otherUsername, email: '', emailVerified: 1, username: chat.otherUsername, displayName: chat.otherName, avatar: null, bio: null, createdAt: '', updatedAt: '' } : null, messages: data.messages });
                  socketRef.current?.emit('chat:join', chat.id);
                }}>
                  <span className="avatar">•</span>
                  <span><strong>{chat.otherName || chat.otherUsername || 'Личный чат'}</strong><small>{chat.lastMessage || 'Нет сообщений'}</small></span>
                </button>
              ))}
            </div>
            <div className="search-list">
              {results.map(user => <button key={user.id} className="search-item" onClick={() => openChat(user.username || '')}><span className="avatar">{user.avatar ? <img src={user.avatar} alt="" /> : (user.displayName?.[0] || user.email[0]).toUpperCase()}</span><span><strong>{user.displayName || user.username || user.email}</strong><small>@{user.username || 'без-username'}</small></span></button>)}
            </div>
          </section>
        )}
        <section className="workspace glass">
          {step === 'register' && <AuthCard email={email} onChange={setEmail} onSubmit={submitEmail} hint={status} />}
          {step === 'profile' && <ProfileCard me={me} onSubmit={saveProfile} onSkip={() => setStep('messenger')} status={status} />}
          {step === 'messenger' && <Messenger me={me} currentChat={currentChat} message={message} setMessage={setMessage} onSend={sendMessage} />}
          {step === 'account' && (
            <AccountCard
              me={me}
              sessions={sessions}
              onLogout={logout}
              onRevoke={revokeSession}
              onRevokeOthers={revokeOtherSessions}
              onEditProfile={() => setStep('profile')}
              status={status}
            />
          )}
          {step === 'favorites' && (
            <FavoritesCard
              favorites={favorites}
              draft={favoriteDraft}
              setDraft={setFavoriteDraft}
              onAdd={addFavorite}
              onRemove={removeFavorite}
              onOpenProfile={openProfileByUsername}
            />
          )}
        </section>
      </main>
      {isAuthed && (
        <footer className="bottom-nav glass">
          <button className={'bottom-tab' + (step === 'account' ? ' active' : '')} onClick={() => setStep('account')}>Профиль</button>
          <button className={'bottom-tab' + (step === 'messenger' ? ' active' : '')} onClick={() => setStep('messenger')}>Чаты</button>
          <button className={'bottom-tab' + (step === 'favorites' ? ' active' : '')} onClick={() => setStep('favorites')}>Избранное</button>
        </footer>
      )}
      {(viewedProfile || viewedProfileError) && (
        <div className="modal-overlay" onClick={() => { setViewedProfile(null); setViewedProfileError(''); }}>
          <div className="modal-card glass" onClick={e => e.stopPropagation()}>
            {viewedProfile ? (
              <>
                <div className="avatar large">{viewedProfile.avatar ? <img src={viewedProfile.avatar} alt="" /> : (viewedProfile.displayName?.[0] || viewedProfile.username?.[0] || '?').toUpperCase()}</div>
                <div className="card-title">{viewedProfile.displayName || viewedProfile.username}</div>
                <p>@{viewedProfile.username}</p>
                {viewedProfile.bio && <p>{viewedProfile.bio}</p>}
                <button className="primary" onClick={() => { setViewedProfile(null); openChat(viewedProfile.username || ''); }}>Написать сообщение</button>
                <button className="ghost" onClick={() => setViewedProfile(null)}>Закрыть</button>
              </>
            ) : (
              <>
                <div className="card-title">Пользователь не найден</div>
                <p>{viewedProfileError}</p>
                <button className="ghost" onClick={() => setViewedProfileError('')}>Закрыть</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function LinkedText({ text }: { text: string }) {
  const parts = text.split(/(@[a-zA-Z0-9_]{3,24})/g);
  return (
    <>
      {parts.map((part, i) => {
        if (/^@[a-zA-Z0-9_]{3,24}$/.test(part)) {
          return (
            <a
              key={i}
              href="#"
              className="mention-link"
              onClick={(e) => {
                e.preventDefault();
                const evt = new CustomEvent('open-profile', { detail: part.slice(1) });
                window.dispatchEvent(evt);
              }}
            >
              {part}
            </a>
          );
        }
        return <React.Fragment key={i}>{part}</React.Fragment>;
      })}
    </>
  );
}

function AccountCard({ me, sessions, onLogout, onRevoke, onRevokeOthers, onEditProfile, status }: any) {
  return (
    <div className="center-card account-card">
      <div className="avatar large">{me?.avatar ? <img src={me.avatar} alt="" /> : (me?.displayName?.[0] || me?.email?.[0] || '?').toUpperCase()}</div>
      <div className="card-title">{me?.displayName || me?.username || 'Профиль'}</div>
      <p>@{me?.username || 'username не задан'} · {me?.email}</p>
      {me?.bio && <p>{me.bio}</p>}
      <button className="ghost" onClick={onEditProfile}>Редактировать профиль</button>

      <div className="section-title">Активные сеансы</div>
      <div className="search-list sessions-list">
        {sessions.length === 0 && <p>Нет активных сеансов</p>}
        {sessions.map((s: Session) => (
          <div key={s.id} className="search-item session-item">
            <span className="avatar">{s.current ? '●' : '○'}</span>
            <span className="session-info">
              <strong>{s.device}{s.current ? ' (это устройство)' : ''}</strong>
              <small>{s.ip || ''} · {new Date(s.lastSeenAt).toLocaleString()}</small>
            </span>
            {!s.current && <button className="ghost small" onClick={() => onRevoke(s.id)}>Завершить</button>}
          </div>
        ))}
      </div>
      {sessions.some((s: Session) => !s.current) && <button className="ghost" onClick={onRevokeOthers}>Завершить остальные сеансы</button>}

      <button className="primary" onClick={onLogout}>Выйти из аккаунта</button>
      {status && <div className="hint">{status}</div>}
    </div>
  );
}

function FavoritesCard({ favorites, draft, setDraft, onAdd, onRemove, onOpenProfile }: any) {
  useEffect(() => {
    const handler = (e: any) => onOpenProfile(e.detail);
    window.addEventListener('open-profile', handler);
    return () => window.removeEventListener('open-profile', handler);
  }, [onOpenProfile]);
  return (
    <div className="center-card favorites-card">
      <div className="card-title">Избранное</div>
      <p>Заметки, ссылки и мысли. Упоминания вида @username превращаются в ссылку на профиль.</p>
      <textarea className="input textarea" placeholder="Например: @alex — договориться о встрече" value={draft} onChange={e => setDraft(e.target.value)} />
      <button className="primary" onClick={onAdd}>Добавить в избранное</button>
      <div className="search-list favorites-list">
        {favorites.length === 0 && <p>Пока пусто</p>}
        {favorites.map((f: Favorite) => (
          <div key={f.id} className="favorite-item">
            <p><LinkedText text={f.text} /></p>
            <button className="ghost small" onClick={() => onRemove(f.id)}>Удалить</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function AuthCard({ email, onChange, onSubmit, hint }: any) {
  return (
    <div className="center-card">
      <div className="card-title">Войти или создать аккаунт</div>
      <p>Введите вашу почту. Она будет использоваться для входа в аккаунт в будущем.</p>
      <input className="input large" placeholder="Введите email" value={email} type="email" onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onSubmit()} />
      <button className="primary" onClick={onSubmit}>ПРОДОЛЖИТЬ</button>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

function ProfileCard({ me, onSubmit, onSkip, status }: any) {
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form ref={formRef} className="profile-grid" onSubmit={(e) => { e.preventDefault(); onSubmit(new FormData(formRef.current!)); }}>
      <div className="card-title">Создайте профиль</div>
      <p>Заполните данные чтобы начать общение.</p>
      <label className="upload"><input name="avatar" type="file" accept="image/*" /><span>Аватар</span></label>
      <input className="input" name="displayName" placeholder="Имя" defaultValue={me?.displayName || ''} />
      <input className="input" name="username" placeholder="@username" defaultValue={me?.username || ''} />
      <textarea className="input textarea" name="bio" placeholder="О себе" defaultValue={me?.bio || ''} />
      <button className="primary" type="submit">СОХРАНИТЬ</button>
      <button className="ghost" type="button" onClick={onSkip}>Пропустить</button>
      {status && <div className="hint">{status}</div>}
    </form>
  );
}

function Messenger({ me, currentChat, message, setMessage, onSend }: any) {
  return (
    <div className="messenger">
      <div className="chat-header">
        <div className="avatar large">{currentChat.other?.avatar ? <img src={currentChat.other.avatar} alt="" /> : (currentChat.other?.displayName?.[0] || '?')}</div>
        <div><strong>{currentChat.other?.displayName || 'Выберите чат'}</strong><small>@{currentChat.other?.username || 'найдите пользователя в поиске'}</small></div>
      </div>
      <div className="messages">{currentChat.messages.map((m: Message) => <div key={m.id} className={'bubble' + (m.senderId === me?.id ? ' mine' : '')}>{m.text}</div>)}</div>
      <div className="composer">
        <textarea className="input textarea" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Написать сообщение. Enter — отправить, Shift+Enter — новая строка." onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } }} />
        <button className="primary" onClick={onSend}>Отправить</button>
      </div>
    </div>
  );
}