# Glass Messenger

Full-stack messenger with:

- email registration and verification via Gmail SMTP;
- profile creation and editing;
- user search by `@username` or `username`;
- private chats and realtime messaging with Socket.IO;
- dark glassmorphism UI with light theme toggle;
- SQLite-backed persistence.

## Setup

1. Copy `.env.example` to `.env` and fill the Gmail SMTP fields.
2. Install dependencies:

```bash
npm install
```

3. Start dev servers:

```bash
npm run dev
```

4. Open `http://localhost:5173`.

## Notes

- Email verification codes are stored only as hashes.
- The code expires after the configured TTL and is rate limited.
- Frontend never talks directly to the database.

