import React, { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

type User = { id: string; email: string; emailVerified: number; username: string | null; displayName: string | null; avatar: string | null; bio: string | null; hasPassword?: boolean; createdAt: string; updatedAt: string };
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
  const [password, setPassword] = useState('');
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

  const [setPasswordDraft, setSetPasswordDraft] = useState('');
  const [setPasswordConfirm, setSetPasswordConfirm] = useState('');
  const [setPasswordStatus, setSetPasswordStatus] = useState('');

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
    setChats(prev => [{ id: data.chatId, createdAt: new Date().toISOString(), otherName: data.other?.displayName || data.other?.username, otherUsername: data.other?.username, otherAvatar: data.other?.avatar || null, lastMessage: data.messages.at(-1)?.text || '', lastAt: data.messages.at(-1)?.createdAt || new Date().toISOString() }, ...prev.filter((c: any) => c.id !== data.chatId)]);
  };

  const submitEmail = async () => {
    if (!email.trim() || password.length < 8) return;
    try {
      setStatus('Входим...');
      const r = await api('/api/auth/email-login', { method: 'POST', body: JSON.stringify({ email, password }) });
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

  const setAccountPassword = async () => {
    setSetPasswordStatus('');
    if (setPasswordDraft.length < 8) { setSetPasswordStatus('Минимум 8 символов'); return; }
    if (setPasswordDraft !== setPasswordConfirm) { setSetPasswordStatus('Пароли не совпадают'); return; }
    try {
      const r = await api('/api/auth/set-password', { method: 'POST', body: JSON.stringify({ password: setPasswordDraft }) });
      setMe(r.user);
      setSetPasswordDraft('');
      setSetPasswordConfirm('');
      setSetPasswordStatus('');
    } catch (error: any) {
      setSetPasswordStatus(error?.message || 'Ошибка');
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

  const closeChat = () => setCurrentChat({ chatId: '', other: null, messages: [] });

  const sendMessage = async () => {
    if (!currentChat.chatId || !message.trim()) return;
    try {
      await api('/api/chats/' + currentChat.chatId + '/messages', { method: 'POST', body: JSON.stringify({ text: message }) });
      setMessage('');
    } catch (error: any) {
      setStatus(error?.message || 'Ошибка отправки');
    }
  };

  const chatOpen = step === 'messenger' && !!currentChat.chatId;
  const sidebarVisible = step === 'messenger' && !chatOpen;

  return (
    <div className={'app-shell' + (isAuthed ? ' has-nav' : '')}>
      <div className="bg-orb orb-a" /><div className="bg-orb orb-b" />
      <header className="topbar glass">
        <div className="brand"><div className="brand-mark">GM</div><div><h1>Glass Messenger</h1><p>Приватный мессенджер в реальном времени</p></div></div>
        <button className="ghost" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? 'Светлая' : 'Тёмная'} тема</button>
      </header>
      <main className={'layout' + (!sidebarVisible ? ' chat-open' : '')}>
        {sidebarVisible && (
          <section className="sidebar glass">
            <div className="section-title">Поиск</div>
            <input className="input" placeholder="Поиск по @username или имени" value={search} onChange={e => setSearch(e.target.value)} />
            <div className="section-title">Чаты</div>
            <div className="search-list">
              {chats.map((chat: any) => (
                <button key={chat.id} className="search-item" onClick={async () => {
                  const data = await api('/api/chats/' + chat.id + '/messages');
                  setCurrentChat({ chatId: chat.id, other: chat.otherUsername ? { id: chat.otherUsername, email: '', emailVerified: 1, username: chat.otherUsername, displayName: chat.otherName, avatar: chat.otherAvatar || null, bio: null, createdAt: '', updatedAt: '' } : null, messages: data.messages });
                  socketRef.current?.emit('chat:join', chat.id);
                }}>
                  <span className="avatar">{chat.otherAvatar ? <img src={chat.otherAvatar} alt="" /> : (chat.otherName?.[0] || chat.otherUsername?.[0] || '?').toUpperCase()}</span>
                  <span><strong>{chat.otherName || chat.otherUsername || 'Личный чат'}</strong><small>{chat.lastMessage || 'Нет сообщений'}</small></span>
                </button>
              ))}
            </div>
            <div className="search-list">
              {results.map(user => <button key={user.id} className="search-item" onClick={() => openChat(user.username || '')}><span className="avatar">{user.avatar ? <img src={user.avatar} alt="" /> : (user.displayName?.[0] || user.email[0]).toUpperCase()}</span><span><strong>{user.displayName || user.username || user.email}</strong><small>@{user.username || 'без-username'}</small></span></button>)}
            </div>
          </section>
        )}
        <section className={'workspace glass' + (chatOpen || step === 'favorites' ? ' workspace-full' : '')}>
          {step === 'register' && <AuthCard email={email} onChangeEmail={setEmail} password={password} onChangePassword={setPassword} onSubmit={submitEmail} hint={status} />}
          {step === 'profile' && <ProfileCard me={me} onSubmit={saveProfile} onSkip={() => setStep('messenger')} status={status} />}
          {step === 'messenger' && <Messenger me={me} currentChat={currentChat} message={message} setMessage={setMessage} onSend={sendMessage} onBack={closeChat} chatOpen={chatOpen} />}
          {step === 'account' && (
            <AccountCard
              me={me}
              sessions={sessions}
              onLogout={logout}
              onRevoke={revokeSession}
              onRevokeOthers={revokeOtherSessions}
              onEditProfile={() => setStep('profile')}
              status={status}
              setPasswordDraft={setPasswordDraft}
              setSetPasswordDraft={setSetPasswordDraft}
              setPasswordConfirm={setPasswordConfirm}
              setSetPasswordConfirm={setSetPasswordConfirm}
              onSetPassword={setAccountPassword}
              setPasswordStatus={setPasswordStatus}
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
          <button className={'bottom-tab' + (step === 'messenger' ? ' active' : '')} onClick={() => { closeChat(); setStep('messenger'); }}>Чаты</button>
          <button className={'bottom-tab' + (step === 'favorites' ? ' active' : '')} onClick={() => setStep('favorites')}>Избранное</button>
        </footer>
      )}
      {(viewedProfile || viewedProfileError) && (
        <div className="modal-overlay" onClick={() => { setViewedProfile(null); setViewedProfileError(''); }}>
          <div className="modal-card glass" onClick={e => e.stopPropagation()}>
            {viewedProfile ? (
              <>
                <div className="avatar xlarge">{viewedProfile.avatar ? <img src={viewedProfile.avatar} alt="" /> : (viewedProfile.displayName?.[0] || viewedProfile.username?.[0] || '?').toUpperCase()}</div>
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

function AccountCard({ me, sessions, onLogout, onRevoke, onRevokeOthers, onEditProfile, status, setPasswordDraft, setSetPasswordDraft, setPasswordConfirm, setSetPasswordConfirm, onSetPassword, setPasswordStatus }: any) {
  return (
    <div className="center-card account-card">
      <div className="avatar xlarge">{me?.avatar ? <img src={me.avatar} alt="" /> : (me?.displayName?.[0] || me?.email?.[0] || '?').toUpperCase()}</div>
      <div className="card-title">{me?.displayName || me?.username || 'Профиль'}</div>
      <p>@{me?.username || 'username не задан'} · {me?.email}</p>
      {me?.bio && <p>{me.bio}</p>}
      <button className="ghost" onClick={onEditProfile}>Редактировать профиль</button>

      {!me?.hasPassword && (
        <div className="warn-box">
          <div className="card-title">Привяжите пароль для входа</div>
          <p>У вашего аккаунта пока нет пароля — вы вошли только по email. Задайте пароль, чтобы обезопасить аккаунт. Важно: после установки изменить пароль будет нельзя.</p>
          <input className="input" type="password" placeholder="Новый пароль (мин. 8 символов)" value={setPasswordDraft} onChange={e => setSetPasswordDraft(e.target.value)} />
          <input className="input" type="password" placeholder="Повторите пароль" value={setPasswordConfirm} onChange={e => setSetPasswordConfirm(e.target.value)} />
          <button className="primary" onClick={onSetPassword}>Сохранить пароль</button>
          {setPasswordStatus && <div className="hint">{setPasswordStatus}</div>}
        </div>
      )}

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
    <div className="messenger favorites-messenger">
      <div className="chat-header">
        <div className="avatar large">★</div>
        <div><strong>Избранное</strong><small>Заметки и ссылки. @username превращается в ссылку на профиль</small></div>
      </div>
      <div className="messages favorites-messages">
        {favorites.length === 0 && <p>Пока пусто. Добавьте первую заметку ниже.</p>}
        {favorites.map((f: Favorite) => (
          <div key={f.id} className="bubble favorite-bubble">
            <p><LinkedText text={f.text} /></p>
            <button className="ghost small" onClick={() => onRemove(f.id)}>Удалить</button>
          </div>
        ))}
      </div>
      <div className="composer">
        <textarea className="input textarea" value={draft} onChange={e => setDraft(e.target.value)} placeholder="Например: @alex — договориться о встрече. Enter — сохранить, Shift+Enter — новая строка." onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onAdd(); } }} />
        <button className="primary" onClick={onAdd}>Добавить</button>
      </div>
    </div>
  );
}

function AuthCard({ email, onChangeEmail, password, onChangePassword, onSubmit, hint }: any) {
  return (
    <div className="center-card">
      <div className="card-title">Войти или создать аккаунт</div>
      <p>Введите email и пароль. Если аккаунта ещё нет — он будет создан автоматически.</p>
      <input className="input large" placeholder="Введите email" value={email} type="email" onChange={(e) => onChangeEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onSubmit()} />
      <input className="input large" placeholder="Пароль (мин. 8 символов)" value={password} type="password" onChange={(e) => onChangePassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onSubmit()} />
      <button className="primary" onClick={onSubmit}>ПРОДОЛЖИТЬ</button>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

function ProfileCard({ me, onSubmit, onSkip, status }: any) {
  const formRef = useRef<HTMLFormElement>(null);
  const [username, setUsername] = useState(me?.username || '');
  const [usernameStatus, setUsernameStatus] = useState<{ available: boolean | null; error: string | null }>({ available: null, error: null });
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const val = username.replace(/^@/, '').trim();
    if (!val || val === (me?.username || '')) { setUsernameStatus({ available: null, error: null }); return; }
    setChecking(true);
    const t = setTimeout(async () => {
      try {
        const r = await api('/api/users/check-username?username=' + encodeURIComponent(val));
        setUsernameStatus({ available: r.available, error: r.error });
      } catch { setUsernameStatus({ available: null, error: null }); }
      setChecking(false);
    }, 400);
    return () => clearTimeout(t);
  }, [username]);

  const usernameColor = checking ? '#888' : usernameStatus.available === true ? '#d4ff00' : usernameStatus.available === false ? '#ff3c00' : 'transparent';
  const usernameMsg = checking ? 'Проверяем...' : usernameStatus.available === true ? '✓ Свободен' : usernameStatus.error || '';

  return (
    <form ref={formRef} className="profile-grid" onSubmit={(e) => { e.preventDefault(); onSubmit(new FormData(formRef.current!)); }}>
      <div className="card-title">Создайте профиль</div>
      <p>Заполните данные чтобы начать общение.</p>
      <label className="upload"><input name="avatar" type="file" accept="image/*" /><span>Аватар</span></label>
      <input className="input" name="displayName" placeholder="Имя" defaultValue={me?.displayName || ''} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <input
          className="input"
          name="username"
          placeholder="@username"
          value={username}
          onChange={e => setUsername(e.target.value)}
          style={{ borderColor: usernameStatus.available === true ? '#d4ff00' : usernameStatus.available === false ? '#ff3c00' : undefined }}
        />
        {usernameMsg && <div style={{ fontSize: 11, color: usernameColor, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{usernameMsg}</div>}
      </div>
      <textarea className="input textarea" name="bio" placeholder="О себе" defaultValue={me?.bio || ''} />
      <button className="primary" type="submit">СОХРАНИТЬ</button>
      <button className="ghost" type="button" onClick={onSkip}>Пропустить</button>
      {status && <div className="hint">{status}</div>}
    </form>
  );
}

function Messenger({ me, currentChat, message, setMessage, onSend, onBack, chatOpen }: any) {
  return (
    <div className="messenger">
      {chatOpen && (
        <div className="chat-header">
          <button className="ghost back-btn" onClick={onBack}>← Назад</button>
          <div className="avatar large">{currentChat.other?.avatar ? <img src={currentChat.other.avatar} alt="" /> : (currentChat.other?.displayName?.[0] || '?')}</div>
          <div><strong>{currentChat.other?.displayName || currentChat.other?.username || '—'}</strong><small>@{currentChat.other?.username || ''}</small></div>
        </div>
      )}
      <div className="messages">{currentChat.messages.map((m: Message) => <div key={m.id} className={'bubble' + (m.senderId === me?.id ? ' mine' : '')}>{m.text}</div>)}</div>
      {chatOpen && (
        <div className="composer">
          <textarea className="input textarea" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Написать сообщение. Enter — отправить, Shift+Enter — новая строка." onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } }} />
          <button className="primary" onClick={onSend}>Отправить</button>
        </div>
      )}
    </div>
  );
}